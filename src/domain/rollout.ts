/**
 * Pure staged-rollout domain.
 *
 * Once a candidate has passed the gate and been APPROVED for an environment,
 * the release owner drives its deployment through a rollout: a sequence of
 * continuous waves for that environment. A deployment adapter reports a receipt
 * per wave attempt (SUCCESS / FAILURE / UNKNOWN). This module holds the pure,
 * IO-free rules for how receipts advance a rollout — no storage, no clock, no
 * framework. The application service layers persistence, idempotency, and the
 * decision/successor binding on top.
 *
 * The central safety property lives in `classifyReceipt`: a receipt only moves
 * a rollout when it names the exact wave attempt that is currently in
 * progress AND matches the rollout's bound decision fingerprint. Everything
 * else — a duplicate, an out-of-order/stale receipt, a receipt for an old
 * attempt, or one whose fingerprint no longer matches — is inert. That is what
 * makes repeated and reordered receipts safe and stops a receipt from
 * advancing a rollout bound to a different decision snapshot or successor.
 */

/** Outcome a deployment adapter reports for a wave attempt. */
export type ReceiptResult = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

/** Lifecycle of a single wave within a rollout. */
export type WaveStatus =
  | 'PENDING' // not started yet
  | 'IN_PROGRESS' // current wave, awaiting a decisive receipt
  | 'SUCCEEDED' // a SUCCESS receipt for the current attempt landed
  | 'FAILED'; // a FAILURE receipt for the current attempt landed

/** Lifecycle of a rollout. */
export type RolloutStatus =
  | 'PENDING' // created, no wave started
  | 'IN_PROGRESS' // a wave is currently deploying
  | 'PAUSED' // owner paused; no wave advances until resumed
  | 'COMPLETED' // all waves succeeded
  | 'FAILED' // a wave failed and was not retried/rolled back
  | 'ROLLED_BACK'; // superseded by a rollback deployment

/** Why a rollout exists: a forward release, or a rollback to a prior version. */
export type RolloutKind = 'RELEASE' | 'ROLLBACK';

/**
 * Lifecycle of a re-validation opened when the dependency topology changes
 * mid-rollout (a new consumer becomes required). It is a traceable conclusion
 * about whether the *already-deployed* candidate still covers every required
 * consumer under the new topology — it never touches the immutable contract
 * decision.
 *  - OPEN:     a coverage gap exists; the rollout is auto-held.
 *  - RESOLVED: an owner concluded it (see RevalidationResolution).
 */
export type RevalidationStatus = 'OPEN' | 'RESOLVED';

/**
 * How a re-validation was concluded.
 *  - RESUMED: the gap was covered (new consumer has fresh PASS / a waiver), so
 *    the held rollout was resumed.
 *  - HELD:    the owner chose to keep the rollout paused despite (or because of)
 *    the gap; the conclusion is recorded for traceability.
 */
export type RevalidationResolution = 'RESUMED' | 'HELD';

/**
 * Consumers newly present in `after` but absent from `before` — i.e. the
 * dependency-topology growth that can open a coverage gap for an in-flight
 * rollout. Pure and order-preserving (returns them in `after`'s order).
 */
export function newlyRequiredConsumers(before: readonly string[], after: readonly string[]): string[] {
  const prev = new Set(before);
  return after.filter((c) => !prev.has(c));
}

/**
 * The immutable identity a rollout is bound to. A rollout is tied to exactly
 * one approved decision snapshot (and thus one proposal/candidate/environment).
 * Receipts must carry a matching fingerprint to have any effect; because a
 * successor proposal has its own decision with its own fingerprint, a receipt
 * can never cross rollouts.
 */
export interface RolloutBinding {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly evidenceFingerprint: string;
  readonly environment: string;
}

/** Minimal wave view the pure classifier needs. */
export interface WaveView {
  readonly waveId: string;
  readonly ordinal: number;
  readonly status: WaveStatus;
  /** The attempt number currently live for this wave (bumped on retry). */
  readonly attempt: number;
}

/** Minimal rollout view the pure classifier needs. */
export interface RolloutView {
  readonly rolloutId: string;
  readonly status: RolloutStatus;
  readonly binding: RolloutBinding;
  readonly waves: readonly WaveView[];
}

/** An incoming receipt, as named by the deployment adapter. */
export interface IncomingReceipt {
  readonly rolloutId: string;
  readonly waveId: string;
  readonly attempt: number;
  readonly result: ReceiptResult;
  /** Fingerprint the adapter believes it is deploying. */
  readonly evidenceFingerprint: string;
  readonly detail?: string;
}

/** How a receipt should be handled after classification. */
export type ReceiptDisposition =
  | { kind: 'ADVANCE'; result: ReceiptResult } // decisive for the current wave attempt
  | { kind: 'IGNORE'; reason: string }; // inert: duplicate / stale / mismatched

/**
 * Decide what an incoming receipt does, given the rollout's current state.
 * Pure and total. The service still enforces idempotency by report id at the
 * storage layer; this function decides whether a *first-seen* receipt is
 * decisive for the current wave attempt.
 */
export function classifyReceipt(rollout: RolloutView, receipt: IncomingReceipt): ReceiptDisposition {
  if (rollout.status === 'PAUSED') {
    return { kind: 'IGNORE', reason: 'rollout is paused; no wave advances until resumed' };
  }
  if (rollout.status !== 'IN_PROGRESS') {
    return { kind: 'IGNORE', reason: `rollout is ${rollout.status}; no wave is in progress` };
  }

  // The receipt must match the decision snapshot this rollout is bound to.
  if (receipt.evidenceFingerprint !== rollout.binding.evidenceFingerprint) {
    return {
      kind: 'IGNORE',
      reason: `receipt fingerprint does not match the rollout's bound decision (${short(receipt.evidenceFingerprint)} != ${short(rollout.binding.evidenceFingerprint)})`
    };
  }

  const current = rollout.waves.find((w) => w.status === 'IN_PROGRESS');
  if (!current) {
    return { kind: 'IGNORE', reason: 'no wave is currently in progress' };
  }
  if (receipt.waveId !== current.waveId) {
    return {
      kind: 'IGNORE',
      reason: `receipt targets wave ${receipt.waveId}, but the current wave is ${current.waveId}`
    };
  }
  // Only the live attempt counts. A receipt for a superseded attempt (before a
  // retry bumped the counter) or a future attempt is inert — this is what makes
  // reordered / stale receipts safe.
  if (receipt.attempt !== current.attempt) {
    return {
      kind: 'IGNORE',
      reason: `receipt is for attempt ${receipt.attempt}, current attempt is ${current.attempt}`
    };
  }

  return { kind: 'ADVANCE', result: receipt.result };
}

/**
 * Given a decisive receipt result, compute the wave's next status. UNKNOWN is
 * deliberately non-decisive: it leaves the wave IN_PROGRESS (the adapter could
 * not determine the outcome, so the owner must retry or wait for a definitive
 * receipt).
 */
export function nextWaveStatus(result: ReceiptResult): WaveStatus {
  switch (result) {
    case 'SUCCESS':
      return 'SUCCEEDED';
    case 'FAILURE':
      return 'FAILED';
    case 'UNKNOWN':
      return 'IN_PROGRESS';
  }
}

function short(fp: string): string {
  return fp.length > 14 ? `${fp.slice(0, 14)}…` : fp;
}
