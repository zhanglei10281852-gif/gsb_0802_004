export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export type EvidenceVerdict = 'compatible' | 'incompatible' | 'error';

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

export interface Proposal {
  id: string;
  candidateHash: string;
  candidateSchema: Record<string, unknown>;
  baselineSchema: Record<string, unknown>;
  systemCompatibility: CompatibilityResult;
  status: ProposalStatus;
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

export interface DecisionSnapshot {
  proposal: Proposal;
  evidence: EvidenceRecord[];
  requiredConsumerIds: string[];
  missingConsumerIds: string[];
  gateReady: boolean;
  blockingReasons: string[];
  systemCompatibility: CompatibilityResult;
}

export interface ProposalDetail {
  proposal: Proposal;
  evidence: EvidenceRecord[];
  requiredConsumerIds: string[];
  missingConsumerIds: string[];
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

export type CausalEventType =
  | 'proposal_created'
  | 'consumer_registered'
  | 'evidence_accepted'
  | 'evidence_rejected'
  | 'decision_made';

export interface CausalEvent {
  id: number;
  type: CausalEventType;
  payload: Record<string, unknown>;
  clock: number;
  recordedAt: number;
}
