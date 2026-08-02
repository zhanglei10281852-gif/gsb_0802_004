export type Verdict = 'pass' | 'fail';

export interface CompatFinding {
  path: string;
  rule: string;
  message: string;
  breaking: boolean;
}

export interface CompatResult {
  status: 'compatible' | 'breaking';
  findings: CompatFinding[];
}

export interface EvidenceRecord {
  id: number;
  proposalId: string;
  consumerId: string;
  candidateDigest: string;
  verdict: Verdict;
  runId: string;
  idempotencyKey: string;
  details?: unknown;
  recordedAt: number;
  appliesToCurrent: boolean;
}

export interface Blocker {
  code: 'missing_evidence' | 'stale_evidence' | 'failed_evidence' | 'breaking_compat';
  consumer?: string;
  message: string;
}

export interface WaivedBlocker extends Blocker {
  exemptionId: string;
  confirmedBy: string[];
}

export interface GateResult {
  status: 'ready' | 'blocked';
  blockers: Blocker[];
  waived: WaivedBlocker[];
}

export type ExemptionDirection = 'backward' | 'forward';
export type ExemptionStoredStatus = 'pending' | 'active' | 'rejected' | 'revoked';
export type ExemptionStatus = ExemptionStoredStatus | 'expired';

export interface ExemptionConfirmation {
  by: string;
  at: number;
}

export interface ExemptionView {
  id: string;
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  ttlMs: number;
  expiresAt: number;
  status: ExemptionStoredStatus;
  effectiveStatus: ExemptionStatus;
  confirmations: ExemptionConfirmation[];
  rejectedBy: string | null;
  rejectedAt: number | null;
  rejectReason: string | null;
  revokedBy: string | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface Decision {
  id: string;
  proposalId: string;
  action: 'approve' | 'reject';
  decidedBy: string;
  rationale: string | null;
  decidedAt: number;
  snapshot: unknown;
}

export interface DomainEvent {
  id: number;
  ts: number;
  proposalId: string;
  type: string;
  payload: unknown;
}

export type RolloutStatus = 'active' | 'paused' | 'completed' | 'rolled_back';
export type PauseReason = 'manual' | 'wave_failed' | 'wave_unknown' | 'coverage_gap';
export type WaveStatus = 'pending' | 'deploying' | 'succeeded' | 'failed' | 'unknown' | 'rolled_back';
export type ReceiptResult = 'success' | 'failure' | 'unknown';
export type ReceiptOutcome = 'applied' | 'duplicate' | 'stale_decision' | 'stale_wave' | 'paused' | 'closed';

export interface Wave {
  id: string;
  rolloutId: string;
  ordinal: number;
  name: string;
  environment: string;
  status: WaveStatus;
  retryCount: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Receipt {
  id: number;
  rolloutId: string;
  waveId: string;
  decisionId: string;
  result: ReceiptResult;
  receiptKey: string;
  detail?: unknown;
  receivedAt: number;
  applied: boolean;
  outcome: ReceiptOutcome;
}

export interface RolloutDetail {
  id: string;
  proposalId: string;
  decisionId: string;
  candidateDigest: string;
  status: RolloutStatus;
  pausedReason: PauseReason | null;
  currentOrdinal: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  rolledBackTo: number | null;
  rollbackReason: string | null;
  rolledBackBy: string | null;
  rolledBackAt: number | null;
  waves: Wave[];
  receipts: Receipt[];
}

export type RevalidationStatus = 'pending' | 'passed' | 'failed';

export interface Revalidation {
  id: string;
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  status: RevalidationStatus;
  reason: string | null;
  addedBy: string;
  addedAt: number;
  concludedAt: number | null;
  verdict: Verdict | null;
  evidenceKey: string | null;
}

export interface CoverageGapRevalidation {
  consumerId: string;
  status: RevalidationStatus;
}

export interface ProposalDetail {
  id: string;
  title: string;
  status: 'open' | 'approved' | 'rejected' | 'superseded';
  version: number;
  predecessorId: string | null;
  supersededById: string | null;
  baselineDigest: string;
  candidateDigest: string;
  baseline: unknown;
  candidate: unknown;
  compat: CompatResult;
  consumers: string[];
  evidenceTtlMs: number;
  environment: string;
  createdAt: number;
  updatedAt: number;
  evidence: EvidenceRecord[];
  gate: GateResult;
  exemptions: ExemptionView[];
  decision: Decision | null;
  rollout: RolloutDetail | null;
  revalidations: Revalidation[];
  events: DomainEvent[];
}

export interface Snapshot {
  serverTime: number;
  eventCursor: number;
  proposals: ProposalDetail[];
}

export interface CreateProposalBody {
  title: string;
  createdBy?: string;
  baseline: unknown;
  candidate: unknown;
  consumers: string[];
  evidenceTtlMs?: number;
  environment?: string;
}

export interface CreateExemptionBody {
  consumerId: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  ttlMs: number;
  environment?: string;
}

export interface ConfirmExemptionBody {
  by: string;
}

export interface RejectExemptionBody {
  by: string;
  reason?: string;
}

export interface RevokeExemptionBody {
  by: string;
  reason?: string;
}

export interface SubmitRevisionBody {
  candidate: unknown;
  expectedVersion: number;
}

export interface SubmitDecisionBody {
  action: 'approve' | 'reject';
  decidedBy: string;
  expectedVersion: number;
  rationale?: string;
  acknowledgeBreaking?: boolean;
}

export interface CreateSuccessorBody {
  candidate: unknown;
  title?: string;
  consumers?: string[];
  environment?: string;
  evidenceTtlMs?: number;
  reason?: string;
  createdBy?: string;
}

export interface CreateRolloutBody {
  waves: { name: string; environment: string }[];
  createdBy: string;
}

export interface RolloutActionBody {
  by: string;
}

export interface RollbackRolloutBody {
  toWaveOrdinal: number;
  by: string;
  reason?: string;
}

export interface RecordReceiptBody {
  waveId: string;
  decisionId: string;
  result: ReceiptResult;
  receiptKey: string;
  detail?: unknown;
}

export interface RecordReceiptResponse {
  outcome: ReceiptOutcome;
  receipt: Receipt;
}

export interface AddDependencyBody {
  consumerId: string;
  by: string;
  reason?: string;
}

export type RevalidationOutcome = 'concluded' | 'duplicate' | 'closed';

export interface ConcludeRevalidationBody {
  verdict: Verdict;
  runId: string;
  idempotencyKey: string;
  by?: string;
}

export interface ConcludeRevalidationResponse {
  outcome: RevalidationOutcome;
  revalidation: Revalidation;
}

interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
    details?: { blockers?: Blocker[]; revalidations?: CoverageGapRevalidation[] };
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`请求失败（HTTP ${status}）`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get errorCode(): string | null {
    const shape = this.body as ApiErrorShape | null;
    return shape && shape.error && typeof shape.error.code === 'string' ? shape.error.code : null;
  }

