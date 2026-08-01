/**
 * Domain types for the data-contract change control center.
 *
 * This module is pure: it declares the vocabulary shared by the domain core,
 * the application service, and the adapters. Nothing here performs IO, reads
 * the clock, or depends on a framework. Keeping the vocabulary in one place is
 * what lets the compatibility engine and the gate state machine stay decoupled
 * from HTTP, storage, the UI, and the agent simulator.
 */

/** A JSON Schema (draft 2020-12) represented as an opaque JSON value. */
export type JsonSchema = Record<string, unknown>;

/** Verdict a build agent reports for a consumer validating a candidate. */
export type Verdict = 'PASS' | 'FAIL';

/**
 * Static compatibility classification of a candidate relative to its baseline.
 * - COMPATIBLE: every data value accepted by the baseline is still accepted.
 * - BREAKING:   the candidate rejects data the baseline accepted.
 * - UNKNOWN:    the schema uses constructs the analyzer cannot reason about,
 *               so compatibility must be established from consumer evidence.
 */
export type CompatResult = 'COMPATIBLE' | 'BREAKING' | 'UNKNOWN';

/** A single classified difference between baseline and candidate. */
export interface CompatChange {
  readonly path: string;
  readonly kind: CompatResult;
  readonly detail: string;
}

export interface CompatReport {
  readonly result: CompatResult;
  readonly changes: readonly CompatChange[];
}

/** Per-consumer readiness derived by the gate from applied evidence. */
export type ConsumerStatus = 'MISSING' | 'STALE' | 'PASS' | 'FAIL' | 'WAIVED';

/**
 * Overall gate status for a candidate.
 * - COLLECTING: still waiting for fresh passing evidence from some consumer.
 * - BLOCKED:    at least one consumer reported a failing verdict.
 * - READY:      every required consumer has fresh passing evidence.
 */
export type GateStatus = 'COLLECTING' | 'BLOCKED' | 'READY';

/** Lifecycle of a candidate proposal. */
export type ProposalState =
  | 'OPEN' // current candidate for its subject, awaiting a decision
  | 'SUPERSEDED' // a newer candidate replaced it before a decision was made
  | 'APPROVED'
  | 'REJECTED';

export type DecisionType = 'APPROVE' | 'REJECT';

/**
 * Target environment a decision (and a waiver) applies to. The system is not
 * multi-environment for evidence collection — evidence stays global — but a
 * decision is made *for* an environment, and a waiver is scoped to exactly one
 * environment so a grace granted for staging cannot leak into production.
 */
export type Environment = string;

export const DEFAULT_ENVIRONMENT: Environment = 'production';

/**
 * The compatibility direction a waiver is allowed to cover. A waiver is a
 * deliberate, narrowly-scoped grace for a consumer that is *temporarily
 * offline* during a release window; it therefore only makes sense to grant it
 * for a specific static-compatibility direction (e.g. "this COMPATIBLE change
 * is low risk"). Binding the direction stops a waiver written for a benign
 * change from silently covering a later, riskier candidate.
 */
export type CompatDirection = CompatResult;

/**
 * Immutable scope of a waiver. A waiver may only ever affect the exact
 * (candidate digest, consumer, environment, compatibility direction) tuple it
 * names. Nothing about this scope is derived from or folds back into the
 * candidate digest itself — waivers are separate entities layered on top of an
 * unchanged candidate identity.
 */
export interface WaiverScope {
  readonly candidateDigest: string;
  readonly consumerId: string;
  readonly environment: Environment;
  readonly compatDirection: CompatDirection;
}

/**
 * Lifecycle of a waiver.
 * - REQUESTED: one reviewer has applied for it; not yet active.
 * - ACTIVE:    a second, distinct reviewer confirmed it; it participates in
 *              gate evaluation until it expires or is revoked.
 * - REJECTED:  a second reviewer declined it; never participated.
 * - REVOKED:   an active waiver was withdrawn; stops participating immediately.
 * - EXPIRED:   its time limit passed; stops participating.
 * REJECTED / REVOKED / EXPIRED are terminal and never re-enter evaluation.
 */
export type WaiverStatus = 'REQUESTED' | 'ACTIVE' | 'REJECTED' | 'REVOKED' | 'EXPIRED';

/**
 * An active waiver as seen by the pure gate. The gate is told only what it
 * needs: the scope and the expiry, plus the id for explainability. Whether a
 * waiver is ACTIVE and unexpired is decided by the caller (service), so the
 * gate stays a pure function of its inputs.
 */
export interface ActiveWaiver {
  readonly waiverId: string;
  readonly scope: WaiverScope;
  /** Logical time at which the waiver stops being valid. */
  readonly expiresAt: number;
}

/** A piece of validation evidence as applied to a proposal. */
export interface AppliedEvidence {
  readonly reportId: string;
  readonly consumerId: string;
  readonly verdict: Verdict;
  readonly producedAt: number;
  readonly receivedAt: number;
  readonly detail?: string;
}

/** Inputs to a pure gate evaluation. */
export interface GateInput {
  readonly requiredConsumers: readonly string[];
  readonly appliedEvidence: readonly AppliedEvidence[];
  readonly compat: CompatReport;
  readonly submittedAt: number;
  readonly now: number;
  readonly freshnessWindowMs: number;
  /**
   * The candidate being evaluated. Waivers only apply when their scope names
   * exactly this digest.
   */
  readonly candidateDigest: string;
  /** The environment this evaluation/decision is for. */
  readonly environment: Environment;
  /**
   * Waivers the caller has already filtered down to ACTIVE + unexpired. The
   * gate re-checks scope and expiry defensively but does not decide dual
   * control or persistence — that lives in the service.
   */
  readonly waivers: readonly ActiveWaiver[];
}

export interface ConsumerReadiness {
  readonly consumerId: string;
  readonly status: ConsumerStatus;
  readonly reportId?: string;
  readonly producedAt?: number;
  readonly ageMs?: number;
  readonly detail?: string;
  /** Set when status is WAIVED: which waiver covered this consumer. */
  readonly waiverId?: string;
  /** Set when status is WAIVED: when the covering waiver expires. */
  readonly waiverExpiresAt?: number;
}

/** Result of a pure gate evaluation. */
export interface GateEvaluation {
  readonly status: GateStatus;
  /** True only when a decision maker may APPROVE this exact candidate. */
  readonly canApprove: boolean;
  readonly consumers: readonly ConsumerReadiness[];
  /** Hard reasons that make approval impossible right now. */
  readonly blockingReasons: readonly string[];
  /** Non-blocking risk notes (e.g. static compatibility warnings). */
  readonly advisories: readonly string[];
  /** The environment this evaluation was computed for. */
  readonly environment: Environment;
  /**
   * Waivers that actually contributed to this evaluation (i.e. covered a
   * MISSING/STALE consumer). Recorded so a decision snapshot preserves exactly
   * which graces it relied on, and so the workbench can show them.
   */
  readonly appliedWaivers: readonly ActiveWaiver[];
  /**
   * Stable fingerprint of the evidence set that produced this evaluation.
   * A decision is bound to this fingerprint so that evidence arriving after
   * the decision cannot silently change the conclusion, and so concurrent
   * approvals cannot act on divergent views of the evidence. The set of
   * applied waivers is folded in, so approving with a waiver in effect is a
   * distinct decision basis from approving without it.
   */
  readonly evidenceFingerprint: string;
}
