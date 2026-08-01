export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export type EvidenceVerdict = 'compatible' | 'incompatible' | 'error';

export type ExemptionStatus = 'pending' | 'active' | 'rejected' | 'revoked' | 'expired' | 'voided';

export type ExemptionDirection = 'compatible' | 'incompatible';

export interface Consumer {
  id: string;
  name: string;
  registeredAt: number;
}

export interface CompatibilityIssue {
  code: string;
  message: string;
  path: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  issues: CompatibilityIssue[];
}

export interface EvidenceRecord {
  id: string;
  proposalId: string;
  consumerId: string;
  candidateHash: string;
  verdict: EvidenceVerdict;
  details: string;
  idempotencyKey: string;
  recordedAt: number;
  late: boolean;
}

export interface Exemption {
  id: string;
  candidateHash: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requesterId: string;
  confirmerId: string | null;
  status: ExemptionStatus;
  validFrom: number;
  validUntil: number;
  createdAt: number;
  confirmedAt: number | null;
  closedAt: number | null;
  closedBy: string | null;
  closeNote: string | null;
}

export interface Proposal {
  id: string;
  candidateHash: string;
  candidateSchema: Record<string, unknown>;
  baselineSchema: Record<string, unknown>;
  systemCompatibility: CompatibilityResult;
  status: ProposalStatus;
  environment: string;
  createdAt: number;
  parentProposalId: string | null;
  replacesCandidateHash: string | null;
  lineageRootId: string;
  revision: number;
}

export interface Decision {
  id: string;
  proposalId: string;
  decision: 'approved' | 'rejected';
  reason: string;
  snapshot: DecisionSnapshot;
  decidedAt: number;
}

export interface FrozenExemption {
  id: string;
  candidateHash: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requesterId: string;
  confirmerId: string;
  validFrom: number;
  validUntil: number;
  confirmedAt: number;
}

export interface DecisionSnapshot {
  proposal: Proposal;
  evidence: EvidenceRecord[];
  requiredConsumerIds: string[];
  missingConsumerIds: string[];
  exemptedConsumerIds: string[];
  appliedExemptions: FrozenExemption[];
  gateReady: boolean;
  blockingReasons: string[];
  systemCompatibility: CompatibilityResult;
}

export interface ProposalLineage {
  rootId: string;
  revision: number;
  parentProposalId: string | null;
  replacesCandidateHash: string | null;
  successorIds: string[];
}

export interface ProposalDetail {
  proposal: Proposal;
  evidence: EvidenceRecord[];
  exemptions: Exemption[];
  requiredConsumerIds: string[];
  missingConsumerIds: string[];
  exemptedConsumerIds: string[];
  compatibleConsumerIds: string[];
  incompatibleConsumerIds: string[];
  appliedExemptions: Exemption[];
  gateReady: boolean;
  blockingReasons: string[];
  decision: Decision | null;
  lineage: ProposalLineage;
  successors: Proposal[];
  parent: Proposal | null;
  rollout: Rollout | null;
}

export interface EvidenceSubmission {
  proposalId: string;
  consumerId: string;
  candidateHash: string;
  verdict: EvidenceVerdict;
  details: string;
  idempotencyKey: string;
}

export type EvidenceAcceptance =
  | { accepted: true; evidence: EvidenceRecord; deduped: boolean }
  | { accepted: false; reason: string; evidence: EvidenceRecord | null };

export interface ExemptionRequest {
  candidateHash: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requesterId: string;
  validFrom: number;
  validUntil: number;
}

export type WaveStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'paused' | 'rolled_back';

export type RolloutStatus = 'not_started' | 'in_progress' | 'paused' | 'succeeded' | 'failed' | 'rolled_back';

export type ReceiptResult = 'success' | 'failure' | 'unknown';

export interface WaveSpec {
  sequence: number;
  environment: string;
}

export interface Wave {
  id: string;
  rolloutId: string;
  proposalId: string;
  sequence: number;
  environment: string;
  status: WaveStatus;
  startedAt: number | null;
  finishedAt: number | null;
  lastResult: ReceiptResult | null;
  attempts: number;
  lastMessage: string | null;
  lastAdapterId: string | null;
}

export interface Receipt {
  id: string;
  waveId: string;
  proposalId: string;
  candidateHash: string;
  decisionId: string;
  result: ReceiptResult;
  adapterId: string;
  idempotencyKey: string;
  message: string;
  recordedAt: number;
  duplicate: boolean;
}

export interface Rollout {
  id: string;
  proposalId: string;
  candidateHash: string;
  decisionId: string;
  environment: string;
  status: RolloutStatus;
  waves: Wave[];
  previousVersion: string | null;
  rolledBackTo: string | null;
  rolledBackAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type CausalEventType =
  | 'proposal_created'
  | 'proposal_superseded'
  | 'successor_created'
  | 'consumer_registered'
  | 'evidence_accepted'
  | 'evidence_received_late'
  | 'evidence_rejected'
  | 'decision_made'
  | 'exemption_requested'
  | 'exemption_confirmed'
  | 'exemption_rejected'
  | 'exemption_revoked'
  | 'exemption_expired'
  | 'exemption_voided'
  | 'rollout_started'
  | 'wave_started'
  | 'wave_receipt'
  | 'wave_succeeded'
  | 'wave_failed'
  | 'rollout_succeeded'
  | 'rollout_failed'
  | 'rollout_paused'
  | 'rollout_resumed'
  | 'wave_retried'
  | 'rollout_rolled_back';

export interface CausalEvent {
  id: number;
  type: CausalEventType;
  payload: Record<string, unknown>;
  clock: number;
  recordedAt: number;
}
