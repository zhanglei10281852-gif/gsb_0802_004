import Database from 'better-sqlite3';
import type {
  DecisionRecord,
  EventRecord,
  EvidenceRecord,
  ProposalRecord,
  Repository,
  SubjectRecord
} from '../../ports/repository.js';

/**
 * SQLite implementation of the persistence port (better-sqlite3, synchronous).
 *
 * Everything the control center concludes lives here so that a restart
 * recovers the full state and a reconnecting web client gets a consistent
 * snapshot from durable storage rather than from in-process events. The schema
 * is small and explicit; JSON-valued columns store schemas, reports, and gate
 * snapshots verbatim.
 *
 * Durability choices:
 *  - WAL journal + synchronous=FULL so a committed transaction survives a hard
 *    process kill (our "crash after write" scenario).
 *  - Decisions are immutable: there is no UPDATE path for a decision row, and
 *    committing one flips the proposal to a terminal state in the same
 *    transaction. That single transaction is our compare-and-set for
 *    concurrent approvals.
 */
export class SqliteRepository implements Repository {
  private db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subjects (
        subject_id TEXT PRIMARY KEY,
        required_consumers TEXT NOT NULL,
        freshness_window_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(subject_id),
        candidate_digest TEXT NOT NULL,
        baseline_schema TEXT NOT NULL,
        candidate_schema TEXT NOT NULL,
        compat TEXT NOT NULL,
        state TEXT NOT NULL,
        seq INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL,
        submitted_by TEXT NOT NULL,
        decision_id TEXT,
        UNIQUE(subject_id, candidate_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_subject ON proposals(subject_id);
      -- At most one OPEN proposal per subject.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_open
        ON proposals(subject_id) WHERE state = 'OPEN';

      CREATE TABLE IF NOT EXISTS evidence (
        report_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
        subject_id TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        produced_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        detail TEXT,
        applied INTEGER NOT NULL,
        ignored_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_proposal ON evidence(proposal_id);

      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(proposal_id),
        subject_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL,
        type TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        gate_snapshot TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        subject_id TEXT,
        proposal_id TEXT,
        payload TEXT NOT NULL
      );
    `);
  }

  // --- subjects ---
  upsertSubject(rec: SubjectRecord): void {
    this.db
      .prepare(
        `INSERT INTO subjects (subject_id, required_consumers, freshness_window_ms, created_at)
         VALUES (@subjectId, @rc, @freshnessWindowMs, @createdAt)
         ON CONFLICT(subject_id) DO UPDATE SET
           required_consumers = excluded.required_consumers,
           freshness_window_ms = excluded.freshness_window_ms`
      )
      .run({
        subjectId: rec.subjectId,
        rc: JSON.stringify(rec.requiredConsumers),
        freshnessWindowMs: rec.freshnessWindowMs,
        createdAt: rec.createdAt
      });
  }

  getSubject(subjectId: string): SubjectRecord | undefined {
    const row = this.db.prepare('SELECT * FROM subjects WHERE subject_id = ?').get(subjectId) as any;
    return row ? rowToSubject(row) : undefined;
  }

  listSubjects(): SubjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM subjects ORDER BY created_at ASC').all() as any[];
    return rows.map(rowToSubject);
  }

  // --- proposals ---
  insertProposal(rec: ProposalRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals
          (proposal_id, subject_id, candidate_digest, baseline_schema, candidate_schema,
           compat, state, seq, submitted_at, submitted_by, decision_id)
         VALUES
          (@proposalId, @subjectId, @candidateDigest, @baseline, @candidate,
           @compat, @state, @seq, @submittedAt, @submittedBy, @decisionId)`
      )
      .run({
        proposalId: rec.proposalId,
        subjectId: rec.subjectId,
        candidateDigest: rec.candidateDigest,
        baseline: JSON.stringify(rec.baselineSchema),
        candidate: JSON.stringify(rec.candidateSchema),
        compat: JSON.stringify(rec.compat),
        state: rec.state,
        seq: rec.seq,
        submittedAt: rec.submittedAt,
        submittedBy: rec.submittedBy,
        decisionId: rec.decisionId
      });
  }

