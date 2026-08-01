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
      expected_version INTEGER NOT NULL DEFAULT 0,
      predecessor_id TEXT,
      successor_id TEXT,
      superseded_at INTEGER,
      superseded_by TEXT,
      lineage_note TEXT
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

    CREATE TABLE IF NOT EXISTS rollouts (
      rollout_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      paused_at INTEGER,
      finished_at INTEGER,
      current_wave_sequence INTEGER NOT NULL DEFAULT 0,
      previous_version TEXT,
      rollback_target_wave_id TEXT,
      rolled_back_at INTEGER,
      note TEXT,
      snapshot_json TEXT NOT NULL,
      waves_json TEXT NOT NULL,
      expected_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rollouts_proposal ON rollouts(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_rollouts_status ON rollouts(status);

    CREATE TABLE IF NOT EXISTS rollout_receipts (
      receipt_id TEXT PRIMARY KEY,
      rollout_id TEXT NOT NULL REFERENCES rollouts(rollout_id),
      wave_id TEXT NOT NULL,
      wave_sequence INTEGER NOT NULL,
      result TEXT NOT NULL,
      message TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      adapter_run_id TEXT NOT NULL,
      UNIQUE(rollout_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_rollout ON rollout_receipts(rollout_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_wave ON rollout_receipts(rollout_id, wave_sequence);
  `);

  ensureColumn(db, "proposals", "predecessor_id", "TEXT");
  ensureColumn(db, "proposals", "successor_id", "TEXT");
  ensureColumn(db, "proposals", "superseded_at", "INTEGER");
  ensureColumn(db, "proposals", "superseded_by", "TEXT");
  ensureColumn(db, "proposals", "lineage_note", "TEXT");

  ensureColumn(db, "proposals", "additions_json", "TEXT NOT NULL DEFAULT '[]'");

  ensureColumn(db, "rollouts", "pause_reason", "TEXT");
  ensureColumn(
    db,
    "rollouts",
    "gap_consumer_ids",
    "TEXT NOT NULL DEFAULT '[]'",
  );
}

function ensureColumn(
  db: DB,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
