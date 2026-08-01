import type {
  DecisionSnapshot,
  ReceiptInput,
  ReceiptResult,
  RolloutSnapshot,
  StoredRollout,
  Wave,
  WaveSpec,
  WaveStatus,
} from './types.js';
import { digest, shortDigest } from './digest.js';

export const TERMINAL_ROLLOUT_STATUSES = new Set<StoredRollout['status']>([
  'completed',
  'rolled-back',
  'failed',
]);

export interface RolloutTransition {
  rollout: StoredRollout;
  wave?: Wave;
  receipt?: StoredRollout['receipts'][number];
  effects: string[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildRolloutSnapshot(
  proposalId: string,
  decision: DecisionSnapshot,
): RolloutSnapshot {
  return {
    proposalId,
    candidateDigest: decision.candidateDigest,
    decisionKind: decision.kind,
    decidedAt: decision.decidedAt,
    decider: decision.decider,
    evidenceDigest: decision.evidenceDigest,
    compatibilityDigest: decision.compatibilityDigest,
    exemptionsDigest: decision.exemptionsDigest,
    lastEventId: decision.lastEventId,
  };
}

export function buildWaves(
  rolloutId: string,
  specs: WaveSpec[],
): Wave[] {
  return specs.map((spec, index) => ({
    waveId: `wave-${rolloutId}-${index + 1}`,
    sequence: index + 1,
    environment: spec.environment,
    adapter: spec.adapter,
    status: 'pending' as WaveStatus,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastReceiptId: null,
    lastResult: null,
    lastMessage: null,
    lastReceivedAt: null,
  }));
}

export function rolloutDigest(rollout: {
  proposalId: string;
  owner: string;
  waves: WaveSpec[];
  previousVersion: string | null;
  snapshot: RolloutSnapshot;
}): string {
  return digest({
    proposalId: rollout.proposalId,
    owner: rollout.owner,
    previousVersion: rollout.previousVersion,
    waves: [...rollout.waves]
      .map((w) => ({ environment: w.environment, adapter: w.adapter }))
      .sort((a, b) => a.environment.localeCompare(b.environment)),
    snapshot: rollout.snapshot,
  });
}

export function makeRolloutId(
  topic: string,
  snapshot: RolloutSnapshot,
  owner: string,
  now: number,
): string {
  return `rollout-${topic}-${shortDigest({
    c: snapshot.candidateDigest,
    o: owner,
    t: now,
    n: randomNonce(),
  })}`;
}

function randomNonce(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

export function getCurrentWave(rollout: StoredRollout): Wave | null {
  return rollout.waves.find((w) => w.sequence === rollout.currentWaveSequence) ?? null;
}

export function getWave(
  rollout: StoredRollout,
  sequence: number,
): Wave | null {
  return rollout.waves.find((w) => w.sequence === sequence) ?? null;
}

export function isTerminal(status: StoredRollout['status']): boolean {
  return TERMINAL_ROLLOUT_STATUSES.has(status);
}

export function startRollout(
  rollout: StoredRollout,
  now: number,
): RolloutTransition {
  const next = clone(rollout);
  if (next.status !== 'planned') {
    throw new Error(`cannot start rollout in status ${next.status}`);
  }
  const first = next.waves[0];
  if (!first) throw new Error('rollout has no waves');
  next.status = 'active';
  next.startedAt = now;
  first.status = 'deploying';
  first.attempts = 1;
  first.startedAt = now;
  next.currentWaveSequence = first.sequence;
  return { rollout: next, wave: first, effects: ['rollout-started', 'wave-deploying'] };
}

export function pauseRollout(
  rollout: StoredRollout,
  now: number,
): RolloutTransition {
  const next = clone(rollout);
  if (next.status !== 'active') {
    throw new Error(`cannot pause rollout in status ${next.status}`);
  }
  next.status = 'paused';
  next.pausedAt = now;
  return { rollout: next, effects: ['rollout-paused'] };
}

export function resumeRollout(
  rollout: StoredRollout,
  now: number,
): RolloutTransition {
  const next = clone(rollout);
  if (next.status !== 'paused') {
    throw new Error(`cannot resume rollout in status ${next.status}`);
  }
  next.status = 'active';
  next.pausedAt = null;
  const effects: string[] = ['rollout-resumed'];
  const current = getCurrentWave(next);
  if (current?.status === 'succeeded') {
    const nextWave = next.waves.find((w) => w.sequence === current.sequence + 1);
    if (nextWave) {
      nextWave.status = 'deploying';
      nextWave.attempts = 1;
      nextWave.startedAt = now;
      next.currentWaveSequence = nextWave.sequence;
      effects.push('wave-deploying');
    } else {
      next.status = 'completed';
      next.finishedAt = now;
      effects.push('rollout-completed');
    }
  }
  return { rollout: next, wave: current ?? undefined, effects };
}

export function retryWave(
  rollout: StoredRollout,
  waveSequence: number,
  retriedBy: string,
  now: number,
): RolloutTransition {
  const next = clone(rollout);
  if (next.status === 'paused') {
    next.status = 'active';
    next.pausedAt = null;
  }
  if (next.status !== 'active') {
    throw new Error(`cannot retry wave when rollout is ${next.status}`);
  }
  if (waveSequence !== next.currentWaveSequence) {
    throw new Error(
      `only the current wave (${next.currentWaveSequence}) can be retried, got ${waveSequence}`,
    );
  }
  const wave = next.waves.find((w) => w.sequence === waveSequence);
  if (!wave) throw new Error(`unknown wave sequence ${waveSequence}`);
  if (wave.status !== 'failed' && wave.status !== 'unknown') {
    throw new Error(`cannot retry wave in status ${wave.status}`);
  }
  wave.status = 'deploying';
  wave.attempts += 1;
  wave.startedAt = now;
  wave.finishedAt = null;
  wave.lastResult = null;
  wave.lastMessage = null;
  return { rollout: next, wave, effects: ['wave-deploying', 'wave-retried'] };
}

export function rollback(
  rollout: StoredRollout,
  rolledBackBy: string,
  now: number,
  note: string,
): RolloutTransition {
  const next = clone(rollout);
  if (next.status === 'completed' || next.status === 'rolled-back') {
    throw new Error(`cannot rollback a ${next.status} rollout`);
  }
  const current = getCurrentWave(next);
  for (const w of next.waves) {
    if (w.status === 'succeeded' || w.status === 'deploying' || w.status === 'unknown' || w.status === 'failed') {
      if (w.sequence <= next.currentWaveSequence) {
        w.status = 'rolled-back';
        w.finishedAt = now;
      }
    }
  }
  next.status = 'rolled-back';
  next.finishedAt = now;
  next.rollbackTargetWaveId = current?.waveId ?? null;
  next.rolledBackAt = now;
  return { rollout: next, wave: current ?? undefined, effects: ['rollout-rolled-back'] };
}

export interface ReceiptApplication {
  rollout: StoredRollout;
  accepted: boolean;
  deduped: boolean;
  reason?: string;
  receipt?: StoredRollout['receipts'][number];
  wave?: Wave;
  effects: string[];
}

export function applyReceipt(
  rollout: StoredRollout,
  input: ReceiptInput,
  receiptId: string,
  now: number,
): ReceiptApplication {
  if (
    rollout.status !== 'active' &&
    rollout.status !== 'paused'
  ) {
    return {
      rollout,
      accepted: false,
      deduped: false,
      reason: 'rollout-not-active',
      effects: ['receipt-rejected'],
    };
  }
  const wave = getWave(rollout, input.waveSequence);
  if (!wave) {
    return {
      rollout,
      accepted: false,
      deduped: false,
      reason: 'unknown-wave',
      effects: ['receipt-rejected'],
    };
  }
  if (wave.sequence !== rollout.currentWaveSequence) {
    return {
      rollout,
      accepted: false,
      deduped: false,
      reason: 'wave-not-current',
      effects: ['receipt-rejected'],
    };
  }
  if (wave.status !== 'deploying') {
    return {
      rollout,
      accepted: false,
      deduped: false,
      reason: 'wave-not-current',
      effects: ['receipt-rejected'],
    };
  }

  const duplicate = rollout.receipts.find(
    (r) =>
      r.rolloutId === input.rolloutId && r.idempotencyKey === input.idempotencyKey,
  );
  if (duplicate) {
    return {
      rollout,
      accepted: true,
      deduped: true,
      receipt: duplicate,
      wave,
      effects: [],
    };
  }

  const next = clone(rollout);
  const targetWave = next.waves.find((w) => w.sequence === input.waveSequence)!;
  const receipt = {
    receiptId,
    rolloutId: input.rolloutId,
    waveId: targetWave.waveId,
    waveSequence: targetWave.sequence,
    result: input.result,
    message: input.message,
    reportedAt: input.reportedAt,
    receivedAt: now,
    idempotencyKey: input.idempotencyKey,
    adapterRunId: input.adapterRunId,
  };
  next.receipts.push(receipt);
  targetWave.lastReceiptId = receiptId;
  targetWave.lastResult = input.result;
  targetWave.lastMessage = input.message;
  targetWave.lastReceivedAt = now;
  targetWave.finishedAt = now;

  const effects: string[] = ['wave-result'];

  if (next.status === 'paused') {
    if (input.result === 'success') {
      targetWave.status = 'succeeded';
    } else if (input.result === 'failure') {
      targetWave.status = 'failed';
      next.status = 'failed';
      next.finishedAt = now;
      effects.push('rollout-failed');
    } else {
      targetWave.status = 'unknown';
    }
    return {
      rollout: next,
      accepted: true,
      deduped: false,
      receipt,
      wave: targetWave,
      effects,
    };
  }

  if (input.result === 'success') {
    targetWave.status = 'succeeded';
    const nextWave = next.waves.find((w) => w.sequence === targetWave.sequence + 1);
    if (nextWave) {
      nextWave.status = 'deploying';
      nextWave.attempts = 1;
      nextWave.startedAt = now;
      next.currentWaveSequence = nextWave.sequence;
      effects.push('wave-deploying');
    } else {
      next.status = 'completed';
      next.finishedAt = now;
      effects.push('rollout-completed');
    }
  } else if (input.result === 'failure') {
    targetWave.status = 'failed';
    next.status = 'failed';
    next.finishedAt = now;
    effects.push('rollout-failed');
  } else {
    targetWave.status = 'unknown';
  }

  return {
    rollout: next,
    accepted: true,
    deduped: false,
    receipt,
    wave: targetWave,
    effects,
  };
}

export function describeResult(result: ReceiptResult): string {
  switch (result) {
    case 'success':
      return 'deployment succeeded';
    case 'failure':
      return 'deployment failed';
    case 'unknown':
      return 'deployment result unknown; retry or rollback';
  }
}
