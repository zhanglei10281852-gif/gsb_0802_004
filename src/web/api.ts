import type { ExemptionRecord, GateView, StoredProposal } from "./types";

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
