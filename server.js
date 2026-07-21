require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ethers } = require('ethers');
const db = require('./db');
const { getTaskCreator } = require('./taskmarket');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const NOTE_PRICE = process.env.NOTE_PRICE || '1000'; // 0.001 USDC
const NETWORK = process.env.NETWORK || 'eip155:8453'; // Base mainnet (was eip155:84532 Sepolia)
const FACILITATOR = process.env.FACILITATOR_URL || 'https://facilitator.daydreams.systems';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Signer key can come from an env var OR a Render Secret File (/etc/secrets/FACILITATOR_SIGNER_KEY).
// Normalize: strip an optional "NAME=" prefix, surrounding quotes, whitespace; ensure 0x prefix.
function loadSignerKey() {
  let k = process.env.FACILITATOR_SIGNER_KEY;
  if (!k) {
    try { k = require('fs').readFileSync('/etc/secrets/FACILITATOR_SIGNER_KEY', 'utf8'); } catch (_) {}
  }
  if (!k) return undefined;
  k = k.trim().replace(/^FACILITATOR_SIGNER_KEY\s*=\s*/, '').replace(/^["']|["']$/g, '').trim();
  if (k && !k.startsWith('0x')) k = '0x' + k;
  return k || undefined;
}
const SIGNER_KEY = loadSignerKey();

// Facilitator: either self-host settlement (we verify + submit EIP-3009 transferWithAuthorization
// on-chain ourselves, paying gas from SIGNER_KEY's wallet — no hosted token/KYC), or use a hosted
// facilitator over HTTP. Self mode kicks in when a signer key is present.
let facilitatorClient;
if (SIGNER_KEY) {
  try {
    const { createWalletClient, http, publicActions } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const { base, baseSepolia } = require('viem/chains');
    const { x402Facilitator } = require('@x402/core/facilitator');
    const { registerExactEvmScheme } = require('@x402/evm/exact/facilitator');
    const { toFacilitatorEvmSigner } = require('@x402/evm');

    const chain = NETWORK === 'eip155:84532' ? baseSepolia : base;
    const account = privateKeyToAccount(SIGNER_KEY);
    const client = createWalletClient({ account, chain, transport: http(BASE_RPC) }).extend(publicActions);
    const selfFac = new x402Facilitator();
    registerExactEvmScheme(selfFac, { signer: toFacilitatorEvmSigner(client), networks: NETWORK });
    facilitatorClient = selfFac;
    console.log(`[facilitator] SELF-FACILITATING on ${NETWORK} — gas wallet ${account.address}, RPC ${BASE_RPC}`);
  } catch (e) {
    console.error('[facilitator] self-facilitation setup FAILED (bad key?), falling back to hosted:', e.message);
  }
}
if (!facilitatorClient) {
  facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
  console.log(`[facilitator] hosted: ${FACILITATOR}`);
}

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());


const NOTE_TYPES = ['general', 'progress', 'clarification', 'suggestion', 'question'];

// POST /tasks/:taskId/notes
app.post('/tasks/:taskId/notes', async (req, res) => {
  const { taskId } = req.params;
  const authorAddress = req.headers['x-wallet-address'];
  const { content, noteType = 'general' } = req.body;

  if (!authorAddress) return res.status(400).json({ error: 'x-wallet-address header required' });
  if (!content || content.trim().length === 0) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'content exceeds 2000 chars' });
  if (!NOTE_TYPES.includes(noteType)) return res.status(400).json({ error: `noteType must be one of: ${NOTE_TYPES.join(', ')}` });

  const taskCreator = await getTaskCreator(taskId);

  // Everyone pays via x402 — no unauthenticated bypass
  const payTo = taskCreator || process.env.FALLBACK_WALLET;
  if (!payTo) return res.status(500).json({ error: 'Could not determine payment recipient' });

  console.log(`[POST] taskId=${taskId} payTo=${payTo} network=${NETWORK}`);

  const middleware = paymentMiddleware(
    {
      [`POST /tasks/${taskId}/notes`]: {
        accepts: {
          scheme: 'exact',
          price: `$${(parseInt(NOTE_PRICE) / 1e6).toFixed(6)}`,
          network: NETWORK,
          payTo,
        },
        description: `Note on task ${taskId.slice(0, 10)}...`,
      },
    },
    resourceServer
  );

  // Debug: log incoming payment header so we can see what's being verified
  const incomingPayment = req.headers['payment-signature'];
  if (incomingPayment) {
    try { console.log('[x402 incoming]', JSON.stringify(JSON.parse(Buffer.from(incomingPayment, 'base64').toString()))); }
    catch (e) { console.log('[x402 incoming] decode failed:', e.message); }
  }

  middleware(req, res, async () => {
    const noteId = uuidv4();
    await db.query(
      `INSERT INTO notes (note_id, task_id, author_address, content, note_type, payment_amount) VALUES ($1, $2, $3, $4, $5, $6)`,
      [noteId, taskId, authorAddress.toLowerCase(), content.trim(), noteType, parseInt(NOTE_PRICE)]
    );
    const { rows } = await db.query('SELECT * FROM notes WHERE note_id = $1', [noteId]);
    return res.status(201).json(buildNote(rows[0]));
  });
});

