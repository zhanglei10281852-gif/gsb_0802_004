import type {
  ConsumerId,
  ConsumerRef,
  EvidenceRecord,
  RequiredConsumerAddition,
  StoredProposal,
  StoredRollout,
} from './types.js';

export interface CoverageGap {
  consumerId: ConsumerId;
  reason: 'no-evidence' | 'not-pass' | 'stale';
}

/**
 * Required consumers are the union of the consumers captured at decision time
 * (`snapshotConsumers`) and any post-decision additions that have not yet been
 * re-verified. The decision snapshot itself is never mutated.
 */
export function snapshotConsumers(proposal: StoredProposal): ConsumerRef[] {
  return proposal.consumers;
}

export function addedConsumers(
  additions: RequiredConsumerAddition[],
): RequiredConsumerAddition[] {
  return additions;
}

export function requiredConsumers(
  proposal: StoredProposal,
  additions: RequiredConsumerAddition[],
): ConsumerRef[] {
  const out = new Map<ConsumerId, ConsumerRef>();
  for (const c of proposal.consumers) out.set(c.consumerId, c);
  for (const a of additions) out.set(a.consumerId, { consumerId: a.consumerId, schema: a.schema });
  return [...out.values()];
}

function latestEvidence(
  evidence: EvidenceRecord[],
  consumerId: ConsumerId,
): EvidenceRecord | undefined {
  let best: EvidenceRecord | undefined;
  for (const e of evidence) {
    if (e.consumerId !== consumerId) continue;
    if (!best || e.receivedAt > best.receivedAt) best = e;
  }
  return best;
}

/**
 * Compute coverage gaps for a candidate digest. A gap exists when a required
 * consumer has no fresh PASS evidence against that digest. Evidence is keyed by
 * BOTH proposal_id and candidate digest via the evidence rows, so an older
 * candidate's evidence never covers a new one.
 */
export function computeCoverageGaps(
  proposal: StoredProposal,
  additions: RequiredConsumerAddition[],
  evidence: EvidenceRecord[],
  now: number,
  ttlMs: number,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const required = requiredConsumers(proposal, additions);
  for (const c of required) {
    const ev = latestEvidence(evidence, c.consumerId);
    if (!ev) {
      gaps.push({ consumerId: c.consumerId, reason: 'no-evidence' });
      continue;
    }
    if (ev.status !== 'pass') {
      gaps.push({ consumerId: c.consumerId, reason: 'not-pass' });
      continue;
    }
    if (now - ev.receivedAt > ttlMs) {
      gaps.push({ consumerId: c.consumerId, reason: 'stale' });
    }
  }
  return gaps;
}

export function gapConsumerIds(gaps: CoverageGap[]): ConsumerId[] {
  return gaps.map((g) => g.consumerId);
}

/**
 * A rollout must auto-pause when there is a coverage gap and the rollout is
 * active. The currently deploying wave is allowed to finish (its receipt is
 * recorded deterministically), but it cannot advance to a later wave or
 * complete while the gap remains. Pending later waves stay pending until
 * re-verification concludes.
 */
export function shouldAutoPauseForGap(
  rollout: StoredRollout,
  gaps: CoverageGap[],
): boolean {
  if (rollout.status !== 'active') return false;
  return gaps.length > 0;
}

/**
 * Apply a coverage gap to a rollout purely: mark it paused with reason
 * `topology-gap`. The current deploying wave is left deploying; pending later
 * waves stay pending. The gap list is recorded for causal display.
 */
export function applyGapPause(
  rollout: StoredRollout,
  gaps: CoverageGap[],
  now: number,
): StoredRollout {
  if (!shouldAutoPauseForGap(rollout, gaps)) return rollout;
  return {
    ...rollout,
    status: 'paused',
    pausedAt: now,
    pauseReason: 'topology-gap',
    gapConsumerIds: gapConsumerIds(gaps),
  };
}

/**
 * Resume a rollout only when all gaps are closed. Operator-initiated resume of a
 * `topology-gap` pause is rejected until re-verification concludes. This keeps
 * the causal basis explicit.
 */
export function canResume(
  rollout: StoredRollout,
  gaps: CoverageGap[],
  by: 'operator' | 'system',
): boolean {
  if (rollout.status !== 'paused') return false;
  if (rollout.pauseReason === 'topology-gap') {
    return gaps.length === 0;
  }
  return by === 'operator';
}

export function resumeAfterReverification(
  rollout: StoredRollout,
  gaps: CoverageGap[],
  now: number,
): StoredRollout | null {
  if (gaps.length > 0) return null;
  if (rollout.status !== 'paused') return null;
  if (rollout.pauseReason !== 'topology-gap') return null;
  const next: StoredRollout = { ...rollout, status: 'active', pausedAt: null, pauseReason: null, gapConsumerIds: [] };
  const current = next.waves.find((w) => w.sequence === next.currentWaveSequence);
  if (current && current.status === 'succeeded') {
    const nxt = next.waves.find((w) => w.sequence === current.sequence + 1);
    if (nxt) {
      nxt.status = 'deploying';
      nxt.attempts = 1;
      nxt.startedAt = now;
      next.currentWaveSequence = nxt.sequence;
    } else {
      next.status = 'completed';
      next.finishedAt = now;
    }
  } else if (current && current.status === 'pending') {
    current.status = 'deploying';
    current.attempts = 1;
    current.startedAt = now;
  }
  return next;
}