  getProposal(proposalId: string): ProposalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId) as any;
    return row ? rowToProposal(row) : undefined;
  }

  getProposalByDigest(subjectId: string, candidateDigest: string): ProposalRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE subject_id = ? AND candidate_digest = ?')
      .get(subjectId, candidateDigest) as any;
    return row ? rowToProposal(row) : undefined;
  }

  getOpenProposal(subjectId: string): ProposalRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE subject_id = ? AND state = 'OPEN'")
      .get(subjectId) as any;
    return row ? rowToProposal(row) : undefined;
  }

  listProposals(subjectId: string): ProposalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM proposals WHERE subject_id = ? ORDER BY seq ASC')
      .all(subjectId) as any[];
    return rows.map(rowToProposal);
  }

  markSuperseded(proposalId: string, at: number): void {
    const info = this.db
      .prepare("UPDATE proposals SET state = 'SUPERSEDED' WHERE proposal_id = ? AND state = 'OPEN'")
      .run(proposalId);
    if (info.changes === 1) {
      this.appendEvent('proposal.superseded', at, { proposalId }, { proposalId });
    }
  }

  // --- evidence ---
  getEvidence(reportId: string): EvidenceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM evidence WHERE report_id = ?').get(reportId) as any;
    return row ? rowToEvidence(row) : undefined;
  }

  insertEvidence(rec: EvidenceRecord): void {
    this.db
      .prepare(
        `INSERT INTO evidence
          (report_id, proposal_id, subject_id, target_digest, consumer_id, verdict,
           produced_at, received_at, detail, applied, ignored_reason)
         VALUES
          (@reportId, @proposalId, @subjectId, @targetDigest, @consumerId, @verdict,
           @producedAt, @receivedAt, @detail, @applied, @ignoredReason)`
      )
      .run({
        reportId: rec.reportId,
        proposalId: rec.proposalId,
        subjectId: rec.subjectId,
        targetDigest: rec.targetDigest,
        consumerId: rec.consumerId,
        verdict: rec.verdict,
        producedAt: rec.producedAt,
        receivedAt: rec.receivedAt,
        detail: rec.detail,
        applied: rec.applied ? 1 : 0,
        ignoredReason: rec.ignoredReason
      });
  }

  listEvidenceForProposal(proposalId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE proposal_id = ? ORDER BY received_at ASC, report_id ASC')
      .all(proposalId) as any[];
    return rows.map(rowToEvidence);
  }

  listAppliedEvidence(proposalId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE proposal_id = ? AND applied = 1 ORDER BY received_at ASC')
      .all(proposalId) as any[];
    return rows.map(rowToEvidence);
  }

  // --- decisions ---
  getDecision(decisionId: string): DecisionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decisionId) as any;
    return row ? rowToDecision(row) : undefined;
  }

  getDecisionForProposal(proposalId: string): DecisionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE proposal_id = ?').get(proposalId) as any;
    return row ? rowToDecision(row) : undefined;
  }

  commitDecision(rec: DecisionRecord): boolean {
    // Compare-and-set: only transition an OPEN proposal, and do the decision
    // insert + proposal close in one transaction. If two approvals race, the
    // second sees 0 changed rows and is rejected as a conflict.
    const tx = this.db.transaction((d: DecisionRecord): boolean => {
      const upd = this.db
        .prepare(
          `UPDATE proposals SET state = @state, decision_id = @decisionId
           WHERE proposal_id = @proposalId AND state = 'OPEN'`
        )
        .run({
          state: d.type === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decisionId: d.decisionId,
          proposalId: d.proposalId
        });
      if (upd.changes !== 1) return false;

      this.db
        .prepare(
          `INSERT INTO decisions
            (decision_id, proposal_id, subject_id, candidate_digest, type,
             evidence_fingerprint, gate_snapshot, decided_at, decided_by, note)
           VALUES
            (@decisionId, @proposalId, @subjectId, @candidateDigest, @type,
             @evidenceFingerprint, @gateSnapshot, @decidedAt, @decidedBy, @note)`
        )
        .run({
          decisionId: d.decisionId,
          proposalId: d.proposalId,
          subjectId: d.subjectId,
          candidateDigest: d.candidateDigest,
          type: d.type,
          evidenceFingerprint: d.evidenceFingerprint,
          gateSnapshot: JSON.stringify(d.gateSnapshot),
          decidedAt: d.decidedAt,
          decidedBy: d.decidedBy,
          note: d.note
        });

      this.db
        .prepare(
          `INSERT INTO events (at, type, subject_id, proposal_id, payload)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(d.decidedAt, 'decision.committed', d.subjectId, d.proposalId, JSON.stringify({
          decisionId: d.decisionId,
          type: d.type,
          evidenceFingerprint: d.evidenceFingerprint
        }));

      return true;
    });
    return tx(rec);
  }

  // --- events ---
  appendEvent(
    type: string,
    at: number,
    ids: { subjectId?: string | null; proposalId?: string | null },
    payload: unknown
  ): number {
    const info = this.db
      .prepare(`INSERT INTO events (at, type, subject_id, proposal_id, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(at, type, ids.subjectId ?? null, ids.proposalId ?? null, JSON.stringify(payload ?? null));
    return Number(info.lastInsertRowid);
  }

  listEvents(sinceSeq = 0): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC')
      .all(sinceSeq) as any[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      type: r.type,
      subjectId: r.subject_id,
      proposalId: r.proposal_id,
      payload: JSON.parse(r.payload)
    }));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

// --- row mappers -----------------------------------------------------------

function rowToSubject(row: any): SubjectRecord {
  return {
    subjectId: row.subject_id,
    requiredConsumers: JSON.parse(row.required_consumers),
    freshnessWindowMs: row.freshness_window_ms,
    createdAt: row.created_at
  };
}

function rowToProposal(row: any): ProposalRecord {
  return {
    proposalId: row.proposal_id,
    subjectId: row.subject_id,
    candidateDigest: row.candidate_digest,
    baselineSchema: JSON.parse(row.baseline_schema),
    candidateSchema: JSON.parse(row.candidate_schema),
    compat: JSON.parse(row.compat),
    state: row.state,
    seq: row.seq,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
    decisionId: row.decision_id
  };
}

function rowToEvidence(row: any): EvidenceRecord {
  return {
    reportId: row.report_id,
    proposalId: row.proposal_id,
    subjectId: row.subject_id,
    targetDigest: row.target_digest,
    consumerId: row.consumer_id,
    verdict: row.verdict,
    producedAt: row.produced_at,
    receivedAt: row.received_at,
    detail: row.detail,
    applied: row.applied === 1,
    ignoredReason: row.ignored_reason
  };
}

function rowToDecision(row: any): DecisionRecord {
  return {
    decisionId: row.decision_id,
    proposalId: row.proposal_id,
    subjectId: row.subject_id,
    candidateDigest: row.candidate_digest,
    type: row.type,
    evidenceFingerprint: row.evidence_fingerprint,
    gateSnapshot: JSON.parse(row.gate_snapshot),
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note
  };
}
