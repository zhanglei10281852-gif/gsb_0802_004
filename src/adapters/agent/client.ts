/**
 * Minimal typed HTTP client for the control center API, used by the agent
 * simulator and the e2e harness. Uses the global fetch shipped with Node 20+.
 * It exposes the control plane too, so scenarios can drive logical time and
 * arm fault points against a real running server.
 */
export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export class ControlCenterClient {
  constructor(private readonly baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    return { status: res.status, body: parsed as T };
  }

  health() {
    return this.req('GET', '/api/health');
  }

  registerSubject(input: { subjectId: string; requiredConsumers: string[]; freshnessWindowMs: number }) {
    return this.req('POST', '/api/subjects', input);
  }

  submitCandidate(subjectId: string, input: { baselineSchema: unknown; candidateSchema: unknown; submittedBy: string; expectedPredecessorId?: string }) {
    return this.req<{ proposalId: string; candidateDigest: string; compat: any; deduplicated: boolean; predecessorId: string | null }>(
      'POST',
      `/api/subjects/${encodeURIComponent(subjectId)}/candidates`,
      input
    );
  }

  reportEvidence(input: {
    reportId: string;
    subjectId: string;
    targetDigest: string;
    consumerId: string;
    verdict: 'PASS' | 'FAIL';
    producedAt: number;
    detail?: string;
  }) {
    return this.req<{ status: string; reason?: string; note?: string }>('POST', '/api/evidence', input);
  }

  decide(
    proposalId: string,
    input: { expectedDigest: string; expectedFingerprint?: string; environment?: string; type: 'APPROVE' | 'REJECT'; decidedBy: string; note?: string }
  ) {
    return this.req<{ status: string; reason?: string; decision?: any }>(
      'POST',
      `/api/proposals/${encodeURIComponent(proposalId)}/decision`,
      input
    );
  }

  getProposal(proposalId: string) {
    return this.req<any>('GET', `/api/proposals/${encodeURIComponent(proposalId)}`);
  }

  // --- waivers ---
  requestWaiver(input: {
    subjectId: string;
    candidateDigest: string;
    consumerId: string;
    environment?: string;
    compatDirection: 'COMPATIBLE' | 'BREAKING' | 'UNKNOWN';
    reason: string;
    requestedBy: string;
    ttlMs: number;
  }) {
    return this.req<{ status: string; reason?: string; waiver?: any }>('POST', '/api/waivers', input);
  }

  confirmWaiver(waiverId: string, confirmedBy: string) {
    return this.req<{ status: string; reason?: string; waiver?: any }>(
      'POST',
      `/api/waivers/${encodeURIComponent(waiverId)}/confirm`,
      { confirmedBy }
    );
  }

  rejectWaiver(waiverId: string, rejectedBy: string, reason: string) {
    return this.req<{ status: string; reason?: string; waiver?: any }>(
      'POST',
      `/api/waivers/${encodeURIComponent(waiverId)}/reject`,
      { rejectedBy, reason }
    );
  }

  revokeWaiver(waiverId: string, revokedBy: string, reason: string) {
    return this.req<{ status: string; reason?: string; waiver?: any }>(
      'POST',
      `/api/waivers/${encodeURIComponent(waiverId)}/revoke`,
      { revokedBy, reason }
    );
  }

  getWaiver(waiverId: string) {
    return this.req<any>('GET', `/api/waivers/${encodeURIComponent(waiverId)}`);
  }

  snapshot() {
    return this.req<any>('GET', '/api/snapshot');
  }

  events(since = 0) {
    return this.req<{ events: any[] }>('GET', `/api/events?since=${since}`);
  }

  // --- control plane ---
  clockAdvance(deltaMs: number) {
    return this.req<{ now: number }>('POST', '/api/control/clock/advance', { deltaMs });
  }

  clockSet(ms: number) {
    return this.req<{ now: number }>('POST', '/api/control/clock/set', { ms });
  }

  clockNow() {
    return this.req<{ now: number }>('GET', '/api/control/clock');
  }

  armFault(point: string, times = 1) {
    return this.req('POST', '/api/control/faults/arm', { point, times });
  }

  disarmFault(point: string) {
    return this.req('POST', '/api/control/faults/disarm', { point });
  }
}
