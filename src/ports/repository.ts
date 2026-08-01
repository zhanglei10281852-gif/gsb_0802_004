import type { CompatReport, DecisionType, GateEvaluation, JsonSchema, Verdict } from '../domain/types.js';

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
  /** Evidence fingerprint the decision was bound to at decision time. */
  evidenceFingerprint: string;
  /** Immutable snapshot of the gate evaluation when the decision was made. */
  gateSnapshot: GateEvaluation;
  decidedAt: number;
  decidedBy: string;
  note: string | null;
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

  // --- events / causal log ---
  appendEvent(type: string, at: number, ids: { subjectId?: string | null; proposalId?: string | null }, payload: unknown): number;
  listEvents(sinceSeq?: number): EventRecord[];

  /** Run a set of mutations atomically. */
  transaction<T>(fn: () => T): T;

  close(): void;
}
