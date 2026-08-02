/**
 * Typed client for the workbench. The workbench reads a single consistent
 * snapshot from the server (built from durable storage), so a browser refresh
 * or reconnect always yields the same authoritative view rather than replaying
 * in-process events.
 */
export interface GateConsumer {
  consumerId: string;
  status: 'MISSING' | 'STALE' | 'PASS' | 'FAIL' | 'WAIVED';
  reportId?: string;
  producedAt?: number;
  ageMs?: number;
  detail?: string;
  waiverId?: string;
  waiverExpiresAt?: number;
}

export interface Gate {
  status: 'COLLECTING' | 'BLOCKED' | 'READY';
  canApprove: boolean;
  consumers: GateConsumer[];
  blockingReasons: string[];
  advisories: string[];
  environment: string;
  appliedWaivers: Array<{ waiverId: string; scope: WaiverScope; expiresAt: number }>;
  evidenceFingerprint: string;
}

export interface WaiverScope {
  candidateDigest: string;
  consumerId: string;
  environment: string;
  compatDirection: string;
}

export interface Waiver {
  waiverId: string;
  subjectId: string;
  candidateDigest: string;
  consumerId: string;
  environment: string;
  compatDirection: string;
  status: 'REQUESTED' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED' | 'LAPSED';
  reason: string;
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  confirmedBy: string | null;
  confirmedAt: number | null;
  closedBy: string | null;
  closedAt: number | null;
  endReason: string | null;
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
    environment: string;
    evidenceFingerprint: string;
    decidedAt: number;
    decidedBy: string;
    note: string | null;
    gateSnapshot: Gate;
  };
  waivers: Waiver[];
  lineage: {
    predecessorId: string | null;
    predecessorDigest: string | null;
    successorId: string | null;
    successorDigest: string | null;
  };
}

export interface Rollout {
  rolloutId: string;
  subjectId: string;
  environment: string;
  kind: 'RELEASE' | 'ROLLBACK';
  decisionId: string | null;
  proposalId: string | null;
  candidateDigest: string;
  evidenceFingerprint: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ROLLED_BACK';
  createdAt: number;
  createdBy: string;
  supersedesRolloutId: string | null;
  note: string | null;
}

export interface Wave {
  waveId: string;
  rolloutId: string;
  ordinal: number;
  name: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
  attempt: number;
  startedAt: number | null;
  settledAt: number | null;
}

export interface Receipt {
  receiptId: string;
  rolloutId: string;
  waveId: string;
  attempt: number;
  result: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  evidenceFingerprint: string;
  receivedAt: number;
  detail: string | null;
  applied: boolean;
  ignoredReason: string | null;
}

export interface RolloutDetail {
  rollout: Rollout;
  waves: Wave[];
  receipts: Receipt[];
}

export interface Snapshot {
  at: number;
  environment: string;
  eventSeq: number;
  subjects: Array<{
    subject: { subjectId: string; requiredConsumers: string[]; freshnessWindowMs: number };
    current: ProposalView | null;
    history: Array<{ proposalId: string; digest: string; state: string; seq: number; predecessorId: string | null; decision: any }>;
    rollouts: RolloutDetail[];
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
  input: { expectedDigest: string; expectedFingerprint?: string; environment?: string; type: 'APPROVE' | 'REJECT'; decidedBy: string; note?: string }
): Promise<{ status: number; body: any }> {
  const res = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

export function requestWaiver(input: {
  subjectId: string;
  candidateDigest: string;
  consumerId: string;
  environment: string;
  compatDirection: string;
  reason: string;
  requestedBy: string;
  ttlMs: number;
}) {
  return post('/api/waivers', input);
}

export function confirmWaiver(waiverId: string, confirmedBy: string) {
  return post(`/api/waivers/${encodeURIComponent(waiverId)}/confirm`, { confirmedBy });
}

export function rejectWaiver(waiverId: string, rejectedBy: string, reason: string) {
  return post(`/api/waivers/${encodeURIComponent(waiverId)}/reject`, { rejectedBy, reason });
}

export function revokeWaiver(waiverId: string, revokedBy: string, reason: string) {
  return post(`/api/waivers/${encodeURIComponent(waiverId)}/revoke`, { revokedBy, reason });
}

// --- rollouts ---
export function createRollout(input: { decisionId: string; waves: string[]; createdBy: string; note?: string }) {
  return post('/api/rollouts', input);
}

export function startNextWave(rolloutId: string) {
  return post(`/api/rollouts/${encodeURIComponent(rolloutId)}/start-wave`, {});
}

export function pauseRollout(rolloutId: string) {
  return post(`/api/rollouts/${encodeURIComponent(rolloutId)}/pause`, {});
}

export function resumeRollout(rolloutId: string) {
  return post(`/api/rollouts/${encodeURIComponent(rolloutId)}/resume`, {});
}

export function retryWave(rolloutId: string, waveId: string) {
  return post(`/api/rollouts/${encodeURIComponent(rolloutId)}/waves/${encodeURIComponent(waveId)}/retry`, {});
}

export function rollback(input: { subjectId: string; environment: string; targetDigest: string; waves: string[]; createdBy: string; note?: string }) {
  return post('/api/rollbacks', input);
}
