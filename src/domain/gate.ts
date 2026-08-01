import { createHash } from 'node:crypto';
import type {
  ActiveWaiver,
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
 * candidate, the static compatibility report, a clock reading, and any active
 * waivers, this function derives:
 *
 *   - per-consumer readiness (MISSING / STALE / PASS / FAIL / WAIVED),
 *   - an overall gate status (COLLECTING / BLOCKED / READY),
 *   - whether an APPROVE decision is permitted right now, and
 *   - an evidence fingerprint that binds a decision to the exact evidence and
 *     waivers it was based on.
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
 *  - Approval requires every required consumer to be fresh + PASS, OR covered
 *    by a matching active waiver (see below).
 *
 * Waiver rules (time-limited exemptions for consumers temporarily offline in a
 * release window):
 *  - A waiver may only cover a consumer that is MISSING or STALE — i.e. the
 *    "temporarily offline / no fresh evidence" case. A real FAIL is a genuine
 *    incompatibility signal and is NEVER masked by a waiver.
 *  - A waiver applies only when its scope names EXACTLY this candidate digest,
 *    this consumer, this environment, and the candidate's actual compatibility
 *    direction. Any mismatch means the waiver does not apply here.
 *  - A waiver must be unexpired relative to `now`. Expired waivers do not
 *    participate; they only produce an explanatory advisory.
 *  The caller is responsible for passing only ACTIVE (dual-confirmed) waivers;
 *  the gate re-checks scope + expiry defensively.
 */
export function evaluateGate(input: GateInput): GateEvaluation {
  const { requiredConsumers, appliedEvidence, compat, now, freshnessWindowMs, candidateDigest, environment, waivers } =
    input;

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
  const advisories: string[] = [];
  const appliedWaivers: ActiveWaiver[] = [];
  let anyFail = false;
  let anyUnsatisfied = false;

  for (const consumerId of requiredConsumers) {
    const ev = latestByConsumer.get(consumerId);

    // FAIL dominates everything and can never be waived.
    if (ev && ev.verdict === 'FAIL') {
      anyFail = true;
      blockingReasons.push(
        `consumer "${consumerId}" reported FAIL (report ${ev.reportId}${ev.detail ? `: ${ev.detail}` : ''}); a FAIL cannot be waived`
      );
      consumers.push({ consumerId, status: 'FAIL', reportId: ev.reportId, producedAt: ev.producedAt, ageMs: now - ev.producedAt, detail: ev.detail });
      continue;
    }

    const missing = !ev;
    const ageMs = ev ? now - ev.producedAt : undefined;
    const isStale = ev ? ageMs! > freshnessWindowMs : false;

    if (ev && !isStale) {
      // Fresh PASS — no waiver needed.
      consumers.push({ consumerId, status: 'PASS', reportId: ev.reportId, producedAt: ev.producedAt, ageMs, detail: ev.detail });
      continue;
    }

    // Consumer is MISSING or STALE. See if a matching, unexpired waiver covers
    // it. Among candidates, prefer the one expiring latest (most grace).
    const waiver = pickWaiver(waivers, candidateDigest, consumerId, environment, compat.result, now);
    if (waiver) {
      appliedWaivers.push(waiver);
      consumers.push({
        consumerId,
        status: 'WAIVED',
        reportId: ev?.reportId,
        producedAt: ev?.producedAt,
        ageMs,
        detail: ev?.detail,
        waiverId: waiver.waiverId,
        waiverExpiresAt: waiver.expiresAt
      });
      advisories.push(
        `consumer "${consumerId}" is ${missing ? 'MISSING' : 'STALE'} but covered by waiver ${waiver.waiverId} (expires t=${waiver.expiresAt}, env=${environment}, dir=${compat.result})`
      );
      continue;
    }

    // No coverage — unsatisfied.
    anyUnsatisfied = true;
    if (missing) {
      consumers.push({ consumerId, status: 'MISSING' });
      blockingReasons.push(`consumer "${consumerId}" has no evidence for this candidate`);
    } else {
      consumers.push({ consumerId, status: 'STALE', reportId: ev!.reportId, producedAt: ev!.producedAt, ageMs, detail: ev!.detail });
      blockingReasons.push(`consumer "${consumerId}" evidence is stale (age ${ageMs}ms > ${freshnessWindowMs}ms window)`);
    }

    // Explain a waiver that *would* have matched but has expired, so the
    // reason a previously-covered consumer is blocking again is legible.
    const expired = findExpiredWaiver(waivers, candidateDigest, consumerId, environment, compat.result, now);
    if (expired) {
      advisories.push(
        `waiver ${expired.waiverId} for consumer "${consumerId}" expired at t=${expired.expiresAt}; no longer participating`
      );
    }
  }

  let status: GateStatus;
  if (anyFail) {
    status = 'BLOCKED';
  } else if (anyUnsatisfied) {
    status = 'COLLECTING';
  } else {
    status = 'READY';
  }

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
    environment,
    appliedWaivers,
    evidenceFingerprint: fingerprint(requiredConsumers, latestByConsumer, compat.result, environment, appliedWaivers)
  };
}

