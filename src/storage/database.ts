import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as DB } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  candidate_hash TEXT NOT NULL UNIQUE,
  candidate_schema TEXT NOT NULL,
  baseline_schema TEXT NOT NULL,
  system_compatible INTEGER NOT NULL,
  system_issues TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  environment TEXT NOT NULL DEFAULT 'production',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  candidate_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('compatible','incompatible','error')),
  details TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_pair
  ON evidence(proposal_id, consumer_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exemptions (
  id TEXT PRIMARY KEY,
  candidate_hash TEXT NOT NULL,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  environment TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('compatible','incompatible')),
  reason TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  confirmer_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','active','rejected','revoked','expired')),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  closed_at INTEGER,
  closed_by TEXT,
  close_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exemptions_open
  ON exemptions(candidate_hash, consumer_id, environment, direction)
  WHERE status IN ('pending','active');

CREATE TABLE IF NOT EXISTS causal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  clock INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_causal_clock ON causal_events(clock);
`;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

export function openDatabase(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  if (!hasColumn(db, 'proposals', 'environment')) {
    db.exec("ALTER TABLE proposals ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'");
  }
  return db;
}
