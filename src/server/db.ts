import Database from 'better-sqlite3';

/**
 * 唯一的状态来源。所有可变状态都在 SQLite 中，进程重启后完整恢复；
 * 内存中不保存任何业务状态（SSE 订阅者列表除外）。
 */
export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
CREATE TABLE IF NOT EXISTS proposals (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','approved','rejected')),
  version          INTEGER NOT NULL,
  baseline_json    TEXT NOT NULL,
  baseline_digest  TEXT NOT NULL,
  candidate_json   TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  compat_json      TEXT NOT NULL,
  consumers_json   TEXT NOT NULL,
  evidence_ttl_ms  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  decision_id      TEXT
);
CREATE TABLE IF NOT EXISTS evidence (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id        TEXT NOT NULL REFERENCES proposals(id),
  consumer_id        TEXT NOT NULL,
  candidate_digest   TEXT NOT NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  run_id             TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  details_json       TEXT,
  recorded_at        INTEGER NOT NULL,
  applies_to_current INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_proposal ON evidence(proposal_id);
CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL REFERENCES proposals(id),
  action        TEXT NOT NULL CHECK (action IN ('approve','reject')),
  decided_by    TEXT NOT NULL,
  rationale     TEXT,
  decided_at    INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  proposal_id  TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_proposal ON events(proposal_id);
`);
  return db;
}
