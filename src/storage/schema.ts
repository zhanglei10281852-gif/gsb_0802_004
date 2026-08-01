import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      proposal_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      baseline_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      candidate_digest TEXT NOT NULL,
      baseline_digest TEXT NOT NULL,
      compatibility_json TEXT NOT NULL,
      consumers_json TEXT NOT NULL,
      author TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      decided_at INTEGER,
      decision_json TEXT,
      expected_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
      candidate_digest TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      agent_run_id TEXT NOT NULL,
      UNIQUE(proposal_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_proposal ON evidence(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_digest_consumer ON evidence(candidate_digest, consumer_id);

    CREATE TABLE IF NOT EXISTS event_log (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_proposal ON event_log(proposal_id, event_id);

    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exemptions (
      exemption_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
      candidate_digest TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      reviews_json TEXT NOT NULL,
      revoked_at INTEGER,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exemptions_proposal ON exemptions(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_exemptions_scope ON exemptions(candidate_digest, consumer_id, environment, direction, status);
  `);
}
