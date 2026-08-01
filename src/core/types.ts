export type JsonSchema = Record<string, unknown>;

export type ConsumerId = string;
export type ProposalId = string;
export type EvidenceId = string;

export type EvidenceStatus = 'pass' | 'fail' | 'error';

export type ProposalStatus =
  | 'open'
  | 'collecting'
  | 'ready'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type DecisionKind = 'approve' | 'reject';

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
}

export interface CompatibilityViolation {
  path: string;
  kind:
    | 'required-property-removed'
    | 'type-narrowed-incompatibly'
    | 'enum-narrowed'
    | 'property-added-required'
    | 'format-removed'
    | 'minimum-raised'
    | 'maximum-lowered'
    | 'min-length-raised'
    | 'max-length-lowered'
    | 'additional-properties-restricted';
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
  eventLog: CausalEvent[];
}

export interface Blocker {
  code:
    | 'incompatible-schema'
    | 'missing-evidence'
    | 'failing-evidence'
    | 'stale-evidence'
    | 'already-decided'
    | 'candidate-mismatch';
  message: string;
  consumerId?: ConsumerId;
}

export interface FreshnessInfo {
  status: 'fresh' | 'stale' | 'missing';
  receivedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
}

export type CausalEvent =
  | ProposalCreatedEvent
  | EvidenceAcceptedEvent
  | EvidenceRejectedEvent
  | GateAdvancedEvent
  | DecisionRecordedEvent;

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
  eventType: 'proposal-created';
  payload: {
    topic: string;
    candidateDigest: string;
    baselineDigest: string;
    author: string;
  };
}

export interface EvidenceAcceptedEvent extends BaseEvent {
  eventType: 'evidence-accepted';
  payload: {
    evidenceId: EvidenceId;
    candidateDigest: string;
    consumerId: ConsumerId;
    status: EvidenceStatus;
    idempotencyKey: string;
  };
}

export interface EvidenceRejectedEvent extends BaseEvent {
  eventType: 'evidence-rejected';
  payload: {
    reason:
      | 'duplicate-idempotency-key'
      | 'candidate-mismatch'
      | 'unknown-consumer'
      | 'proposal-decided'
      | 'invalid-payload';
    candidateDigest?: string;
    consumerId?: ConsumerId;
    idempotencyKey?: string;
  };
}

export interface GateAdvancedEvent extends BaseEvent {
  eventType: 'gate-advanced';
  payload: {
    fromStatus: ProposalStatus;
    toStatus: ProposalStatus;
    blockers: Blocker[];
  };
}

export interface DecisionRecordedEvent extends BaseEvent {
  eventType: 'decision-recorded';
  payload: {
    kind: DecisionKind;
    candidateDigest: string;
    decider: string;
    lastEventId: number;
  };
}
