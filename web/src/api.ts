export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type EvidenceVerdict = 'compatible' | 'incompatible' | 'error';

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
  snapshot: {
    proposal: Proposal;
    evidence: EvidenceRecord[];
    requiredConsumerIds: string[];
    missingConsumerIds: string[];
    gateReady: boolean;
    blockingReasons: string[];
    systemCompatibility: CompatibilityResult;
  };
  decidedAt: number;
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

export interface Snapshot {
  consumers: Consumer[];
  proposals: ProposalDetail[];
}

export interface CausalEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  clock: number;
  recordedAt: number;
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
  createProposal: (candidateSchema: unknown, baselineSchema: unknown) =>
    jsonRequest<{ proposal: Proposal; duplicate: boolean }>('/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ candidateSchema, baselineSchema }),
    }),
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
  causalEvents: () => jsonRequest<{ events: CausalEvent[] }>('/api/causal-events'),
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
