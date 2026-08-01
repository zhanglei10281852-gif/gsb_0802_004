export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export type EvidenceVerdict = 'compatible' | 'incompatible' | 'error';

export type ExemptionStatus = 'pending' | 'active' | 'rejected' | 'revoked' | 'expired';

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

export type CausalEventType =
  | 'proposal_created'
  | 'consumer_registered'
  | 'evidence_accepted'
  | 'evidence_rejected'
  | 'decision_made'
  | 'exemption_requested'
  | 'exemption_confirmed'
  | 'exemption_rejected'
  | 'exemption_revoked'
  | 'exemption_expired';

export interface CausalEvent {
  id: number;
  type: CausalEventType;
  payload: Record<string, unknown>;
  clock: number;
  recordedAt: number;
}
