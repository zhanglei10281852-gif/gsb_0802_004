import type { CompatDirection, CompatReport, DecisionType, Environment, GateEvaluation, JsonSchema, Verdict, WaiverStatus } from '../domain/types.js';
import type { ReceiptResult, RolloutKind, RolloutStatus, WaveStatus } from '../domain/rollout.js';

/**
 * Persistence port.
 *
 * The application service depends only on this interface, never on SQLite
 * directly. That keeps the gate/compatibility logic and the orchestration
 * decoupled from the storage adapter and makes the store replaceable (e.g. an
 * in-memory fake for a test). All methods are synchronous because the SQLite
 * adapter is synchronous; on a single Node thread this gives us atomic
 * transactions with no interleaving, which is exactly what safe concurrent
 * decisions require.
 */

export interface SubjectRecord {
  subjectId: string;
  /** Consumers whose fresh PASS is required before a candidate can ship. */
  requiredConsumers: string[];
  freshnessWindowMs: number;
  createdAt: number;
}

export interface ProposalRecord {
  proposalId: string;
  subjectId: string;
  /** Stable digest of the candidate schema; the candidate's identity. */
  candidateDigest: string;
  baselineSchema: JsonSchema;
  candidateSchema: JsonSchema;
  compat: CompatReport;
  state: 'OPEN' | 'SUPERSEDED' | 'APPROVED' | 'REJECTED';
  seq: number;
  submittedAt: number;
  submittedBy: string;
  /** Set once the proposal is decided; null while OPEN/SUPERSEDED. */
  decisionId: string | null;
  /**
   * The proposal this one succeeds, if it was created as a correction of an
   * earlier candidate for the same subject. null for the first proposal in a
   * lineage. This is the explicit lineage link; the successor always carries a
   * fresh candidate digest and starts with no inherited evidence or waivers.
   */
  predecessorId: string | null;
}

export interface EvidenceRecord {
  reportId: string;
  proposalId: string;
  subjectId: string;
  /** The candidate digest the agent claims to have validated against. */
  targetDigest: string;
  consumerId: string;
  verdict: Verdict;
  producedAt: number;
  receivedAt: number;
  detail: string | null;
  /**
   * Whether this report currently counts toward its proposal's gate. Reports
   * naming a non-current candidate, or arriving after the proposal was
   * decided/superseded, are stored (for causal history) but not applied.
   */
  applied: boolean;
  /** Why a report was not applied, for explainability. */
  ignoredReason: string | null;
}

export interface DecisionRecord {
  decisionId: string;
  proposalId: string;
  subjectId: string;
  candidateDigest: string;
  type: DecisionType;
  /** The environment this decision was made for. */
  environment: Environment;
  /** Evidence fingerprint the decision was bound to at decision time. */
  evidenceFingerprint: string;
  /** Immutable snapshot of the gate evaluation when the decision was made. */
  gateSnapshot: GateEvaluation;
  decidedAt: number;
  decidedBy: string;
  note: string | null;
}

/**
 * A time-limited, scoped, dual-controlled waiver.
 *
 * A waiver is requested by one reviewer and only becomes ACTIVE once a second,
 * distinct reviewer confirms it. Its scope is immutable and narrow: it can only
 * ever cover the named (candidateDigest, consumerId, environment,
 * compatDirection). It carries an explicit expiry; once expired or revoked it
 * is terminal and never re-enters gate evaluation. The record retains the full
 * lifecycle (who requested/confirmed/rejected/revoked, and why it ended) for
 * the audit chain.
 */
export interface WaiverRecord {
  waiverId: string;
  subjectId: string;
  candidateDigest: string;
  consumerId: string;
  environment: Environment;
  compatDirection: CompatDirection;
  status: WaiverStatus;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  /** Absolute logical time the waiver expires. */
  expiresAt: number;
  /** The second reviewer who confirmed it (null until ACTIVE). */
  confirmedBy: string | null;
  confirmedAt: number | null;
  /** Reviewer who rejected/revoked it (null otherwise). */
  closedBy: string | null;
  closedAt: number | null;
  /** Human-readable reason a waiver stopped participating. */
  endReason: string | null;
}

