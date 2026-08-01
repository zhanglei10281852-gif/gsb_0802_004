export type JsonSchema = Record<string, unknown>;

export type ConsumerId = string;
export type ProposalId = string;
export type EvidenceId = string;

export type EvidenceStatus = "pass" | "fail" | "error";

export type ProposalStatus =
  | "open"
  | "collecting"
  | "ready"
  | "approved"
  | "rejected"
  | "superseded";

export type DecisionKind = "approve" | "reject";

export interface ConsumerRef {
  consumerId: ConsumerId;
  schema: JsonSchema;
}

export interface ProposalInput {
  topic: string;
  baseline: JsonSchema;
  candidate: JsonSchema;
  consumers: ConsumerRef[];
  author: string;
  ttlMs: number;
}

export interface SuccessorInput {
  candidate: JsonSchema;
  author: string;
  ttlMs?: number;
  note?: string;
}

export interface LineageLink {
  predecessorId: ProposalId | null;
  successorId: ProposalId | null;
  supersededAt: number | null;
  supersededBy: string | null;
  note: string | null;
}

export interface StoredProposal {
  proposalId: ProposalId;
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

export interface CompatibilityViolation {
  path: string;
  kind:
    | "required-property-removed"
    | "type-narrowed-incompatibly"
    | "enum-narrowed"
    | "property-added-required"
    | "format-removed"
    | "minimum-raised"
    | "maximum-lowered"
    | "min-length-raised"
    | "max-length-lowered"
    | "additional-properties-restricted";
  message: string;
}

export interface CompatibilityReport {
  compatible: boolean;
  violations: CompatibilityViolation[];
  comparedAt: number;
  baselineDigest: string;
  candidateDigest: string;
}

export interface EvidenceRecord {
  evidenceId: EvidenceId;
  proposalId: ProposalId;
  candidateDigest: string;
  consumerId: ConsumerId;
  status: EvidenceStatus;
  detail: string;
  reportedAt: number;
  receivedAt: number;
  idempotencyKey: string;
  agentRunId: string;
}

export type ExemptionId = string;
export type ExemptionDirection = "backward" | "forward" | "both";
export type ExemptionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export interface ExemptionRequest {
  proposalId: ProposalId;
  consumerId: ConsumerId;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  expiresAt: number;
}

export interface ExemptionReview {
  reviewer: string;
  reviewedAt: number;
  approved: boolean;
  comment: string;
}

export interface ExemptionRecord {
  exemptionId: ExemptionId;
  proposalId: ProposalId;
  candidateDigest: string;
  consumerId: ConsumerId;
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
  exemptionId: ExemptionId;
  consumerId: ConsumerId;
  environment: string;
  direction: ExemptionDirection;
  requestedBy: string;
  reviewers: string[];
  expiresAt: number;
  reason: string;
}

export interface DecisionSnapshot {
  proposalId: ProposalId;
  candidateDigest: string;
  kind: DecisionKind;
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

export interface GateView {
  proposal: StoredProposal;
  evidence: EvidenceRecord[];
  blockers: Blocker[];
  evidenceFreshness: Record<ConsumerId, FreshnessInfo>;
  exemptions: ExemptionRecord[];
  appliedExemptions: AppliedExemption[];
  environment: string;
  eventLog: CausalEvent[];
}

export interface Blocker {
  code:
    | "incompatible-schema"
    | "missing-evidence"
    | "failing-evidence"
    | "stale-evidence"
    | "already-decided"
    | "candidate-mismatch";
  message: string;
  consumerId?: ConsumerId;
  exemptedBy?: ExemptionId;
}

export interface FreshnessInfo {
  status: "fresh" | "stale" | "missing";
  receivedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
}

export type CausalEvent =
  | ProposalCreatedEvent
  | EvidenceAcceptedEvent
  | EvidenceRejectedEvent
  | GateAdvancedEvent
  | DecisionRecordedEvent
  | ProposalSupersededEvent
  | ExemptionRequestedEvent
  | ExemptionApprovedEvent
  | ExemptionRejectedEvent
  | ExemptionRevokedEvent;

export interface BaseEvent {
  eventId: number;
  proposalId: ProposalId;
  occurredAt: number;
  eventType: string;
  prevHash: string;
  hash: string;
  payload: unknown;
}

export interface ProposalCreatedEvent extends BaseEvent {
  eventType: "proposal-created";
  payload: {
    topic: string;
    candidateDigest: string;
    baselineDigest: string;
    author: string;
  };
}

export interface EvidenceAcceptedEvent extends BaseEvent {
  eventType: "evidence-accepted";
  payload: {
    evidenceId: EvidenceId;
    candidateDigest: string;
    consumerId: ConsumerId;
    status: EvidenceStatus;
    idempotencyKey: string;
  };
}

export interface EvidenceRejectedEvent extends BaseEvent {
  eventType: "evidence-rejected";
  payload: {
    reason:
      | "duplicate-idempotency-key"
      | "candidate-mismatch"
      | "unknown-consumer"
      | "proposal-decided"
      | "proposal-superseded"
      | "invalid-payload";
    candidateDigest?: string;
    consumerId?: ConsumerId;
    idempotencyKey?: string;
    successorId?: ProposalId;
  };
}

export interface GateAdvancedEvent extends BaseEvent {
  eventType: "gate-advanced";
  payload: {
    fromStatus: ProposalStatus;
    toStatus: ProposalStatus;
    blockers: Blocker[];
  };
}

export interface DecisionRecordedEvent extends BaseEvent {
  eventType: "decision-recorded";
  payload: {
    kind: DecisionKind;
    candidateDigest: string;
    decider: string;
    lastEventId: number;
    appliedExemptionIds: ExemptionId[];
  };
}

export interface ProposalSupersededEvent extends BaseEvent {
  eventType: "proposal-superseded";
  payload: {
    predecessorId: ProposalId;
    successorId: ProposalId;
    candidateDigest: string;
    supersededBy: string;
    note: string | null;
  };
}

export interface ExemptionRequestedEvent extends BaseEvent {
  eventType: "exemption-requested";
  payload: {
    exemptionId: ExemptionId;
    candidateDigest: string;
    consumerId: ConsumerId;
    environment: string;
    direction: ExemptionDirection;
    requestedBy: string;
    expiresAt: number;
    reason: string;
  };
}

export interface ExemptionApprovedEvent extends BaseEvent {
  eventType: "exemption-approved";
  payload: {
    exemptionId: ExemptionId;
    reviewer: string;
    approvalCount: number;
    requiredApprovals: number;
    active: boolean;
  };
}

export interface ExemptionRejectedEvent extends BaseEvent {
  eventType: "exemption-rejected";
  payload: {
    exemptionId: ExemptionId;
    reviewer: string;
    comment: string;
  };
}

export interface ExemptionRevokedEvent extends BaseEvent {
  eventType: "exemption-revoked";
  payload: {
    exemptionId: ExemptionId;
    revokedBy: string;
    reason: string;
  };
}
