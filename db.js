const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      note_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author_address TEXT NOT NULL,
      content TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'general',
      payment_amount INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notes_author ON notes(author_address);

    CREATE TABLE IF NOT EXISTS bulletin_acks (
      ack_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      message TEXT NOT NULL,
      signature TEXT NOT NULL,
      acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, wallet_address)
    );
    CREATE INDEX IF NOT EXISTS idx_acks_task ON bulletin_acks(task_id, acknowledged_at);
    CREATE INDEX IF NOT EXISTS idx_acks_wallet ON bulletin_acks(wallet_address);
  `);
}

init().catch(console.error);

module.exports = pool;