/** Append-only causal event, for explainable history and recovery. */
export interface EventRecord {
  seq: number;
  at: number;
  type: string;
  subjectId: string | null;
  proposalId: string | null;
  payload: unknown;
}

/**
 * A staged rollout of an approved candidate. Bound to exactly one APPROVE
 * decision snapshot (decisionId + proposalId + candidateDigest +
 * evidenceFingerprint + environment). A ROLLBACK rollout points a deployment
 * at a prior known-good digest; it is deployment-only and never rewrites the
 * original contract decision.
 */
export interface RolloutRecord {
  rolloutId: string;
  subjectId: string;
  environment: Environment;
  kind: RolloutKind;
  /** The decision this rollout deploys (RELEASE) — null for a ROLLBACK. */
  decisionId: string | null;
  proposalId: string | null;
  candidateDigest: string;
  /** The bound decision fingerprint receipts must match (ROLLBACK: the target's). */
  evidenceFingerprint: string;
  status: RolloutStatus;
  createdAt: number;
  createdBy: string;
  /** For a ROLLBACK: the rollout it superseded and the digest it reverted to. */
  supersedesRolloutId: string | null;
  note: string | null;
}

export interface WaveRecord {
  waveId: string;
  rolloutId: string;
  ordinal: number;
  name: string;
  status: WaveStatus;
  /** Bumped on retry; only receipts for the live attempt advance the wave. */
  attempt: number;
  startedAt: number | null;
  settledAt: number | null;
}

/** A receipt from a deployment adapter for a wave attempt. */
export interface ReceiptRecord {
  receiptId: string;
  rolloutId: string;
  waveId: string;
  attempt: number;
  result: ReceiptResult;
  evidenceFingerprint: string;
  receivedAt: number;
  detail: string | null;
  /** Whether this receipt advanced the current wave attempt. */
  applied: boolean;
  /** Why a receipt was not applied (duplicate / stale / mismatch). */
  ignoredReason: string | null;
}

export interface Repository {
  // --- subjects ---
  upsertSubject(rec: SubjectRecord): void;
  getSubject(subjectId: string): SubjectRecord | undefined;
  listSubjects(): SubjectRecord[];

  // --- proposals ---
  insertProposal(rec: ProposalRecord): void;
  getProposal(proposalId: string): ProposalRecord | undefined;
  getProposalByDigest(subjectId: string, candidateDigest: string): ProposalRecord | undefined;
  /** The single OPEN proposal for a subject, if any. */
  getOpenProposal(subjectId: string): ProposalRecord | undefined;
  listProposals(subjectId: string): ProposalRecord[];
  /** Mark the currently-open proposal for a subject as superseded. */
  markSuperseded(proposalId: string, at: number): void;

  // --- evidence ---
  getEvidence(reportId: string): EvidenceRecord | undefined;
  insertEvidence(rec: EvidenceRecord): void;
  listEvidenceForProposal(proposalId: string): EvidenceRecord[];
  listAppliedEvidence(proposalId: string): EvidenceRecord[];

  // --- decisions ---
  getDecision(decisionId: string): DecisionRecord | undefined;
  getDecisionForProposal(proposalId: string): DecisionRecord | undefined;
  /**
   * Atomically record a decision for a proposal and close the proposal.
   * Returns false if the proposal was no longer OPEN (someone else decided
   * first), giving us compare-and-set semantics for concurrent approvals.
   */
  commitDecision(rec: DecisionRecord): boolean;

