require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { paymentMiddleware } = require('@x402/express');
const db = require('./db');
const { getTaskCreator } = require('./taskmarket');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOTE_PRICE = process.env.NOTE_PRICE || '1000'; // 0.001 USDC
const FACILITATOR = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

const NOTE_TYPES = ['general', 'progress', 'clarification', 'suggestion', 'question'];

// POST /tasks/:taskId/notes
app.post('/tasks/:taskId/notes', async (req, res, next) => {
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
    db.prepare(`INSERT INTO notes (note_id, task_id, author_address, content, note_type, payment_amount) VALUES (?, ?, ?, ?, ?, 0)`)
      .run(noteId, taskId, authorAddress.toLowerCase(), content.trim(), noteType);
    return res.status(201).json(buildNote(db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId)));
  }

  // Everyone else pays via x402
  const payTo = taskCreator || process.env.FALLBACK_WALLET;
  if (!payTo) return res.status(500).json({ error: 'Could not determine payment recipient' });

  const middleware = paymentMiddleware(payTo, {
    ['/tasks/:taskId/notes']: {
      price: `$${(parseInt(NOTE_PRICE) / 1e6).toFixed(6)}`,
      network: 'base',
      config: { description: `Note on task ${taskId.slice(0, 10)}...` }
    }
  }, { url: FACILITATOR });

  middleware(req, res, async () => {
    const noteId = uuidv4();
    db.prepare(`INSERT INTO notes (note_id, task_id, author_address, content, note_type, payment_amount) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(noteId, taskId, authorAddress.toLowerCase(), content.trim(), noteType, parseInt(NOTE_PRICE));
    return res.status(201).json(buildNote(db.prepare('SELECT * FROM notes WHERE note_id = ?').get(noteId)));
  });
});

// GET /tasks/:taskId/notes
app.get('/tasks/:taskId/notes', (req, res) => {
  const { taskId } = req.params;
  const { noteType, limit = 50, offset = 0 } = req.query;

  let query = 'SELECT * FROM notes WHERE task_id = ?';
  const params = [taskId];

  if (noteType) { query += ' AND note_type = ?'; params.push(noteType); }
  query += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const notes = db.prepare(query).all(...params).map(buildNote);
  const stats = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(payment_amount),0) as earned FROM notes WHERE task_id = ?').get(taskId);

  res.json({ taskId, notes, totalNotes: stats.total, totalEngagementEarned: stats.earned });
});

// GET /tasks/:taskId/notes/stats
app.get('/tasks/:taskId/notes/stats', (req, res) => {
  const { taskId } = req.params;
  const stats = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(payment_amount),0) as earned, COUNT(DISTINCT author_address) as unique_contributors FROM notes WHERE task_id = ?').get(taskId);
  const byType = {};
  NOTE_TYPES.forEach(t => {
    byType[t] = db.prepare('SELECT COUNT(*) as c FROM notes WHERE task_id = ? AND note_type = ?').get(taskId, t).c;
  });
  res.json({ taskId, totalNotes: stats.total, uniqueContributors: stats.unique_contributors, totalPaymentsToCreator: stats.earned, notesByType: byType });
});

function buildNote(row) {
  return {
    noteId: row.note_id,
    taskId: row.task_id,
    author: row.author_address,
    content: row.content,
    noteType: row.note_type,
    timestamp: row.created_at,
    paymentAmount: row.payment_amount,
    isCreator: row.payment_amount === 0
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`listening-heart running on port ${PORT}`));
