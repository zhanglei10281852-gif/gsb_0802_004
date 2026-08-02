import Database from 'better-sqlite3';
import type {
  DecisionRecord,
  EventRecord,
  EvidenceRecord,
  ProposalRecord,
  ReceiptRecord,
  Repository,
  RevalidationRecord,
  RolloutRecord,
  SubjectRecord,
  WaiverRecord,
  WaveRecord
} from '../../ports/repository.js';
import type { RevalidationResolution, RolloutStatus, WaveStatus } from '../../domain/rollout.js';

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

      CREATE TABLE IF NOT EXISTS rollouts (
        rollout_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        kind TEXT NOT NULL,
        decision_id TEXT,
        proposal_id TEXT,
        candidate_digest TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        supersedes_rollout_id TEXT,
        note TEXT,
        hold_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rollouts_subject ON rollouts(subject_id);
      -- At most one non-terminal rollout per (subject, environment).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rollouts_one_active
        ON rollouts(subject_id, environment)
        WHERE status IN ('PENDING','IN_PROGRESS','PAUSED');

      CREATE TABLE IF NOT EXISTS waves (
        wave_id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES rollouts(rollout_id),
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        started_at INTEGER,
        settled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_waves_rollout ON waves(rollout_id);

      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES rollouts(rollout_id),
        wave_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        result TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        detail TEXT,
        applied INTEGER NOT NULL,
        ignored_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_rollout ON receipts(rollout_id);

      CREATE TABLE IF NOT EXISTS revalidations (
        revalidation_id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES rollouts(rollout_id),
        subject_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        candidate_digest TEXT NOT NULL,
        environment TEXT NOT NULL,
        added_consumers TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        resolution TEXT,
        resolved_at INTEGER,
        resolved_by TEXT,
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_revalidations_rollout ON revalidations(rollout_id);
      -- At most one OPEN revalidation per rollout.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_revalidations_one_open
        ON revalidations(rollout_id) WHERE status = 'OPEN';
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

  // --- rollouts / waves / receipts ---
  insertRollout(rollout: RolloutRecord, waves: WaveRecord[]): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rollouts
            (rollout_id, subject_id, environment, kind, decision_id, proposal_id, candidate_digest,
             evidence_fingerprint, status, created_at, created_by, supersedes_rollout_id, note, hold_reason)
           VALUES
            (@rolloutId, @subjectId, @environment, @kind, @decisionId, @proposalId, @candidateDigest,
             @evidenceFingerprint, @status, @createdAt, @createdBy, @supersedesRolloutId, @note, @holdReason)`
        )
        .run({
          rolloutId: rollout.rolloutId,
          subjectId: rollout.subjectId,
          environment: rollout.environment,
          kind: rollout.kind,
          decisionId: rollout.decisionId,
          proposalId: rollout.proposalId,
          candidateDigest: rollout.candidateDigest,
          evidenceFingerprint: rollout.evidenceFingerprint,
          status: rollout.status,
          createdAt: rollout.createdAt,
          createdBy: rollout.createdBy,
          supersedesRolloutId: rollout.supersedesRolloutId,
          note: rollout.note,
          holdReason: rollout.holdReason
        });
      const insWave = this.db.prepare(
        `INSERT INTO waves (wave_id, rollout_id, ordinal, name, status, attempt, started_at, settled_at)
         VALUES (@waveId, @rolloutId, @ordinal, @name, @status, @attempt, @startedAt, @settledAt)`
      );
      for (const w of waves) {
        insWave.run({
          waveId: w.waveId,
          rolloutId: w.rolloutId,
          ordinal: w.ordinal,
          name: w.name,
          status: w.status,
          attempt: w.attempt,
          startedAt: w.startedAt,
          settledAt: w.settledAt
        });
      }
    });
    tx();
  }

  getRollout(rolloutId: string): RolloutRecord | undefined {
    const row = this.db.prepare('SELECT * FROM rollouts WHERE rollout_id = ?').get(rolloutId) as any;
    return row ? rowToRollout(row) : undefined;
  }

  listRollouts(subjectId: string): RolloutRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rollouts WHERE subject_id = ? ORDER BY created_at ASC, rollout_id ASC')
      .all(subjectId) as any[];
    return rows.map(rowToRollout);
  }

  getActiveRollout(subjectId: string, environment: string): RolloutRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM rollouts WHERE subject_id = ? AND environment = ? AND status IN ('PENDING','IN_PROGRESS','PAUSED')"
      )
      .get(subjectId, environment) as any;
    return row ? rowToRollout(row) : undefined;
  }

  listWaves(rolloutId: string): WaveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM waves WHERE rollout_id = ? ORDER BY ordinal ASC')
      .all(rolloutId) as any[];
    return rows.map(rowToWave);
  }

  getWave(waveId: string): WaveRecord | undefined {
    const row = this.db.prepare('SELECT * FROM waves WHERE wave_id = ?').get(waveId) as any;
    return row ? rowToWave(row) : undefined;
  }

  getReceipt(receiptId: string): ReceiptRecord | undefined {
    const row = this.db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId) as any;
    return row ? rowToReceipt(row) : undefined;
  }

  listReceipts(rolloutId: string): ReceiptRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM receipts WHERE rollout_id = ? ORDER BY received_at ASC, receipt_id ASC')
      .all(rolloutId) as any[];
    return rows.map(rowToReceipt);
  }

  setRolloutStatus(
    rolloutId: string,
    fromStatuses: RolloutStatus[],
    toStatus: RolloutStatus,
    at: number,
    eventType: string,
    payload: unknown
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      const placeholders = fromStatuses.map(() => '?').join(',');
      const upd = this.db
        .prepare(`UPDATE rollouts SET status = ? WHERE rollout_id = ? AND status IN (${placeholders})`)
        .run(toStatus, rolloutId, ...fromStatuses);
      if (upd.changes !== 1) return false;
      const r = this.getRollout(rolloutId)!;
      this.appendEvent(eventType, at, { subjectId: r.subjectId, proposalId: r.proposalId }, payload);
      return true;
    });
    return tx();
  }

  startNextWave(rolloutId: string, at: number): WaveRecord | undefined {
    const tx = this.db.transaction((): WaveRecord | undefined => {
      const rollout = this.getRollout(rolloutId);
      if (!rollout || !['PENDING', 'IN_PROGRESS'].includes(rollout.status)) return undefined;
      // Refuse to start a new wave while one is still live.
      const inProgress = this.db
        .prepare("SELECT COUNT(*) AS n FROM waves WHERE rollout_id = ? AND status = 'IN_PROGRESS'")
        .get(rolloutId) as any;
      if (inProgress.n > 0) return undefined;
      const next = this.db
        .prepare("SELECT * FROM waves WHERE rollout_id = ? AND status = 'PENDING' ORDER BY ordinal ASC LIMIT 1")
        .get(rolloutId) as any;
      if (!next) return undefined;
      this.db
        .prepare("UPDATE waves SET status = 'IN_PROGRESS', started_at = @at WHERE wave_id = @id")
        .run({ at, id: next.wave_id });
      this.db.prepare("UPDATE rollouts SET status = 'IN_PROGRESS' WHERE rollout_id = ?").run(rolloutId);
      const wave = this.getWave(next.wave_id)!;
      this.appendEvent('rollout.wave.started', at, { subjectId: rollout.subjectId, proposalId: rollout.proposalId }, {
        rolloutId,
        waveId: wave.waveId,
        ordinal: wave.ordinal,
        attempt: wave.attempt
      });
      return wave;
    });
    return tx();
  }

  applyReceipt(
    receipt: ReceiptRecord,
    settle: { waveId: string; toStatus: WaveStatus; rolloutToStatus: RolloutStatus | null } | null,
    at: number
  ): ReceiptRecord {
    const tx = this.db.transaction((): ReceiptRecord => {
      // Idempotency: a receipt id is processed at most once.
      const prior = this.getReceipt(receipt.receiptId);
      if (prior) return prior;

      this.db
        .prepare(
          `INSERT INTO receipts
            (receipt_id, rollout_id, wave_id, attempt, result, evidence_fingerprint, received_at, detail, applied, ignored_reason)
           VALUES
            (@receiptId, @rolloutId, @waveId, @attempt, @result, @evidenceFingerprint, @receivedAt, @detail, @applied, @ignoredReason)`
        )
        .run({
          receiptId: receipt.receiptId,
          rolloutId: receipt.rolloutId,
          waveId: receipt.waveId,
          attempt: receipt.attempt,
          result: receipt.result,
          evidenceFingerprint: receipt.evidenceFingerprint,
          receivedAt: receipt.receivedAt,
          detail: receipt.detail,
          applied: receipt.applied ? 1 : 0,
          ignoredReason: receipt.ignoredReason
        });

      const rollout = this.getRollout(receipt.rolloutId);
      if (settle && rollout) {
        // Settle the wave only if it is still the live attempt (guards against
        // a stale decisive receipt that raced a retry between classify+apply).
        this.db
          .prepare(
            `UPDATE waves SET status = @toStatus, settled_at = @at
             WHERE wave_id = @waveId AND attempt = @attempt AND status = 'IN_PROGRESS'`
          )
          .run({ toStatus: settle.toStatus, at, waveId: settle.waveId, attempt: receipt.attempt });
        if (settle.rolloutToStatus) {
          this.db.prepare('UPDATE rollouts SET status = ? WHERE rollout_id = ?').run(settle.rolloutToStatus, receipt.rolloutId);
        }
      }

      this.appendEvent(
        receipt.applied ? 'rollout.receipt.applied' : 'rollout.receipt.ignored',
        at,
        { subjectId: rollout?.subjectId ?? null, proposalId: rollout?.proposalId ?? null },
        {
          receiptId: receipt.receiptId,
          rolloutId: receipt.rolloutId,
          waveId: receipt.waveId,
          attempt: receipt.attempt,
          result: receipt.result,
          ...(receipt.ignoredReason ? { ignoredReason: receipt.ignoredReason } : {}),
          ...(settle ? { settledTo: settle.toStatus } : {})
        }
      );
      return this.getReceipt(receipt.receiptId)!;
    });
    return tx();
  }

  retryWave(rolloutId: string, waveId: string, at: number): number | undefined {
    const tx = this.db.transaction((): number | undefined => {
      const rollout = this.getRollout(rolloutId);
      // A wave can be retried while the rollout is still live (IN_PROGRESS),
      // paused, or has already been marked FAILED by the failing wave. Terminal
      // COMPLETED/ROLLED_BACK rollouts are not retryable.
      if (!rollout || !['IN_PROGRESS', 'PAUSED', 'FAILED'].includes(rollout.status)) return undefined;
      const wave = this.getWave(waveId);
      if (!wave || wave.rolloutId !== rolloutId) return undefined;
      if (!['IN_PROGRESS', 'FAILED'].includes(wave.status)) return undefined;
      const attempt = wave.attempt + 1;
      // Bump the attempt and re-open the wave. Any receipt for the prior
      // attempt is now stale by attempt number.
      this.db
        .prepare("UPDATE waves SET attempt = @attempt, status = 'IN_PROGRESS', started_at = @at, settled_at = NULL WHERE wave_id = @id")
        .run({ attempt, at, id: waveId });
      this.db.prepare("UPDATE rollouts SET status = 'IN_PROGRESS' WHERE rollout_id = ?").run(rolloutId);
      this.appendEvent('rollout.wave.retried', at, { subjectId: rollout.subjectId, proposalId: rollout.proposalId }, {
        rolloutId,
        waveId,
        attempt
      });
      return attempt;
    });
    return tx();
  }

  // --- topology-change re-validation ---
  setRolloutHold(rolloutId: string, holdReason: string | null, at: number, eventType: string, payload: unknown): void {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare('UPDATE rollouts SET hold_reason = @holdReason WHERE rollout_id = @id')
        .run({ holdReason, id: rolloutId });
      if (info.changes === 1) {
        const r = this.getRollout(rolloutId)!;
        this.appendEvent(eventType, at, { subjectId: r.subjectId, proposalId: r.proposalId }, payload);
      }
    });
    tx();
  }

  insertRevalidation(rec: RevalidationRecord): void {
    this.db
      .prepare(
        `INSERT INTO revalidations
          (revalidation_id, rollout_id, subject_id, proposal_id, candidate_digest, environment,
           added_consumers, status, reason, opened_at, resolution, resolved_at, resolved_by, resolution_note)
         VALUES
          (@revalidationId, @rolloutId, @subjectId, @proposalId, @candidateDigest, @environment,
           @addedConsumers, @status, @reason, @openedAt, @resolution, @resolvedAt, @resolvedBy, @resolutionNote)`
      )
      .run({
        revalidationId: rec.revalidationId,
        rolloutId: rec.rolloutId,
        subjectId: rec.subjectId,
        proposalId: rec.proposalId,
        candidateDigest: rec.candidateDigest,
        environment: rec.environment,
        addedConsumers: JSON.stringify(rec.addedConsumers),
        status: rec.status,
        reason: rec.reason,
        openedAt: rec.openedAt,
        resolution: rec.resolution,
        resolvedAt: rec.resolvedAt,
        resolvedBy: rec.resolvedBy,
        resolutionNote: rec.resolutionNote
      });
  }

  getRevalidation(revalidationId: string): RevalidationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM revalidations WHERE revalidation_id = ?').get(revalidationId) as any;
    return row ? rowToRevalidation(row) : undefined;
  }

  getOpenRevalidation(rolloutId: string): RevalidationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM revalidations WHERE rollout_id = ? AND status = 'OPEN'")
      .get(rolloutId) as any;
    return row ? rowToRevalidation(row) : undefined;
  }

  listRevalidations(rolloutId: string): RevalidationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM revalidations WHERE rollout_id = ? ORDER BY opened_at ASC, revalidation_id ASC')
      .all(rolloutId) as any[];
    return rows.map(rowToRevalidation);
  }

  resolveRevalidation(
    revalidationId: string,
    resolution: RevalidationResolution,
    resolvedBy: string,
    note: string | null,
    at: number
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      const upd = this.db
        .prepare(
          `UPDATE revalidations
             SET status = 'RESOLVED', resolution = @resolution, resolved_at = @at, resolved_by = @by, resolution_note = @note
           WHERE revalidation_id = @id AND status = 'OPEN'`
        )
        .run({ id: revalidationId, resolution, at, by: resolvedBy, note });
      if (upd.changes !== 1) return false;
      const rec = this.getRevalidation(revalidationId)!;
      this.appendEvent('rollout.revalidation.resolved', at, { subjectId: rec.subjectId, proposalId: rec.proposalId }, {
        revalidationId,
        rolloutId: rec.rolloutId,
        resolution,
        resolvedBy,
        addedConsumers: rec.addedConsumers,
        note
      });
      return true;
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

function rowToRollout(row: any): RolloutRecord {
  return {
    rolloutId: row.rollout_id,
    subjectId: row.subject_id,
    environment: row.environment,
    kind: row.kind,
    decisionId: row.decision_id,
    proposalId: row.proposal_id,
    candidateDigest: row.candidate_digest,
    evidenceFingerprint: row.evidence_fingerprint,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    supersedesRolloutId: row.supersedes_rollout_id,
    note: row.note,
    holdReason: row.hold_reason ?? null
  };
}

function rowToRevalidation(row: any): RevalidationRecord {
  return {
    revalidationId: row.revalidation_id,
    rolloutId: row.rollout_id,
    subjectId: row.subject_id,
    proposalId: row.proposal_id,
    candidateDigest: row.candidate_digest,
    environment: row.environment,
    addedConsumers: JSON.parse(row.added_consumers),
    status: row.status,
    reason: row.reason,
    openedAt: row.opened_at,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note
  };
}

function rowToWave(row: any): WaveRecord {
  return {
    waveId: row.wave_id,
    rolloutId: row.rollout_id,
    ordinal: row.ordinal,
    name: row.name,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    settledAt: row.settled_at
  };
}

function rowToReceipt(row: any): ReceiptRecord {
  return {
    receiptId: row.receipt_id,
    rolloutId: row.rollout_id,
    waveId: row.wave_id,
    attempt: row.attempt,
    result: row.result,
    evidenceFingerprint: row.evidence_fingerprint,
    receivedAt: row.received_at,
    detail: row.detail,
    applied: row.applied === 1,
    ignoredReason: row.ignored_reason
  };
}
