export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type EvidenceVerdict = 'compatible' | 'incompatible' | 'error';
export type ExemptionStatus = 'pending' | 'active' | 'rejected' | 'revoked' | 'expired' | 'voided';
export type ExemptionDirection = 'compatible' | 'incompatible';

export interface CompatibilityIssue {
  code: string;
  message: string;
  path: string;
}

export interface CompatibilityResult {
  compatible: boolean;
  issues: CompatibilityIssue[];
}

export interface Consumer {
  id: string;
  name: string;
  registeredAt: number;
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

export interface ProposalLineage {
  rootId: string;
  revision: number;
  parentProposalId: string | null;
  replacesCandidateHash: string | null;
  successorIds: string[];
}

export interface Decision {
  id: string;
  proposalId: string;
  decision: 'approved' | 'rejected';
  reason: string;
  snapshot: {
    proposal: Proposal;
    evidence: EvidenceRecord[];
    requiredConsumerIds: string[];
    missingConsumerIds: string[];
    exemptedConsumerIds: string[];
    appliedExemptions: Array<{
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
    }>;
    gateReady: boolean;
    blockingReasons: string[];
    systemCompatibility: CompatibilityResult;
  };
  decidedAt: number;
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

export interface Snapshot {
  consumers: Consumer[];
  exemptions: Exemption[];
  proposals: ProposalDetail[];
}

export interface CausalEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  clock: number;
  recordedAt: number;
}

export type WaveStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'paused' | 'rolled_back';
export type RolloutStatus = 'not_started' | 'in_progress' | 'paused' | 'succeeded' | 'failed' | 'rolled_back';
export type ReceiptResult = 'success' | 'failure' | 'unknown';

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

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  snapshot: () => jsonRequest<Snapshot>('/api/snapshot'),
  proposal: (id: string) => jsonRequest<ProposalDetail>(`/api/proposals/${id}`),
  createProposal: (candidateSchema: unknown, baselineSchema: unknown, environment: string) =>
    jsonRequest<{ proposal: Proposal; duplicate: boolean }>('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ candidateSchema, baselineSchema, environment }),
    }),
  createSuccessor: (parentId: string, candidateSchema: unknown) =>
    jsonRequest<{ successor: Proposal; superseded: Proposal; duplicate: boolean }>(
      `/api/proposals/${parentId}/successor`,
      {
        method: 'POST',
        body: JSON.stringify({ candidateSchema }),
      },
    ),
  registerConsumer: (id: string, name: string) =>
    jsonRequest<{ consumer: Consumer }>('/api/consumers', {
      method: 'POST',
      body: JSON.stringify({ id, name }),
    }),
  decide: (id: string, action: 'approve' | 'reject', reason: string) =>
    jsonRequest<{ decision: Decision }>(`/api/proposals/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    }),
  exemptions: (candidateHash?: string) =>
    jsonRequest<{ exemptions: Exemption[] }>(
      candidateHash ? `/api/exemptions?candidateHash=${encodeURIComponent(candidateHash)}` : '/api/exemptions',
    ),
  requestExemption: (body: {
    candidateHash: string;
    consumerId: string;
    environment: string;
    direction: ExemptionDirection;
    reason: string;
    requesterId: string;
    validFrom: number;
    validUntil: number;
  }) =>
    jsonRequest<{ exemption: Exemption }>('/api/exemptions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  confirmExemption: (id: string, confirmerId: string) =>
    jsonRequest<{ exemption: Exemption }>(`/api/exemptions/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ confirmerId }),
    }),
  rejectExemption: (id: string, reviewerId: string, note: string) =>
    jsonRequest<{ exemption: Exemption }>(`/api/exemptions/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reviewerId, note }),
    }),
  revokeExemption: (id: string, reviewerId: string, note: string) =>
    jsonRequest<{ exemption: Exemption }>(`/api/exemptions/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reviewerId, note }),
    }),
  causalEvents: () => jsonRequest<{ events: CausalEvent[] }>('/api/causal-events'),
  startRollout: (proposalId: string, waves: Array<{ sequence: number; environment: string }>, previousVersion: string | null) =>
    jsonRequest<{ rollout: Rollout }>(`/api/proposals/${proposalId}/rollout`, {
      method: 'POST',
      body: JSON.stringify({ waves, previousVersion }),
    }),
  reportReceipt: (
    rolloutId: string,
    body: { sequence: number; result: ReceiptResult; adapterId: string; idempotencyKey: string; message?: string },
  ) =>
    jsonRequest<{ receipt: unknown; rollout: Rollout; duplicate: boolean }>(`/api/rollouts/${rolloutId}/receipt`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pauseRollout: (rolloutId: string, reason: string) =>
    jsonRequest<{ rollout: Rollout }>(`/api/rollouts/${rolloutId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resumeRollout: (rolloutId: string) =>
    jsonRequest<{ rollout: Rollout }>(`/api/rollouts/${rolloutId}/resume`, { method: 'POST' }),
  retryWave: (rolloutId: string, sequence: number) =>
    jsonRequest<{ rollout: Rollout }>(`/api/rollouts/${rolloutId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ sequence }),
    }),
  rollbackRollout: (rolloutId: string, targetVersion: string, reason: string) =>
    jsonRequest<{ rollout: Rollout }>(`/api/rollouts/${rolloutId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ targetVersion, reason }),
    }),
};

export function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}
