/**
 * Typed client for the workbench. The workbench reads a single consistent
 * snapshot from the server (built from durable storage), so a browser refresh
 * or reconnect always yields the same authoritative view rather than replaying
 * in-process events.
 */
export interface GateConsumer {
  consumerId: string;
  status: 'MISSING' | 'STALE' | 'PASS' | 'FAIL';
  reportId?: string;
  producedAt?: number;
  ageMs?: number;
  detail?: string;
}

export interface Gate {
  status: 'COLLECTING' | 'BLOCKED' | 'READY';
  canApprove: boolean;
  consumers: GateConsumer[];
  blockingReasons: string[];
  advisories: string[];
  evidenceFingerprint: string;
}

export interface ProposalView {
  proposal: {
    proposalId: string;
    subjectId: string;
    candidateDigest: string;
    compat: { result: string; changes: Array<{ path: string; kind: string; detail: string }> };
    state: string;
    seq: number;
    submittedAt: number;
    submittedBy: string;
  };
  gate: Gate;
  decision: null | {
    decisionId: string;
    type: string;
    evidenceFingerprint: string;
    decidedAt: number;
    decidedBy: string;
    note: string | null;
  };
}

export interface Snapshot {
  at: number;
  eventSeq: number;
  subjects: Array<{
    subject: { subjectId: string; requiredConsumers: string[]; freshnessWindowMs: number };
    current: ProposalView | null;
    history: Array<{ proposalId: string; digest: string; state: string; seq: number; decision: any }>;
  }>;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('/api/snapshot');
  return res.json();
}

export async function fetchEvents(since = 0): Promise<{ events: any[] }> {
  const res = await fetch(`/api/events?since=${since}`);
  return res.json();
}

export async function decide(
  proposalId: string,
  input: { expectedDigest: string; expectedFingerprint?: string; type: 'APPROVE' | 'REJECT'; decidedBy: string; note?: string }
): Promise<{ status: number; body: any }> {
  const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  return { status: res.status, body: await res.json() };
}