// POST /debug/verify — proxies payment payload to facilitator verify, returns raw result
app.post('/debug/verify', async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  try {
    const r = await fetch(`${FACILITATOR}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements })
    });
    const data = await r.json();
    res.json({ status: r.status, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /tasks/:taskId/notes
app.get('/tasks/:taskId/notes', async (req, res) => {
  const { taskId } = req.params;
  const { noteType, limit = 50, offset = 0 } = req.query;

  let query = 'SELECT * FROM notes WHERE task_id = $1';
  const params = [taskId];
  let idx = 2;

  if (noteType) { query += ` AND note_type = $${idx}`; params.push(noteType); idx++; }
  query += ` ORDER BY created_at ASC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(parseInt(limit), parseInt(offset));

  const { rows: notes } = await db.query(query, params);
  const { rows: [stats] } = await db.query(
    'SELECT COUNT(*) as total, COALESCE(SUM(payment_amount),0) as earned FROM notes WHERE task_id = $1',
    [taskId]
  );

  res.json({ taskId, notes: notes.map(buildNote), totalNotes: parseInt(stats.total), totalEngagementEarned: parseInt(stats.earned) });
});

// GET /tasks/:taskId/notes/stats
app.get('/tasks/:taskId/notes/stats', async (req, res) => {
  const { taskId } = req.params;
  const { rows: [stats] } = await db.query(
    'SELECT COUNT(*) as total, COALESCE(SUM(payment_amount),0) as earned, COUNT(DISTINCT author_address) as unique_contributors FROM notes WHERE task_id = $1',
    [taskId]
  );
  const byType = {};
  await Promise.all(NOTE_TYPES.map(async t => {
    const { rows: [r] } = await db.query('SELECT COUNT(*) as c FROM notes WHERE task_id = $1 AND note_type = $2', [taskId, t]);
    byType[t] = parseInt(r.c);
  }));
  res.json({ taskId, totalNotes: parseInt(stats.total), uniqueContributors: parseInt(stats.unique_contributors), totalPaymentsToCreator: parseInt(stats.earned), notesByType: byType });
});

function buildNote(row) {
  return {
    noteId: row.note_id,
    taskId: row.task_id,
    author: row.author_address,
    content: row.content,
    noteType: row.note_type,
    timestamp: row.created_at,
    paymentAmount: parseInt(row.payment_amount),
    isCreator: parseInt(row.payment_amount) === 0
  };
}

// ── Bulletin board (free acknowledgment, wallet-signature only) ──────────────

// POST /bulletin/:taskId/ack
// Body: { walletAddress, signature, message }
// The agent signs `message` with personal_sign (eth_sign prefix).
// Server verifies signature proves wallet ownership — no USDC required.
// One ack per wallet per task (idempotent — re-ack returns existing record).
app.post('/bulletin/:taskId/ack', async (req, res) => {
  const { taskId } = req.params;
  const { walletAddress, signature, message } = req.body;

  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
  if (!signature)    return res.status(400).json({ error: 'signature required' });
  if (!message)      return res.status(400).json({ error: 'message required' });

  // Verify the signature proves ownership of walletAddress
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (e) {
    return res.status(400).json({ error: 'invalid signature' });
  }

  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    return res.status(401).json({ error: 'signature does not match walletAddress' });
  }

  const ackId = uuidv4();
  const addr = walletAddress.toLowerCase();

  try {
    await db.query(
      `INSERT INTO bulletin_acks (ack_id, task_id, wallet_address, message, signature)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id, wallet_address) DO NOTHING`,
      [ackId, taskId, addr, message, signature]
    );
  } catch (e) {
    return res.status(500).json({ error: 'db error' });
  }

  const { rows } = await db.query(
    'SELECT * FROM bulletin_acks WHERE task_id = $1 AND wallet_address = $2',
    [taskId, addr]
  );

  const row = rows[0];
  res.status(201).json({
    ackId: row.ack_id,
    taskId: row.task_id,
    walletAddress: row.wallet_address,
    acknowledgedAt: row.acknowledged_at
  });
});

// GET /bulletin/:taskId/acks
// Returns all acknowledged wallet addresses for a task (for payout enumeration)
app.get('/bulletin/:taskId/acks', async (req, res) => {
  const { taskId } = req.params;
  const { rows } = await db.query(
    'SELECT ack_id, wallet_address, acknowledged_at FROM bulletin_acks WHERE task_id = $1 ORDER BY acknowledged_at ASC',
    [taskId]
  );
  res.json({
    taskId,
    count: rows.length,
    acks: rows.map(r => ({ ackId: r.ack_id, walletAddress: r.wallet_address, acknowledgedAt: r.acknowledged_at }))
  });
});

const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await Promise.race([
      resourceServer.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('x402 initialize timeout')), 10000))
    ]);
    console.log('x402 resource server initialized');
  } catch (err) {
    console.warn('x402 initialize warning (continuing):', err.message);
  }
  app.listen(PORT, () => console.log(`listening-heart running on port ${PORT}`));
})().catch(err => { console.error('Startup failed:', err); process.exit(1); });