  // --- waivers ---
  insertWaiver(rec: WaiverRecord): void;
  getWaiver(waiverId: string): WaiverRecord | undefined;
  /** All waivers for a candidate digest (any status), for audit/read models. */
  listWaiversForCandidate(subjectId: string, candidateDigest: string): WaiverRecord[];
  /** All currently-ACTIVE waivers for a candidate (status only; expiry handled by caller). */
  listActiveWaivers(subjectId: string, candidateDigest: string): WaiverRecord[];
  /**
   * Confirm a REQUESTED waiver, transitioning it to ACTIVE, only if it is still
   * REQUESTED. Returns false on a lost race / wrong state — compare-and-set for
   * dual control. The confirming reviewer must differ from the requester; that
   * check is enforced by the service before calling.
   */
  confirmWaiver(waiverId: string, confirmedBy: string, at: number): boolean;
  /** Reject a REQUESTED waiver (terminal). Returns false if not REQUESTED. */
  rejectWaiver(waiverId: string, rejectedBy: string, at: number, reason: string): boolean;
  /** Revoke an ACTIVE waiver (terminal). Returns false if not ACTIVE. */
  revokeWaiver(waiverId: string, revokedBy: string, at: number, reason: string): boolean;
  /**
   * Mark ACTIVE waivers whose expiry has passed as EXPIRED, appending an audit
   * event for each. Returns the ids expired. Idempotent: only ACTIVE rows are
   * touched, so re-running never double-expires.
   */
  expireWaivers(now: number): string[];
  /**
   * Lapse every REQUESTED or ACTIVE waiver scoped to a candidate, marking them
   * LAPSED with an audit event. Used when a proposal is replaced by a successor:
   * waivers fall away with the old candidate by their exact scope and are never
   * inherited. Returns the ids lapsed. Idempotent for already-terminal rows.
   */
  lapseWaiversForCandidate(subjectId: string, candidateDigest: string, at: number, reason: string): string[];

  // --- rollouts / waves / receipts ---
  /** Insert a rollout and its ordered waves atomically. */
  insertRollout(rollout: RolloutRecord, waves: WaveRecord[]): void;
  getRollout(rolloutId: string): RolloutRecord | undefined;
  listRollouts(subjectId: string): RolloutRecord[];
  /** The non-terminal rollout for a (subject, environment), if any. */
  getActiveRollout(subjectId: string, environment: Environment): RolloutRecord | undefined;
  listWaves(rolloutId: string): WaveRecord[];
  getWave(waveId: string): WaveRecord | undefined;
  getReceipt(receiptId: string): ReceiptRecord | undefined;
  listReceipts(rolloutId: string): ReceiptRecord[];
  /**
   * Set a rollout's status only if it is currently one of `fromStatuses`
   * (compare-and-set). Returns false on a lost race / wrong state. Appends an
   * audit event with `eventType` when it succeeds.
   */
  setRolloutStatus(
    rolloutId: string,
    fromStatuses: RolloutStatus[],
    toStatus: RolloutStatus,
    at: number,
    eventType: string,
    payload: unknown
  ): boolean;
  /**
   * Start the next PENDING wave (lowest ordinal) of an IN_PROGRESS/PENDING
   * rollout, moving the rollout to IN_PROGRESS and the wave to IN_PROGRESS.
   * Returns the started wave, or undefined if none is startable.
   */
  startNextWave(rolloutId: string, at: number): WaveRecord | undefined;
  /**
   * Record a receipt idempotently and, if it is decisive for the current wave
   * attempt, settle that wave (and complete/keep the rollout). All in one
   * transaction. The classification decision is passed in by the caller (pure
   * domain), so this method only persists and applies it. Returns the stored
   * receipt record.
   */
  applyReceipt(
    receipt: ReceiptRecord,
    settle: { waveId: string; toStatus: WaveStatus; rolloutToStatus: RolloutStatus | null } | null,
    at: number
  ): ReceiptRecord;
  /**
   * Bump a wave's attempt (retry) only if the rollout is PAUSED or the wave is
   * FAILED/IN_PROGRESS, moving the wave back to IN_PROGRESS and the rollout to
   * IN_PROGRESS. Older-attempt receipts thereby become stale. Returns the new
   * attempt number, or undefined if not retryable.
   */
  retryWave(rolloutId: string, waveId: string, at: number): number | undefined;

  // --- events / causal log ---
  appendEvent(type: string, at: number, ids: { subjectId?: string | null; proposalId?: string | null }, payload: unknown): number;
  listEvents(sinceSeq?: number): EventRecord[];
  /** Run a set of mutations atomically. */
  transaction<T>(fn: () => T): T;

  close(): void;
}