/** Does a waiver's scope exactly match this consumer's situation? */
function scopeMatches(
  w: ActiveWaiver,
  candidateDigest: string,
  consumerId: string,
  environment: string,
  compatDirection: string
): boolean {
  return (
    w.scope.candidateDigest === candidateDigest &&
    w.scope.consumerId === consumerId &&
    w.scope.environment === environment &&
    w.scope.compatDirection === compatDirection
  );
}

function pickWaiver(
  waivers: readonly ActiveWaiver[],
  candidateDigest: string,
  consumerId: string,
  environment: string,
  compatDirection: string,
  now: number
): ActiveWaiver | undefined {
  let best: ActiveWaiver | undefined;
  for (const w of waivers) {
    if (!scopeMatches(w, candidateDigest, consumerId, environment, compatDirection)) continue;
    if (now >= w.expiresAt) continue; // expired
    if (!best || w.expiresAt > best.expiresAt || (w.expiresAt === best.expiresAt && w.waiverId > best.waiverId)) {
      best = w;
    }
  }
  return best;
}

function findExpiredWaiver(
  waivers: readonly ActiveWaiver[],
  candidateDigest: string,
  consumerId: string,
  environment: string,
  compatDirection: string,
  now: number
): ActiveWaiver | undefined {
  return waivers.find(
    (w) => scopeMatches(w, candidateDigest, consumerId, environment, compatDirection) && now >= w.expiresAt
  );
}

function isNewer(a: AppliedEvidence, b: AppliedEvidence): boolean {
  if (a.producedAt !== b.producedAt) return a.producedAt > b.producedAt;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  // Deterministic final tiebreak so the fingerprint is stable.
  return a.reportId > b.reportId;
}

/**
 * Fingerprint the decision-relevant evidence set. Two evaluations with the
 * same required consumers, the same winning report per consumer, the same
 * compatibility verdict, the same environment, and the same set of applied
 * waivers produce the same fingerprint. A decision stores this value;
 * later-arriving evidence or waiver expiry changes the *live* evaluation but
 * cannot retroactively alter what a stored decision was based on.
 */
function fingerprint(
  requiredConsumers: readonly string[],
  latestByConsumer: Map<string, AppliedEvidence>,
  compat: string,
  environment: string,
  appliedWaivers: readonly ActiveWaiver[]
): string {
  const parts: string[] = [`compat:${compat}`, `env:${environment}`];
  for (const consumerId of [...requiredConsumers].sort()) {
    const ev = latestByConsumer.get(consumerId);
    if (ev) {
      parts.push(`${consumerId}=${ev.reportId}:${ev.verdict}:${ev.producedAt}`);
    } else {
      parts.push(`${consumerId}=<none>`);
    }
  }
  for (const w of [...appliedWaivers].sort((a, b) => a.waiverId.localeCompare(b.waiverId))) {
    parts.push(`waiver:${w.waiverId}:${w.scope.consumerId}:${w.expiresAt}`);
  }
  const hash = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return `sha256:${hash}`;
}
