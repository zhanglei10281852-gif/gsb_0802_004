export interface JsonSchema {
  [key: string]: unknown;
}

export type ProposalStatus =
  | "open"
  | "collecting"
  | "ready"
  | "approved"
  | "rejected"
  | "superseded";

export type EvidenceStatus = "pass" | "fail" | "error";

export interface CompatibilityViolation {
  path: string;
  kind: string;
  message: string;
}

export interface CompatibilityReport {
  compatible: boolean;
  violations: CompatibilityViolation[];
  comparedAt: number;
  baselineDigest: string;
  candidateDigest: string;
}

export interface ConsumerRef {
  consumerId: string;
  schema: JsonSchema;
}

export interface LineageLink {
  predecessorId: string | null;
  successorId: string | null;
  supersededAt: number | null;
  supersededBy: string | null;
  note: string | null;
}

export interface StoredProposal {
  proposalId: string;
  topic: string;
  baseline: JsonSchema;
  candidate: JsonSchema;
  candidateDigest: string;
  baselineDigest: string;
  compatibility: CompatibilityReport;
  consumers: ConsumerRef[];
  author: string;
  status: ProposalStatus;
  createdAt: number;
  ttlMs: number;
  decidedAt: number | null;
  decision: DecisionSnapshot | null;
  lineage: LineageLink;
}

export interface EvidenceRecord {
  evidenceId: string;
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  status: EvidenceStatus;
  detail: string;
  reportedAt: number;
  receivedAt: number;
  idempotencyKey: string;
  agentRunId: string;
}

export interface Blocker {
  code: string;
  message: string;
  consumerId?: string;
}

export type ExemptionDirection = "backward" | "forward" | "both";
export type ExemptionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export interface ExemptionReview {
  reviewer: string;
  reviewedAt: number;
  approved: boolean;
  comment: string;
}

export interface ExemptionRecord {
  exemptionId: string;
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  status: ExemptionStatus;
  reviews: ExemptionReview[];
  revokedAt: number | null;
  revokedBy: string | null;
}

export interface AppliedExemption {
  exemptionId: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  requestedBy: string;
  reviewers: string[];
  expiresAt: number;
  reason: string;
}

export interface FreshnessInfo {
  status: "fresh" | "stale" | "missing";
  receivedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
}

export interface CausalEvent {
  eventId: number;
  proposalId: string;
  occurredAt: number;
  eventType: string;
  prevHash: string;
  hash: string;
  payload: unknown;
}

export interface GateView {
  proposal: StoredProposal;
  evidence: EvidenceRecord[];
  blockers: Blocker[];
  evidenceFreshness: Record<string, FreshnessInfo>;
  exemptions: ExemptionRecord[];
  appliedExemptions: AppliedExemption[];
  environment: string;
  eventLog: CausalEvent[];
  rollouts: StoredRollout[];
}

export interface DecisionSnapshot {
  proposalId: string;
  candidateDigest: string;
  kind: "approve" | "reject";
  decidedAt: number;
  decider: string;
  rationale: string;
  evidenceDigest: string;
  evidenceCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  compatibilityDigest: string;
  appliedExemptions: AppliedExemption[];
  exemptionsDigest: string;
  proposalSnapshot: {
    topic: string;
    baseline: JsonSchema;
    candidate: JsonSchema;
    consumers: ConsumerRef[];
    compatibility: CompatibilityReport;
    status: ProposalStatus;
  };
  lastEventId: number;
}

export type RolloutStatus =
  | "planned"
  | "active"
  | "paused"
  | "completed"
  | "rolled-back"
  | "failed";

export type WaveStatus =
  | "pending"
  | "deploying"
  | "succeeded"
  | "failed"
  | "unknown"
  | "rolled-back";

export type ReceiptResult = "success" | "failure" | "unknown";

export interface Wave {
  waveId: string;
  sequence: number;
  environment: string;
  adapter: string;
  status: WaveStatus;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastReceiptId: string | null;
  lastResult: ReceiptResult | null;
  lastMessage: string | null;
  lastReceivedAt: number | null;
}

export interface ReceiptRecord {
  receiptId: string;
  rolloutId: string;
  waveId: string;
  waveSequence: number;
  result: ReceiptResult;
  message: string;
  reportedAt: number;
  receivedAt: number;
  idempotencyKey: string;
  adapterRunId: string;
}

export interface RolloutSnapshot {
  proposalId: string;
  candidateDigest: string;
  decisionKind: "approve" | "reject";
  decidedAt: number;
  decider: string;
  evidenceDigest: string;
  compatibilityDigest: string;
  exemptionsDigest: string;
  lastEventId: number;
}

export interface StoredRollout {
  rolloutId: string;
  proposalId: string;
  topic: string;
  status: RolloutStatus;
  owner: string;
  createdAt: number;
  startedAt: number | null;
  pausedAt: number | null;
  finishedAt: number | null;
  currentWaveSequence: number;
  previousVersion: string | null;
  rollbackTargetWaveId: string | null;
  rolledBackAt: number | null;
  note: string | null;
  snapshot: RolloutSnapshot;
  waves: Wave[];
  receipts: ReceiptRecord[];
}
