require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const db = require('./db');
const { getTaskCreator } = require('./taskmarket');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const NOTE_PRICE = process.env.NOTE_PRICE || '1000'; // 0.001 USDC
const FACILITATOR = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme());


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

  // Task creator posts free
  if (taskCreator && authorAddress.toLowerCase() === taskCreator.toLowerCase()) {
    const noteId = uuidv4();
    await db.query(
      `INSERT INTO notes (note_id, task_id, author_address, content, note_type, payment_amount) VALUES ($1, $2, $3, $4, $5, 0)`,
      [noteId, taskId, authorAddress.toLowerCase(), content.trim(), noteType]
    );
    const { rows } = await db.query('SELECT * FROM notes WHERE note_id = $1', [noteId]);
    return res.status(201).json(buildNote(rows[0]));
  }

  // Everyone else pays via x402
  const payTo = taskCreator || process.env.FALLBACK_WALLET;
  if (!payTo) return res.status(500).json({ error: 'Could not determine payment recipient' });

  const middleware = paymentMiddleware(
    {
      [`POST /tasks/${taskId}/notes`]: {
        accepts: {
          scheme: 'exact',
          price: `$${(parseInt(NOTE_PRICE) / 1e6).toFixed(6)}`,
          network: 'eip155:84532',
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

const PORT = process.env.PORT || 3000;
(async () => {
  await resourceServer.initialize();
  app.listen(PORT, () => console.log(`listening-heart running on port ${PORT}`));
})().catch(err => { console.error('Startup failed:', err); process.exit(1); });
