import { createHash } from 'node:crypto';
import type {
  AppliedEvidence,
  ConsumerReadiness,
  ConsumerStatus,
  GateEvaluation,
  GateInput,
  GateStatus
} from './types.js';

/**
 * Pure gate evaluation and decision-eligibility state machine.
 *
 * Given the set of required consumers, the evidence currently applied to a
 * candidate, the static compatibility report, and a clock reading, this
 * function derives:
 *
 *   - per-consumer readiness (MISSING / STALE / PASS / FAIL),
 *   - an overall gate status (COLLECTING / BLOCKED / READY),
 *   - whether an APPROVE decision is permitted right now, and
 *   - an evidence fingerprint that binds a decision to the exact evidence it
 *     was based on.
 *
 * The function is pure: it does not read the clock, touch storage, or mutate
 * its inputs. `now` and the freshness window are passed in so timelines are
 * reproducible. This is the single source of truth for "is this candidate
 * safe to release?" and it is deliberately isolated from every adapter.
 *
 * Key rules encoded here:
 *  - Only the newest report per consumer counts. Late/duplicate older reports
 *    for the same consumer never override a newer one (handled by picking the
 *    max producedAt, ties broken by receivedAt).
 *  - Evidence older than the freshness window relative to `now` is STALE and
 *    does not count toward readiness.
 *  - A FAIL from any required consumer blocks approval regardless of others.
 *  - Approval requires every required consumer to be fresh + PASS.
 */
export function evaluateGate(input: GateInput): GateEvaluation {
  const { requiredConsumers, appliedEvidence, compat, now, freshnessWindowMs } = input;

  // Keep only the most authoritative report per consumer: newest producedAt,
  // ties broken by newest receivedAt. Reports for consumers not in the
  // required set are ignored for readiness (they cannot pollute the gate).
  const latestByConsumer = new Map<string, AppliedEvidence>();
  for (const ev of appliedEvidence) {
    const prev = latestByConsumer.get(ev.consumerId);
    if (!prev || isNewer(ev, prev)) {
      latestByConsumer.set(ev.consumerId, ev);
    }
  }

  const consumers: ConsumerReadiness[] = [];
  const blockingReasons: string[] = [];
  let anyFail = false;
  let anyMissingOrStale = false;

  for (const consumerId of requiredConsumers) {
    const ev = latestByConsumer.get(consumerId);
    if (!ev) {
      consumers.push({ consumerId, status: 'MISSING' });
      anyMissingOrStale = true;
      blockingReasons.push(`consumer "${consumerId}" has no evidence for this candidate`);
      continue;
    }

    const ageMs = now - ev.producedAt;
    const isStale = ageMs > freshnessWindowMs;

    let status: ConsumerStatus;
    if (ev.verdict === 'FAIL') {
      status = 'FAIL';
      anyFail = true;
      blockingReasons.push(
        `consumer "${consumerId}" reported FAIL (report ${ev.reportId}${ev.detail ? `: ${ev.detail}` : ''})`
      );
    } else if (isStale) {
      status = 'STALE';
      anyMissingOrStale = true;
      blockingReasons.push(
        `consumer "${consumerId}" evidence is stale (age ${ageMs}ms > ${freshnessWindowMs}ms window)`
      );
    } else {
      status = 'PASS';
    }

    consumers.push({
      consumerId,
      status,
      reportId: ev.reportId,
      producedAt: ev.producedAt,
      ageMs,
      detail: ev.detail
    });
  }

  let status: GateStatus;
  if (anyFail) {
    status = 'BLOCKED';
  } else if (anyMissingOrStale) {
    status = 'COLLECTING';
  } else {
    status = 'READY';
  }

  const advisories: string[] = [];
  if (compat.result === 'BREAKING') {
    advisories.push('static analysis flagged BREAKING changes; approval relies on consumer evidence');
  } else if (compat.result === 'UNKNOWN') {
    advisories.push('static analysis was inconclusive (UNKNOWN); consumer evidence is authoritative');
  }

  const canApprove = status === 'READY';

  return {
    status,
    canApprove,
    consumers,
    blockingReasons,
    advisories,
    evidenceFingerprint: fingerprint(requiredConsumers, latestByConsumer, compat.result)
  };
}

function isNewer(a: AppliedEvidence, b: AppliedEvidence): boolean {
  if (a.producedAt !== b.producedAt) return a.producedAt > b.producedAt;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  // Deterministic final tiebreak so the fingerprint is stable.
  return a.reportId > b.reportId;
}

/**
 * Fingerprint the decision-relevant evidence set. Two evaluations with the
 * same required consumers, the same winning report per consumer, and the same
 * compatibility verdict produce the same fingerprint. A decision stores this
 * value; later-arriving evidence changes the *live* evaluation but cannot
 * retroactively alter what a stored decision was based on.
 */
function fingerprint(
  requiredConsumers: readonly string[],
  latestByConsumer: Map<string, AppliedEvidence>,
  compat: string
): string {
  const parts: string[] = [`compat:${compat}`];
  for (const consumerId of [...requiredConsumers].sort()) {
    const ev = latestByConsumer.get(consumerId);
    if (ev) {
      parts.push(`${consumerId}=${ev.reportId}:${ev.verdict}:${ev.producedAt}`);
    } else {
      parts.push(`${consumerId}=<none>`);
    }
  }
  const hash = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return `sha256:${hash}`;
}