  get errorMessage(): string | null {
    const shape = this.body as ApiErrorShape | null;
    return shape && shape.error && typeof shape.error.message === 'string' ? shape.error.message : null;
  }

  get blockers(): Blocker[] {
    const shape = this.body as ApiErrorShape | null;
    const blockers = shape && shape.error && shape.error.details ? shape.error.details.blockers : undefined;
    return Array.isArray(blockers) ? blockers : [];
  }

  get coverageGapRevalidations(): CoverageGapRevalidation[] {
    const shape = this.body as ApiErrorShape | null;
    const list = shape && shape.error && shape.error.details ? shape.error.details.revalidations : undefined;
    return Array.isArray(list) ? list : [];
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export function fetchSnapshot(): Promise<Snapshot> {
  return request<Snapshot>('/api/snapshot');
}

export function createProposal(body: CreateProposalBody): Promise<ProposalDetail> {
  return request<ProposalDetail>('/api/proposals', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function submitRevision(id: string, body: SubmitRevisionBody): Promise<ProposalDetail> {
  return request<ProposalDetail>(`/api/proposals/${encodeURIComponent(id)}/revisions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function submitDecision(id: string, body: SubmitDecisionBody): Promise<{ decision: Decision }> {
  return request<{ decision: Decision }>(`/api/proposals/${encodeURIComponent(id)}/decisions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createSuccessor(id: string, body: CreateSuccessorBody): Promise<ProposalDetail> {
  return request<ProposalDetail>(`/api/proposals/${encodeURIComponent(id)}/successors`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function addDependency(proposalId: string, body: AddDependencyBody): Promise<ProposalDetail> {
  return request<ProposalDetail>(`/api/proposals/${encodeURIComponent(proposalId)}/dependencies`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function concludeRevalidation(
  id: string,
  body: ConcludeRevalidationBody,
): Promise<ConcludeRevalidationResponse> {
  return request<ConcludeRevalidationResponse>(`/api/revalidations/${encodeURIComponent(id)}/conclude`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createExemption(proposalId: string, body: CreateExemptionBody): Promise<ExemptionView> {
  return request<ExemptionView>(`/api/proposals/${encodeURIComponent(proposalId)}/exemptions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function confirmExemption(id: string, body: ConfirmExemptionBody): Promise<ExemptionView> {
  return request<ExemptionView>(`/api/exemptions/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function rejectExemption(id: string, body: RejectExemptionBody): Promise<ExemptionView> {
  return request<ExemptionView>(`/api/exemptions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function revokeExemption(id: string, body: RevokeExemptionBody): Promise<ExemptionView> {
  return request<ExemptionView>(`/api/exemptions/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createRollout(proposalId: string, body: CreateRolloutBody): Promise<RolloutDetail> {
  return request<RolloutDetail>(`/api/proposals/${encodeURIComponent(proposalId)}/rollouts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchRollout(id: string): Promise<RolloutDetail> {
  return request<RolloutDetail>(`/api/rollouts/${encodeURIComponent(id)}`);
}

export function pauseRollout(id: string, body: RolloutActionBody): Promise<RolloutDetail> {
  return request<RolloutDetail>(`/api/rollouts/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function resumeRollout(id: string, body: RolloutActionBody): Promise<RolloutDetail> {
  return request<RolloutDetail>(`/api/rollouts/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function retryWave(id: string, waveId: string, body: RolloutActionBody): Promise<RolloutDetail> {
  return request<RolloutDetail>(
    `/api/rollouts/${encodeURIComponent(id)}/waves/${encodeURIComponent(waveId)}/retry`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export function rollbackRollout(id: string, body: RollbackRolloutBody): Promise<RolloutDetail> {
  return request<RolloutDetail>(`/api/rollouts/${encodeURIComponent(id)}/rollback`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function recordReceipt(id: string, body: RecordReceiptBody): Promise<RecordReceiptResponse> {
  return request<RecordReceiptResponse>(`/api/rollouts/${encodeURIComponent(id)}/receipts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
