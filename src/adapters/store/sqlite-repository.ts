import Database from 'better-sqlite3';
import type {
  DecisionRecord,
  EventRecord,
  EvidenceRecord,
  ProposalRecord,
  Repository,
  SubjectRecord,
  WaiverRecord
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
        predecessor_id TEXT,
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
        environment TEXT NOT NULL DEFAULT 'production',
        evidence_fingerprint TEXT NOT NULL,
        gate_snapshot TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS waivers (
        waiver_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        compat_direction TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        confirmed_by TEXT,
        confirmed_at INTEGER,
        closed_by TEXT,
        closed_at INTEGER,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_waivers_candidate ON waivers(subject_id, candidate_digest);
      CREATE INDEX IF NOT EXISTS idx_waivers_status ON waivers(status);

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
           compat, state, seq, submitted_at, submitted_by, decision_id, predecessor_id)
         VALUES
          (@proposalId, @subjectId, @candidateDigest, @baseline, @candidate,
           @compat, @state, @seq, @submittedAt, @submittedBy, @decisionId, @predecessorId)`
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
        decisionId: rec.decisionId,
        predecessorId: rec.predecessorId
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
            (decision_id, proposal_id, subject_id, candidate_digest, type, environment,
             evidence_fingerprint, gate_snapshot, decided_at, decided_by, note)
           VALUES
            (@decisionId, @proposalId, @subjectId, @candidateDigest, @type, @environment,
             @evidenceFingerprint, @gateSnapshot, @decidedAt, @decidedBy, @note)`
        )
        .run({
          decisionId: d.decisionId,
          proposalId: d.proposalId,
          subjectId: d.subjectId,
          candidateDigest: d.candidateDigest,
          type: d.type,
          environment: d.environment,
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
          environment: d.environment,
          evidenceFingerprint: d.evidenceFingerprint,
          appliedWaivers: d.gateSnapshot.appliedWaivers.map((w) => w.waiverId)
        }));

      return true;
    });
    return tx(rec);
  }

  // --- waivers ---
  insertWaiver(rec: WaiverRecord): void {
    this.db
      .prepare(
        `INSERT INTO waivers
          (waiver_id, subject_id, candidate_digest, consumer_id, environment, compat_direction,
           status, reason, requested_by, requested_at, expires_at,
           confirmed_by, confirmed_at, closed_by, closed_at, end_reason)
         VALUES
          (@waiverId, @subjectId, @candidateDigest, @consumerId, @environment, @compatDirection,
           @status, @reason, @requestedBy, @requestedAt, @expiresAt,
           @confirmedBy, @confirmedAt, @closedBy, @closedAt, @endReason)`
      )
      .run({
        waiverId: rec.waiverId,
        subjectId: rec.subjectId,
        candidateDigest: rec.candidateDigest,
        consumerId: rec.consumerId,
        environment: rec.environment,
        compatDirection: rec.compatDirection,
        status: rec.status,
        reason: rec.reason,
        requestedBy: rec.requestedBy,
        requestedAt: rec.requestedAt,
        expiresAt: rec.expiresAt,
        confirmedBy: rec.confirmedBy,
        confirmedAt: rec.confirmedAt,
        closedBy: rec.closedBy,
        closedAt: rec.closedAt,
        endReason: rec.endReason
      });
  }

  getWaiver(waiverId: string): WaiverRecord | undefined {
    const row = this.db.prepare('SELECT * FROM waivers WHERE waiver_id = ?').get(waiverId) as any;
    return row ? rowToWaiver(row) : undefined;
  }

  listWaiversForCandidate(subjectId: string, candidateDigest: string): WaiverRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM waivers WHERE subject_id = ? AND candidate_digest = ? ORDER BY requested_at ASC, waiver_id ASC')
      .all(subjectId, candidateDigest) as any[];
    return rows.map(rowToWaiver);
  }

  listActiveWaivers(subjectId: string, candidateDigest: string): WaiverRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM waivers WHERE subject_id = ? AND candidate_digest = ? AND status = 'ACTIVE' ORDER BY expires_at DESC")
      .all(subjectId, candidateDigest) as any[];
    return rows.map(rowToWaiver);
  }

  confirmWaiver(waiverId: string, confirmedBy: string, at: number): boolean {
    // Compare-and-set: only a REQUESTED waiver can transition to ACTIVE, so a
    // duplicate/concurrent confirmation cannot re-activate or double-confirm.
    const tx = this.db.transaction((): boolean => {
      const upd = this.db
        .prepare(
          `UPDATE waivers SET status = 'ACTIVE', confirmed_by = @by, confirmed_at = @at
           WHERE waiver_id = @id AND status = 'REQUESTED'`
        )
        .run({ id: waiverId, by: confirmedBy, at });
      if (upd.changes !== 1) return false;
      const w = this.getWaiver(waiverId)!;
      this.appendEvent('waiver.confirmed', at, { subjectId: w.subjectId }, {
        waiverId,
        confirmedBy,
        scope: { candidateDigest: w.candidateDigest, consumerId: w.consumerId, environment: w.environment, compatDirection: w.compatDirection },
        expiresAt: w.expiresAt
      });
      return true;
    });
    return tx();
  }

  rejectWaiver(waiverId: string, rejectedBy: string, at: number, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const upd = this.db
        .prepare(
          `UPDATE waivers SET status = 'REJECTED', closed_by = @by, closed_at = @at, end_reason = @reason
           WHERE waiver_id = @id AND status = 'REQUESTED'`
        )
        .run({ id: waiverId, by: rejectedBy, at, reason });
      if (upd.changes !== 1) return false;
      const w = this.getWaiver(waiverId)!;
      this.appendEvent('waiver.rejected', at, { subjectId: w.subjectId }, { waiverId, rejectedBy, reason });
      return true;
    });
    return tx();
  }

  revokeWaiver(waiverId: string, revokedBy: string, at: number, reason: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const upd = this.db
        .prepare(
          `UPDATE waivers SET status = 'REVOKED', closed_by = @by, closed_at = @at, end_reason = @reason
           WHERE waiver_id = @id AND status = 'ACTIVE'`
        )
        .run({ id: waiverId, by: revokedBy, at, reason });
      if (upd.changes !== 1) return false;
      const w = this.getWaiver(waiverId)!;
      this.appendEvent('waiver.revoked', at, { subjectId: w.subjectId }, { waiverId, revokedBy, reason });
      return true;
    });
    return tx();
  }

  expireWaivers(now: number): string[] {
    // Lazy expiry: flip any ACTIVE waiver past its expiry to EXPIRED and log
    // why. Only ACTIVE rows are matched, so this is idempotent across calls.
    const tx = this.db.transaction((): string[] => {
      const due = this.db
        .prepare("SELECT * FROM waivers WHERE status = 'ACTIVE' AND expires_at <= ?")
        .all(now) as any[];
      const ids: string[] = [];
      for (const row of due) {
        const w = rowToWaiver(row);
        this.db
          .prepare(
            `UPDATE waivers SET status = 'EXPIRED', end_reason = @reason
             WHERE waiver_id = @id AND status = 'ACTIVE'`
          )
          .run({ id: w.waiverId, reason: `expired at t=${w.expiresAt}` });
        this.appendEvent('waiver.expired', now, { subjectId: w.subjectId }, {
          waiverId: w.waiverId,
          consumerId: w.consumerId,
          environment: w.environment,
          expiresAt: w.expiresAt,
          reason: `waiver expired at t=${w.expiresAt} (now t=${now})`
        });
        ids.push(w.waiverId);
      }
      return ids;
    });
    return tx();
  }

  lapseWaiversForCandidate(subjectId: string, candidateDigest: string, at: number, reason: string): string[] {
    // When a candidate is replaced, its still-open waivers (REQUESTED or ACTIVE)
    // fall away with the old candidate. They are matched by their exact scope
    // (subject + candidate digest), so a successor's fresh digest never keeps
    // them alive. Terminal waivers are left untouched (idempotent).
    const tx = this.db.transaction((): string[] => {
      const open = this.db
        .prepare(
          "SELECT * FROM waivers WHERE subject_id = ? AND candidate_digest = ? AND status IN ('REQUESTED','ACTIVE')"
        )
        .all(subjectId, candidateDigest) as any[];
      const ids: string[] = [];
      for (const row of open) {
        const w = rowToWaiver(row);
        this.db
          .prepare(
            `UPDATE waivers SET status = 'LAPSED', closed_at = @at, end_reason = @reason
             WHERE waiver_id = @id AND status IN ('REQUESTED','ACTIVE')`
          )
          .run({ id: w.waiverId, at, reason });
        this.appendEvent('waiver.lapsed', at, { subjectId: w.subjectId }, {
          waiverId: w.waiverId,
          consumerId: w.consumerId,
          environment: w.environment,
          compatDirection: w.compatDirection,
          candidateDigest,
          reason
        });
        ids.push(w.waiverId);
      }
      return ids;
    });
    return tx();
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
    decisionId: row.decision_id,
    predecessorId: row.predecessor_id ?? null
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
    environment: row.environment ?? 'production',
    evidenceFingerprint: row.evidence_fingerprint,
    gateSnapshot: JSON.parse(row.gate_snapshot),
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note
  };
}

function rowToWaiver(row: any): WaiverRecord {
  return {
    waiverId: row.waiver_id,
    subjectId: row.subject_id,
    candidateDigest: row.candidate_digest,
    consumerId: row.consumer_id,
    environment: row.environment,
    compatDirection: row.compat_direction,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    endReason: row.end_reason
  };
}
