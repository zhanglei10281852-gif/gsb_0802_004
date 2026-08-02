import type {
  ExemptionRecord,
  GateView,
  StoredProposal,
  StoredRollout,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listProposals(): Promise<{ proposals: StoredProposal[] }> {
    return fetch("/api/proposals").then((r) => json(r));
  },
  getGateView(id: string, environment?: string): Promise<GateView> {
    const qs = environment
      ? `?environment=${encodeURIComponent(environment)}`
      : "";
    return fetch(`/api/proposals/${encodeURIComponent(id)}${qs}`).then((r) =>
      json(r),
    );
  },
  createProposal(body: unknown): Promise<StoredProposal> {
    return fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r));
  },
  createSuccessor(
    predecessorId: string,
    body: {
      candidate: unknown;
      author: string;
      ttlMs?: number;
      note?: string;
    },
  ): Promise<{ predecessor: StoredProposal; successor: StoredProposal }> {
    return fetch(
      `/api/proposals/${encodeURIComponent(predecessorId)}/successor`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).then((r) => json(r));
  },
  addRequiredConsumer(
    proposalId: string,
    body: {
      consumerId: string;
      addedBy: string;
      reason: string;
    },
  ): Promise<{
    proposal: StoredProposal;
    pausedRollouts: string[];
    gapConsumerIds: string[];
  }> {
    return fetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/required-consumers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).then((r) => json(r));
  },
  decide(
    id: string,
    kind: "approve" | "reject",
    decider: string,
    rationale: string,
    environment?: string,
  ): Promise<StoredProposal> {
    return fetch(`/api/proposals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, decider, rationale, environment }),
    }).then((r) => json(r));
  },
  requestExemption(
    proposalId: string,
    body: unknown,
  ): Promise<ExemptionRecord> {
    return fetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).then((r) => json(r));
  },
  reviewExemption(
    proposalId: string,
    exemptionId: string,
    body: { reviewer: string; approved: boolean; comment: string },
  ): Promise<ExemptionRecord> {
    return fetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions/${encodeURIComponent(exemptionId)}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ).then((r) => json(r));
  },
  revokeExemption(
    proposalId: string,
    exemptionId: string,
    revokedBy: string,
  ): Promise<ExemptionRecord> {
    return fetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/exemptions/${encodeURIComponent(exemptionId)}/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revokedBy }),
      },
    ).then((r) => json(r));
  },
  createRollout(
    proposalId: string,
    body: {
      owner: string;
      waves: { environment: string; adapter: string }[];
      previousVersion?: string;
      note?: string;
      autoStart?: boolean;
    },
  ): Promise<{ rollout: StoredRollout; proposal: StoredProposal }> {
    return fetch(`/api/proposals/${encodeURIComponent(proposalId)}/rollouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r));
  },
  getRollout(rolloutId: string): Promise<StoredRollout> {
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}`).then((r) =>
      json(r),
    );
  },
  startRollout(rolloutId: string): Promise<StoredRollout> {
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}/start`, {
      method: "POST",
    }).then((r) => json(r));
  },
  pauseRollout(rolloutId: string, pausedBy: string): Promise<StoredRollout> {
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pausedBy }),
    }).then((r) => json(r));
  },
  resumeRollout(rolloutId: string, resumedBy: string): Promise<StoredRollout> {
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumedBy }),
    }).then((r) => json(r));
  },
  retryWave(
    rolloutId: string,
    waveSequence: number,
    retriedBy: string,
  ): Promise<StoredRollout> {
    return fetch(
      `/api/rollouts/${encodeURIComponent(rolloutId)}/waves/${waveSequence}/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retriedBy }),
      },
    ).then((r) => json(r));
  },
  rollbackRollout(
    rolloutId: string,
    rolledBackBy: string,
    note: string,
  ): Promise<StoredRollout> {
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rolledBackBy, note }),
    }).then((r) => json(r));
  },
  reportReceipt(
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
    return fetch(`/api/rollouts/${encodeURIComponent(rolloutId)}/receipts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    }).then((r) => json(r));
  },
};

export function connectEvents(
  onEvent: (event: { id: number; type: string; data: unknown }) => void,
  onStateChange: (state: EventSourceState) => void,
  lastEventId: number,
): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let currentId = lastEventId;

  const connect = () => {
    if (stopped) return;
    const url = `/api/events?after=${currentId}`;
    es = new EventSource(url);
    onStateChange("connecting");

    es.onopen = () => onStateChange("open");
    es.onmessage = (ev) => {
      const id = Number(ev.lastEventId);
      if (!Number.isNaN(id)) currentId = id;
      onEvent({ id, type: "message", data: safeParse(ev.data) });
    };
    es.addEventListener("proposal-created", handler("proposal-created"));
    es.addEventListener("evidence-accepted", handler("evidence-accepted"));
    es.addEventListener("evidence-rejected", handler("evidence-rejected"));
    es.addEventListener("gate-advanced", handler("gate-advanced"));
    es.addEventListener("decision-recorded", handler("decision-recorded"));
    es.addEventListener("proposal-superseded", handler("proposal-superseded"));
    es.addEventListener("exemption-requested", handler("exemption-requested"));
    es.addEventListener("exemption-approved", handler("exemption-approved"));
    es.addEventListener("exemption-rejected", handler("exemption-rejected"));
    es.addEventListener("exemption-revoked", handler("exemption-revoked"));
    es.addEventListener("rollout-created", handler("rollout-created"));
    es.addEventListener("rollout-started", handler("rollout-started"));
    es.addEventListener("rollout-paused", handler("rollout-paused"));
    es.addEventListener("rollout-resumed", handler("rollout-resumed"));
    es.addEventListener("rollout-completed", handler("rollout-completed"));
    es.addEventListener("rollout-failed", handler("rollout-failed"));
    es.addEventListener("wave-deploying", handler("wave-deploying"));
    es.addEventListener("wave-result", handler("wave-result"));
    es.addEventListener("wave-retried", handler("wave-retried"));
    es.addEventListener("receipt-rejected", handler("receipt-rejected"));
    es.addEventListener("rollout-rolled-back", handler("rollout-rolled-back"));
    es.addEventListener("topology-changed", handler("topology-changed"));
    es.addEventListener(
      "reverification-concluded",
      handler("reverification-concluded"),
    );

    es.onerror = () => {
      onStateChange("reconnecting");
      es?.close();
      es = null;
      retryTimer = setTimeout(connect, 1500);
    };
  };

  function handler(type: string) {
    return (ev: MessageEvent) => {
      const id = Number(ev.lastEventId);
      if (!Number.isNaN(id)) currentId = id;
      onEvent({ id, type, data: safeParse(ev.data) });
    };
  }

  connect();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export type EventSourceState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";
