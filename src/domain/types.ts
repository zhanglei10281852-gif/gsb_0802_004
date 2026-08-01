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
export type ConsumerStatus = 'MISSING' | 'STALE' | 'PASS' | 'FAIL';

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
}

export interface ConsumerReadiness {
  readonly consumerId: string;
  readonly status: ConsumerStatus;
  readonly reportId?: string;
  readonly producedAt?: number;
  readonly ageMs?: number;
  readonly detail?: string;
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
  /**
   * Stable fingerprint of the evidence set that produced this evaluation.
   * A decision is bound to this fingerprint so that evidence arriving after
   * the decision cannot silently change the conclusion, and so concurrent
   * approvals cannot act on divergent views of the evidence.
   */
  readonly evidenceFingerprint: string;
}
