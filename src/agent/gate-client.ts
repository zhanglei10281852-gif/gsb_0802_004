import type { ExemptionRecord, GateView, StoredProposal } from "../web/types";

export interface ReportEvidenceArgs {
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  status: "pass" | "fail" | "error";
  detail: string;
  reportedAt: number;
  idempotencyKey: string;
  agentRunId: string;
  signal?: AbortSignal;
}

export class GateClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  async createProposal(body: unknown): Promise<StoredProposal> {
    return this.request("POST", "/api/proposals", body);
  }

  async createSuccessor(
    predecessorId: string,
    body: {
      candidate: unknown;
      author: string;
      ttlMs?: number;
      note?: string;
    },
  ): Promise<{ predecessor: StoredProposal; successor: StoredProposal }> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(predecessorId)}/successor`,
      body,
    );
  }

  async getGateView(
    proposalId: string,
    environment?: string,
  ): Promise<GateView> {
    const qs = environment
      ? `?environment=${encodeURIComponent(environment)}`
      : "";
    return this.request(
      "GET",
      `/api/proposals/${encodeURIComponent(proposalId)}${qs}`,
    );
  }

  async requestExemption(
    proposalId: string,
    body: {
      consumerId: string;
      environment: string;
      direction: "backward" | "forward" | "both";
      reason: string;
      requestedBy: string;
      ttlMs: number;
    },
  ): Promise<ExemptionRecord> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions`,
      body,
    );
  }

  async reviewExemption(
    proposalId: string,
    exemptionId: string,
    body: { reviewer: string; approved: boolean; comment: string },
  ): Promise<ExemptionRecord> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions/${encodeURIComponent(exemptionId)}/review`,
      body,
    );
  }

  async revokeExemption(
    proposalId: string,
    exemptionId: string,
    revokedBy: string,
  ): Promise<ExemptionRecord> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions/${encodeURIComponent(exemptionId)}/revoke`,
      { revokedBy },
    );
  }

  async reportEvidence(args: ReportEvidenceArgs): Promise<{
    accepted: boolean;
    deduped: boolean;
    reason?: string;
    proposal: StoredProposal;
  }> {
    const { signal, ...body } = args;
    const res = await fetch(
      new URL(
        `/api/proposals/${encodeURIComponent(args.proposalId)}/evidence`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": args.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    return (await res.json()) as never;
  }

  async decide(
    proposalId: string,
    kind: "approve" | "reject",
    decider: string,
    rationale: string,
    environment?: string,
  ): Promise<StoredProposal> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(proposalId)}/decision`,
      {
        kind,
        decider,
        rationale,
        environment,
      },
    );
  }

  async createRollout(
    proposalId: string,
    body: {
      owner: string;
      waves: { environment: string; adapter: string }[];
      previousVersion?: string;
      note?: string;
      autoStart?: boolean;
    },
  ): Promise<{ rollout: import("../web/types").StoredRollout; proposal: StoredProposal }> {
    return this.request(
      "POST",
      `/api/proposals/${encodeURIComponent(proposalId)}/rollouts`,
      body,
    );
  }

  async getRollout(
    rolloutId: string,
  ): Promise<import("../web/types").StoredRollout> {
    return this.request("GET", `/api/rollouts/${encodeURIComponent(rolloutId)}`);
  }

  async pauseRollout(
    rolloutId: string,
    pausedBy: string,
  ): Promise<import("../web/types").StoredRollout> {
    return this.request(
      "POST",
      `/api/rollouts/${encodeURIComponent(rolloutId)}/pause`,
      { pausedBy },
    );
  }

  async resumeRollout(
    rolloutId: string,
    resumedBy: string,
  ): Promise<import("../web/types").StoredRollout> {
    return this.request(
      "POST",
      `/api/rollouts/${encodeURIComponent(rolloutId)}/resume`,
      { resumedBy },
    );
  }

  async retryWave(
    rolloutId: string,
    waveSequence: number,
    retriedBy: string,
  ): Promise<import("../web/types").StoredRollout> {
    return this.request(
      "POST",
      `/api/rollouts/${encodeURIComponent(rolloutId)}/waves/${waveSequence}/retry`,
      { retriedBy },
    );
  }

  async rollbackRollout(
    rolloutId: string,
    rolledBackBy: string,
    note: string,
  ): Promise<import("../web/types").StoredRollout> {
    return this.request(
      "POST",
      `/api/rollouts/${encodeURIComponent(rolloutId)}/rollback`,
      { rolledBackBy, note },
    );
  }

  async reportReceipt(
    rolloutId: string,
    body: {
      waveSequence: number;
      result: "success" | "failure" | "unknown";
      message: string;
      reportedAt?: number;
      adapterRunId?: string;
      idempotencyKey: string;
    },
  ): Promise<{ accepted: boolean; deduped: boolean; reason?: string }> {
    const { idempotencyKey, ...payload } = body;
    const res = await fetch(
      new URL(
        `/api/rollouts/${encodeURIComponent(rolloutId)}/receipts`,
        this.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      },
    );
    return (await res.json()) as never;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    return (await res.json()) as T;
  }
}
