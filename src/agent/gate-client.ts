import type { GateView, StoredProposal } from '../web/types';

export interface ReportEvidenceArgs {
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  status: 'pass' | 'fail' | 'error';
  detail: string;
  reportedAt: number;
  idempotencyKey: string;
  agentRunId: string;
  signal?: AbortSignal;
}

export class GateClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<unknown> {
    return this.request('GET', '/api/health');
  }

  async createProposal(body: unknown): Promise<StoredProposal> {
    return this.request('POST', '/api/proposals', body);
  }

  async getGateView(proposalId: string): Promise<GateView> {
    return this.request('GET', `/api/proposals/${encodeURIComponent(proposalId)}`);
  }

  async reportEvidence(args: ReportEvidenceArgs): Promise<{ accepted: boolean; deduped: boolean; reason?: string; proposal: StoredProposal }> {
    const { signal, ...body } = args;
    const res = await fetch(new URL(`/api/proposals/${encodeURIComponent(args.proposalId)}/evidence`, this.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': args.idempotencyKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    return (await res.json()) as never;
  }

  async decide(
    proposalId: string,
    kind: 'approve' | 'reject',
    decider: string,
    rationale: string,
  ): Promise<StoredProposal> {
    return this.request('POST', `/api/proposals/${encodeURIComponent(proposalId)}/decision`, {
      kind, decider, rationale,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    return (await res.json()) as T;
  }
}
