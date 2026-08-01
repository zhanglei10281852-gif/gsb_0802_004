import type {
  Blocker,
  CompatibilityReport,
  ConsumerId,
  ConsumerRef,
  EvidenceRecord,
  EvidenceStatus,
  FreshnessInfo,
  ProposalStatus,
  StoredProposal,
} from './types.js';
import type { Clock } from './clock.js';

export const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  open: ['collecting', 'superseded'],
  collecting: ['ready', 'superseded', 'collecting'],
  ready: ['approved', 'rejected', 'collecting', 'superseded'],
  approved: [],
  rejected: [],
  superseded: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ProposalStatus): boolean {
  return status === 'approved' || status === 'rejected' || status === 'superseded';
}

export function latestEvidencePerConsumer(
  evidence: EvidenceRecord[],
): Map<ConsumerId, EvidenceRecord> {
  const map = new Map<ConsumerId, EvidenceRecord>();
  for (const e of evidence) {
    const existing = map.get(e.consumerId);
    if (!existing || e.receivedAt > existing.receivedAt) {
      map.set(e.consumerId, e);
    }
  }
  return map;
}

export function computeFreshness(
  consumers: ConsumerRef[],
  evidence: EvidenceRecord[],
  ttlMs: number,
  clock: Clock,
): Record<ConsumerId, FreshnessInfo> {
  const now = clock.now();
  const latest = latestEvidencePerConsumer(evidence);
  const out: Record<ConsumerId, FreshnessInfo> = {};
  for (const c of consumers) {
    const e = latest.get(c.consumerId);
    if (!e) {
      out[c.consumerId] = { status: 'missing', receivedAt: null, ageMs: null, ttlMs };
      continue;
    }
    const ageMs = now - e.receivedAt;
    out[c.consumerId] = {
      status: ageMs > ttlMs ? 'stale' : 'fresh',
      receivedAt: e.receivedAt,
      ageMs,
      ttlMs,
    };
  }
  return out;
}

export function computeBlockers(
  compatibility: CompatibilityReport,
  consumers: ConsumerRef[],
  evidence: EvidenceRecord[],
  ttlMs: number,
  clock: Clock,
  currentStatus: ProposalStatus,
): Blocker[] {
  const blockers: Blocker[] = [];

  if (isTerminal(currentStatus)) {
    blockers.push({
      code: 'already-decided',
      message: `proposal is already ${currentStatus}`,
    });
    return blockers;
  }

  if (!compatibility.compatible) {
    blockers.push({
      code: 'incompatible-schema',
      message: `${compatibility.violations.length} backward-incompatible change(s) detected`,
    });
  }

  const latest = latestEvidencePerConsumer(evidence);
  for (const c of consumers) {
    const e = latest.get(c.consumerId);
    if (!e) {
      blockers.push({
        code: 'missing-evidence',
        consumerId: c.consumerId,
        message: `no verification evidence from ${c.consumerId}`,
      });
      continue;
    }
    if (e.status === 'fail') {
      blockers.push({
        code: 'failing-evidence',
        consumerId: c.consumerId,
        message: `${c.consumerId} reports FAIL: ${e.detail}`,
      });
    } else if (e.status === 'error') {
      blockers.push({
        code: 'failing-evidence',
        consumerId: c.consumerId,
        message: `${c.consumerId} reports ERROR: ${e.detail}`,
      });
    }
    const age = clock.now() - e.receivedAt;
    if (age > ttlMs) {
      blockers.push({
        code: 'stale-evidence',
        consumerId: c.consumerId,
        message: `evidence from ${c.consumerId} is stale (age ${age}ms > ttl ${ttlMs}ms)`,
      });
    }
  }

  return blockers;
}

export function isReady(blockers: Blocker[]): boolean {
  return blockers.length === 0;
}

export function deriveStatus(
  proposal: StoredProposal,
  evidence: EvidenceRecord[],
  clock: Clock,
): ProposalStatus {
  if (isTerminal(proposal.status)) return proposal.status;
  const blockers = computeBlockers(
    proposal.compatibility,
    proposal.consumers,
    evidence,
    proposal.ttlMs,
    clock,
    proposal.status,
  );
  if (isReady(blockers)) return 'ready';
  if (evidence.length > 0) return 'collecting';
  return proposal.status === 'open' ? 'open' : 'collecting';
}

export function summarizeEvidence(evidence: EvidenceRecord[]): {
  total: number;
  byStatus: Record<EvidenceStatus, number>;
} {
  const byStatus: Record<EvidenceStatus, number> = { pass: 0, fail: 0, error: 0 };
  for (const e of evidence) byStatus[e.status]++;
  return { total: evidence.length, byStatus };
}
