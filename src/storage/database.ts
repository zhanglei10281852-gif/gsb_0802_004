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
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  environment TEXT NOT NULL DEFAULT 'production',
  parent_proposal_id TEXT,
  replaces_candidate_hash TEXT,
  lineage_root_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_lineage ON proposals(lineage_root_id, revision);
CREATE INDEX IF NOT EXISTS idx_proposals_parent ON proposals(parent_proposal_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  candidate_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('compatible','incompatible','error')),
  details TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  late INTEGER NOT NULL DEFAULT 0
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
  status TEXT NOT NULL CHECK (status IN ('pending','active','rejected','revoked','expired','voided')),
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

CREATE TABLE IF NOT EXISTS rollouts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  candidate_hash TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_started','in_progress','paused','succeeded','failed','rolled_back')),
  previous_version TEXT,
  rolled_back_to TEXT,
  rolled_back_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waves (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  sequence INTEGER NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_progress','succeeded','failed','paused','rolled_back')),
  started_at INTEGER,
  finished_at INTEGER,
  last_result TEXT CHECK (last_result IS NULL OR last_result IN ('success','failure','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  last_adapter_id TEXT,
  UNIQUE (rollout_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_waves_rollout ON waves(rollout_id, sequence);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL REFERENCES waves(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failure','unknown')),
  adapter_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  message TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (wave_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_receipts_wave ON receipts(wave_id, recorded_at);
`;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function tableSql(db: DB, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

function migrateProposalsStatus(db: DB): void {
  const sql = tableSql(db, 'proposals');
  if (sql.includes("'superseded'")) return;
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE proposals_new (
      id TEXT PRIMARY KEY,
      candidate_hash TEXT NOT NULL UNIQUE,
      candidate_schema TEXT NOT NULL,
      baseline_schema TEXT NOT NULL,
      system_compatible INTEGER NOT NULL,
      system_issues TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
      environment TEXT NOT NULL DEFAULT 'production',
      parent_proposal_id TEXT,
      replaces_candidate_hash TEXT,
      lineage_root_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO proposals_new
      (id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues,
       status, environment, parent_proposal_id, replaces_candidate_hash, lineage_root_id, revision, created_at)
      SELECT id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues,
       status, environment, NULL, NULL, id, 1, created_at FROM proposals;
    DROP TABLE proposals;
    ALTER TABLE proposals_new RENAME TO proposals;
    CREATE INDEX IF NOT EXISTS idx_proposals_lineage ON proposals(lineage_root_id, revision);
    CREATE INDEX IF NOT EXISTS idx_proposals_parent ON proposals(parent_proposal_id);
  `);
  db.pragma('foreign_keys = ON');
}

function migrateExemptionsStatus(db: DB): void {
  const sql = tableSql(db, 'exemptions');
  if (sql.includes("'voided'")) return;
  db.exec(`
    CREATE TABLE exemptions_new (
      id TEXT PRIMARY KEY,
      candidate_hash TEXT NOT NULL,
      consumer_id TEXT NOT NULL REFERENCES consumers(id),
      environment TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('compatible','incompatible')),
      reason TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      confirmer_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','active','rejected','revoked','expired','voided')),
      valid_from INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      closed_at INTEGER,
      closed_by TEXT,
      close_note TEXT
    );
    INSERT INTO exemptions_new
      (id, candidate_hash, consumer_id, environment, direction, reason, requester_id, confirmer_id,
       status, valid_from, valid_until, created_at, confirmed_at, closed_at, closed_by, close_note)
    SELECT id, candidate_hash, consumer_id, environment, direction, reason, requester_id, confirmer_id,
       status, valid_from, valid_until, created_at, confirmed_at, closed_at, closed_by, close_note
    FROM exemptions;
    DROP TABLE exemptions;
    ALTER TABLE exemptions_new RENAME TO exemptions;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exemptions_open
      ON exemptions(candidate_hash, consumer_id, environment, direction)
      WHERE status IN ('pending','active');
  `);
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
  if (!hasColumn(db, 'proposals', 'parent_proposal_id')) {
    db.exec("ALTER TABLE proposals ADD COLUMN parent_proposal_id TEXT");
    db.exec("ALTER TABLE proposals ADD COLUMN replaces_candidate_hash TEXT");
    db.exec("ALTER TABLE proposals ADD COLUMN lineage_root_id TEXT");
    db.exec("ALTER TABLE proposals ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    db.exec("UPDATE proposals SET lineage_root_id = id WHERE lineage_root_id IS NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_lineage ON proposals(lineage_root_id, revision)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_parent ON proposals(parent_proposal_id)");
  }
  if (!hasColumn(db, 'evidence', 'late')) {
    db.exec("ALTER TABLE evidence ADD COLUMN late INTEGER NOT NULL DEFAULT 0");
  }
  migrateProposalsStatus(db);
  migrateExemptionsStatus(db);
  return db;
}
