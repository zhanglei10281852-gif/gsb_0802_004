import { randomUUID } from 'node:crypto';
import { candidateDigest } from '../domain/digest.js';
import { analyzeCompatibility } from '../domain/compatibility.js';
import { evaluateGate } from '../domain/gate.js';
import {
  classifyReceipt,
  newlyRequiredConsumers,
  nextWaveStatus,
  type ReceiptResult,
  type RevalidationResolution,
  type RolloutStatus,
  type RolloutView,
  type WaveStatus
} from '../domain/rollout.js';
import type { Clock } from '../domain/clock.js';
import {
  DEFAULT_ENVIRONMENT,
  type ActiveWaiver,
  type AppliedEvidence,
  type CompatDirection,
  type Environment,
  type GateEvaluation,
  type JsonSchema,
  type Verdict
} from '../domain/types.js';
import type {
  DecisionRecord,
  ProposalRecord,
  Repository,
  ReceiptRecord,
  RevalidationRecord,
  RolloutRecord,
  WaiverRecord,
  WaveRecord
} from '../ports/repository.js';
import { InjectedCrash, NoFaults, type FaultInjector } from '../ports/faults.js';

/**
 * Application service: orchestrates the domain core over the persistence port.
 *
 * This is where the hard concurrency/idempotency/ordering guarantees live,
 * because they are properties of how operations interact with durable state —
 * not of any single pure function. The service depends only on ports
 * (Repository, Clock, FaultInjector), so HTTP, the UI, and the agent simulator
 * all drive the same logic through the same guarantees.
 */

export interface RegisterSubjectInput {
  subjectId: string;
  requiredConsumers: string[];
  freshnessWindowMs: number;
}

export interface SubmitCandidateInput {
  subjectId: string;
  baselineSchema: JsonSchema;
  candidateSchema: JsonSchema;
  submittedBy: string;
  /**
   * Optional optimistic-concurrency guard for creating a successor: the id of
   * the OPEN proposal the caller believes they are correcting. If given and it
   * no longer matches the current open proposal (e.g. a rival successor landed
   * first), the submit is rejected instead of silently replacing a different
   * candidate.
   */
  expectedPredecessorId?: string;
}

export interface SubmitCandidateResult {
  proposal: ProposalRecord;
  /** True if an identical candidate already existed (idempotent submit). */
  deduplicated: boolean;
  /** The predecessor this proposal replaced, if it was created as a successor. */
  predecessorId: string | null;
}

export interface ReportEvidenceInput {
  reportId: string;
  subjectId: string;
  /** Digest of the candidate the agent validated against. */
  targetDigest: string;
  consumerId: string;
  verdict: Verdict;
  /** Logical time the agent produced the result. */
  producedAt: number;
  detail?: string;
}

export type EvidenceOutcome =
  | { status: 'APPLIED'; reportId: string }
  | { status: 'DUPLICATE'; reportId: string; note: string }
  | { status: 'IGNORED'; reportId: string; reason: string };

export interface DecideInput {
  proposalId: string;
  /** The exact candidate digest the decision maker intends to act on. */
  expectedDigest: string;
  /** Fingerprint the workbench last saw; guards against acting on stale view. */
  expectedFingerprint?: string;
  /** Environment this decision is for (default 'production'). */
  environment?: Environment;
  type: 'APPROVE' | 'REJECT';
  decidedBy: string;
  note?: string;
}

export type DecideOutcome =
  | { status: 'DECIDED'; decision: DecisionRecord }
  | { status: 'CONFLICT'; reason: string }
  | { status: 'REJECTED_PRECONDITION'; reason: string };

export interface RequestWaiverInput {
  subjectId: string;
  /** Candidate the waiver is scoped to (exact digest). */
  candidateDigest: string;
  consumerId: string;
  environment?: Environment;
  /** Compatibility direction the waiver is allowed to cover. */
  compatDirection: CompatDirection;
  reason: string;
  requestedBy: string;
  /** Duration of the grace, in logical ms, from request time. */
  ttlMs: number;
}

export type WaiverOutcome =
  | { status: 'REQUESTED'; waiver: WaiverRecord }
  | { status: 'CONFIRMED'; waiver: WaiverRecord }
  | { status: 'REJECTED'; waiver: WaiverRecord }
  | { status: 'REVOKED'; waiver: WaiverRecord }
  | { status: 'DENIED'; reason: string };

export interface ProposalView {
  proposal: ProposalRecord;
  gate: GateEvaluation;
  decision: DecisionRecord | null;
  /** All waivers ever raised for this candidate (any status), for audit. */
  waivers: WaiverRecord[];
  /** Lineage: the proposal this one succeeded, and the one that succeeded it. */
  lineage: {
    predecessorId: string | null;
    predecessorDigest: string | null;
    successorId: string | null;
    successorDigest: string | null;
  };
}

export interface CreateRolloutInput {
  /** The APPROVE decision to deploy. The rollout binds to its snapshot. */
  decisionId: string;
  /** Ordered wave names for this environment (at least one). */
  waves: string[];
  createdBy: string;
  note?: string;
}

export type RolloutOutcome =
  | { status: 'CREATED'; rollout: RolloutRecord; waves: WaveRecord[] }
  | { status: 'DENIED'; reason: string };

export interface ReportReceiptInput {
  receiptId: string;
  rolloutId: string;
  waveId: string;
  attempt: number;
  result: ReceiptResult;
  /** The decision fingerprint the deployment adapter believes it is shipping. */
  evidenceFingerprint: string;
  detail?: string;
}

export type ReceiptOutcome =
  | { status: 'ADVANCED'; receipt: ReceiptRecord; result: ReceiptResult }
  | { status: 'DUPLICATE'; receipt: ReceiptRecord }
  | { status: 'IGNORED'; receipt: ReceiptRecord; reason: string }
  | { status: 'DENIED'; reason: string };

export interface RollbackInput {
  /** Environment whose active rollout is being rolled back. */
  subjectId: string;
  environment?: Environment;
  /** The prior known-good candidate digest to redeploy. */
  targetDigest: string;
  /** Ordered wave names for the rollback deployment (at least one). */
  waves: string[];
  createdBy: string;
  note?: string;
}

/** A rollout together with its waves and receipts, for read models. */
export interface RolloutDetail {
  rollout: RolloutRecord;
  waves: WaveRecord[];
  receipts: ReceiptRecord[];
  /** Topology-change re-validations opened against this rollout, if any. */
  revalidations: RevalidationRecord[];
}

export class ControlCenterService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: Clock,
    private readonly faults: FaultInjector = new NoFaults()
  ) {}

  // --- subjects ------------------------------------------------------------

  registerSubject(input: RegisterSubjectInput): void {
    if (input.requiredConsumers.length === 0) {
      throw new ServiceError('BAD_REQUEST', 'a subject must declare at least one required consumer');
    }
    if (input.freshnessWindowMs <= 0) {
      throw new ServiceError('BAD_REQUEST', 'freshnessWindowMs must be positive');
    }
    const now = this.clock.now();
    // The whole upsert + topology-change reaction is a single transaction.
    // better-sqlite3 is synchronous and single-threaded, so this transaction and
    // any concurrent reportReceipt transaction are strictly serialized — never
    // interleaved. That is what makes "a receipt landing while the topology
    // changes" deterministic: either the receipt commits first (settling its
    // wave, and we then evaluate coverage against the resulting state) or the
    // topology change commits first (holding future waves, while the already
    // in-flight wave's decisive receipt still settles it afterwards). The hold
    // only ever blocks NOT-YET-STARTED waves; it never rejects a receipt.
    this.repo.transaction(() => {
      const before = this.repo.getSubject(input.subjectId);
      const beforeConsumers = before?.requiredConsumers ?? [];

      this.repo.upsertSubject({
        subjectId: input.subjectId,
        requiredConsumers: [...input.requiredConsumers],
        freshnessWindowMs: input.freshnessWindowMs,
        createdAt: before?.createdAt ?? now
      });
      this.repo.appendEvent('subject.registered', now, { subjectId: input.subjectId }, {
        requiredConsumers: input.requiredConsumers,
        freshnessWindowMs: input.freshnessWindowMs,
        previousConsumers: beforeConsumers
      });

      // Dependency-topology growth: consumers that are required now but were not
      // before. If any of them is not yet covered for an in-flight rollout's
      // deployed candidate, that rollout must auto-hold its remaining waves and
      // grow a traceable re-validation on the same proposal lineage.
      const added = newlyRequiredConsumers(beforeConsumers, input.requiredConsumers);
      if (added.length > 0) {
        this.reactToTopologyGrowth(input.subjectId, added, input.freshnessWindowMs, now);
      }
    });
  }

  /**
   * For each in-flight RELEASE rollout of a subject whose deployed candidate no
   * longer covers every required consumer (because new consumers were just
   * added), auto-hold the rollout's not-yet-started waves and open a
   * re-validation conclusion bound to the SAME proposal. The historical
   * decision snapshot is never touched — the re-validation is a fresh,
   * traceable conclusion about coverage under the new topology.
   */
  private reactToTopologyGrowth(subjectId: string, added: string[], freshnessWindowMs: number, now: number): void {
    for (const rollout of this.repo.listRollouts(subjectId)) {
      // Only live forward releases can be held; terminal or rollback rollouts
      // have no future waves to guard.
      if (rollout.kind !== 'RELEASE') continue;
      if (!['PENDING', 'IN_PROGRESS', 'PAUSED'].includes(rollout.status)) continue;
      if (!rollout.proposalId) continue;
      // One OPEN re-validation per rollout is enough; a second topology change
      // while one is open just extends the same conclusion's audit trail via a
      // new event, not a duplicate hold.
      if (this.repo.getOpenRevalidation(rollout.rolloutId)) continue;

      const proposal = this.repo.getProposal(rollout.proposalId);
      if (!proposal) continue;

      // Re-evaluate the DEPLOYED candidate's coverage under the NEW required
      // set. Any newly-required consumer without a fresh PASS for this candidate
      // is a coverage gap. This reads reality directly and never touches the
      // immutable decision snapshot.
      const gap = this.coverageGap(proposal, added, freshnessWindowMs);
      if (gap.length === 0) continue; // new consumers already covered; no hold

      const reason = `dependency topology changed mid-rollout: new required consumer(s) ${gap.join(', ')} not yet covered for candidate ${proposal.candidateDigest.slice(0, 20)}… in ${rollout.environment}`;
      this.repo.setRolloutHold(rollout.rolloutId, reason, now, 'rollout.held', {
        rolloutId: rollout.rolloutId,
        addedConsumers: added,
        gapConsumers: gap
      });
      const revalidation: RevalidationRecord = {
        revalidationId: randomUUID(),
        rolloutId: rollout.rolloutId,
        subjectId,
        proposalId: proposal.proposalId,
        candidateDigest: proposal.candidateDigest,
        environment: rollout.environment,
        addedConsumers: gap,
        status: 'OPEN',
        reason,
        openedAt: now,
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null
      };
      this.repo.insertRevalidation(revalidation);
      this.repo.appendEvent('rollout.revalidation.opened', now, { subjectId, proposalId: proposal.proposalId }, {
        revalidationId: revalidation.revalidationId,
        rolloutId: rollout.rolloutId,
        addedConsumers: gap,
        reason
      });
    }
  }

  // --- candidate submission ------------------------------------------------

  submitCandidate(input: SubmitCandidateInput): SubmitCandidateResult {
    const subject = this.repo.getSubject(input.subjectId);
    if (!subject) {
      throw new ServiceError('NOT_FOUND', `unknown subject "${input.subjectId}"`);
    }

    const digest = candidateDigest(input.candidateSchema);
    const now = this.clock.now();

    return this.repo.transaction(() => {
      // Idempotent submit: the same candidate schema (by canonical digest) for
      // a subject maps to one proposal. Re-submitting returns the existing one
      // instead of creating a rival proposal for identical content.
      const existing = this.repo.getProposalByDigest(input.subjectId, digest);
      if (existing) {
        return { proposal: existing, deduplicated: true, predecessorId: existing.predecessorId };
      }

      // A new distinct candidate becomes the SUCCESSOR of the current OPEN
      // proposal, if any. This is what makes "the current proposal" a
      // well-defined target, lets us reject late evidence for older candidates,
      // and records an explicit lineage link.
      const open = this.repo.getOpenProposal(input.subjectId);

      // Optimistic concurrency: if the caller named the predecessor they meant
      // to correct, refuse when reality has moved on (a rival successor won).
      if (input.expectedPredecessorId !== undefined && open?.proposalId !== input.expectedPredecessorId) {
        throw new ServiceError(
          'CONFLICT',
          `expected to succeed proposal "${input.expectedPredecessorId}" but the current open proposal is "${open?.proposalId ?? '<none>'}"`
        );
      }

      if (open) {
        // The predecessor is closed to further release, its build evidence stays
        // bound to it (never carried forward — the successor has a new digest),
        // and its still-open waivers lapse by their exact scope so nothing is
        // inherited by name.
        this.repo.markSuperseded(open.proposalId, now);
        const lapsed = this.repo.lapseWaiversForCandidate(
          open.subjectId,
          open.candidateDigest,
          now,
          `predecessor ${open.proposalId} replaced by successor`
        );
        this.repo.appendEvent('proposal.replaced', now, { subjectId: input.subjectId, proposalId: open.proposalId }, {
          predecessorId: open.proposalId,
          predecessorDigest: open.candidateDigest,
          lapsedWaivers: lapsed
        });
      }

      const compat = analyzeCompatibility(input.baselineSchema, input.candidateSchema);
      const seq = this.repo.listProposals(input.subjectId).length + 1;
      const proposal: ProposalRecord = {
        proposalId: randomUUID(),
        subjectId: input.subjectId,
        candidateDigest: digest,
        baselineSchema: input.baselineSchema,
        candidateSchema: input.candidateSchema,
        compat,
        state: 'OPEN',
        seq,
        submittedAt: now,
        submittedBy: input.submittedBy,
        decisionId: null,
        predecessorId: open?.proposalId ?? null
      };
      this.repo.insertProposal(proposal);
      this.repo.appendEvent('proposal.submitted', now, { subjectId: input.subjectId, proposalId: proposal.proposalId }, {
        candidateDigest: digest,
        compat: compat.result,
        predecessorId: open?.proposalId ?? null
      });
      return { proposal, deduplicated: false, predecessorId: open?.proposalId ?? null };
    });
  }

  // --- evidence ingestion --------------------------------------------------

  reportEvidence(input: ReportEvidenceInput): EvidenceOutcome {
    const receivedAt = this.clock.now();

    // The whole ingest is one transaction so idempotency and the applied/
    // ignored classification are decided atomically against durable state.
    const outcome = this.repo.transaction<EvidenceOutcome>(() => {
      // 1) Idempotency: a report id is processed at most once. A retried
      //    delivery of the same report id is acknowledged as a duplicate and
      //    has no additional effect. We compare stored fields so a corrupted
      //    retry (same id, different content) is surfaced, not silently
      //    accepted.
      const prior = this.repo.getEvidence(input.reportId);
      if (prior) {
        const consistent =
          prior.consumerId === input.consumerId &&
          prior.verdict === input.verdict &&
          prior.targetDigest === input.targetDigest &&
          prior.producedAt === input.producedAt;
        return {
          status: 'DUPLICATE',
          reportId: input.reportId,
          note: consistent
            ? 'report already processed; no additional effect'
            : 'report id already used with different content; original retained'
        };
      }

      // 2) Resolve the proposal this evidence targets by (subject, digest).
      //    Unknown targets and non-current candidates are stored but not
      //    applied, so late/misdirected results cannot pollute the current gate.
      const subject = this.repo.getSubject(input.subjectId);
      const targetProposal = subject
        ? this.repo.getProposalByDigest(input.subjectId, input.targetDigest)
        : undefined;

      let applied = false;
      let ignoredReason: string | null = null;
      let proposalIdForRow: string;

      if (!subject) {
        ignoredReason = `unknown subject "${input.subjectId}"`;
        proposalIdForRow = SENTINEL_PROPOSAL;
      } else if (!targetProposal) {
        ignoredReason = `no candidate with digest ${input.targetDigest} for subject`;
        proposalIdForRow = SENTINEL_PROPOSAL;
      } else if (targetProposal.state !== 'OPEN') {
        // A result for an older candidate (now SUPERSEDED, or already decided).
        // It stays attributed to that original proposal for the audit trail and
        // is never applied — a late/concurrent old result can never release a
        // successor, whose digest it does not even name.
        ignoredReason =
          targetProposal.state === 'SUPERSEDED'
            ? `candidate was replaced by a successor (proposal is SUPERSEDED); result stays with the original proposal and does not release the successor`
            : `candidate is ${targetProposal.state}, not the current open proposal`;
        proposalIdForRow = targetProposal.proposalId;
      } else if (!subject.requiredConsumers.includes(input.consumerId)) {
        // Unknown consumer for this subject: recorded for audit, never counts.
        ignoredReason = `consumer "${input.consumerId}" is not required for this subject`;
        proposalIdForRow = targetProposal.proposalId;
      } else {
        applied = true;
        proposalIdForRow = targetProposal.proposalId;
      }

      // For unknown subjects we have no FK-valid proposal row to attach to, so
      // we ensure a sentinel proposal exists purely to anchor audit records.
      if (proposalIdForRow === SENTINEL_PROPOSAL) {
        this.ensureSentinelProposal();
      }

      this.repo.insertEvidence({
        reportId: input.reportId,
        proposalId: proposalIdForRow,
        subjectId: input.subjectId,
        targetDigest: input.targetDigest,
        consumerId: input.consumerId,
        verdict: input.verdict,
        producedAt: input.producedAt,
        receivedAt,
        detail: input.detail ?? null,
        applied,
        ignoredReason
      });

      this.repo.appendEvent(
        applied ? 'evidence.applied' : 'evidence.ignored',
        receivedAt,
        { subjectId: input.subjectId, proposalId: applied ? proposalIdForRow : null },
        {
          reportId: input.reportId,
          consumerId: input.consumerId,
          verdict: input.verdict,
          targetDigest: input.targetDigest,
          ...(ignoredReason ? { ignoredReason } : {})
        }
      );

      return applied
        ? { status: 'APPLIED', reportId: input.reportId }
        : { status: 'IGNORED', reportId: input.reportId, reason: ignoredReason ?? 'ignored' };
    });

    // 3) Fault point: the write is durably committed above. If armed, we crash
    //    *before replying*. A retry with the same report id then hits the
    //    idempotency branch and returns DUPLICATE — the effect happened once.
    if (this.faults.shouldFail('evidence.after-write-before-reply')) {
      throw new InjectedCrash('evidence.after-write-before-reply');
    }

    return outcome;
  }

  // --- decisions -----------------------------------------------------------

  decide(input: DecideInput): DecideOutcome {
    const environment = input.environment ?? DEFAULT_ENVIRONMENT;
    // Sweep expired waivers first, so a decision never relies on a grace that
    // has already lapsed at decision time.
    this.repo.expireWaivers(this.clock.now());

    const proposal = this.repo.getProposal(input.proposalId);
    if (!proposal) {
      return { status: 'REJECTED_PRECONDITION', reason: `unknown proposal "${input.proposalId}"` };
    }

    // Precondition: the decision maker must be acting on the exact candidate
    // they think they are. A digest mismatch means the workbench view is out
    // of date (a newer candidate was submitted).
    if (proposal.candidateDigest !== input.expectedDigest) {
      return {
        status: 'REJECTED_PRECONDITION',
        reason: `candidate digest mismatch: proposal is ${proposal.candidateDigest}, decision targeted ${input.expectedDigest}`
      };
    }
    if (proposal.state !== 'OPEN') {
      return {
        status: 'CONFLICT',
        reason: `proposal already ${proposal.state}; decisions are immutable`
      };
    }

    const subject = this.repo.getSubject(proposal.subjectId)!;
    const gate = this.evaluateProposalGate(proposal, subject.requiredConsumers, subject.freshnessWindowMs, environment);

    // Guard against acting on a stale view: if the caller supplied the
    // fingerprint they saw and evidence has moved since, refuse.
    if (input.expectedFingerprint && input.expectedFingerprint !== gate.evidenceFingerprint) {
      return {
        status: 'REJECTED_PRECONDITION',
        reason: 'evidence changed since the view was loaded; reload and re-evaluate'
      };
    }

    // Approval is only permitted for a candidate whose evidence is complete
    // and fresh right now (waivers may satisfy MISSING/STALE consumers, never
    // FAIL). Rejections are always allowed on an open proposal.
    if (input.type === 'APPROVE' && !gate.canApprove) {
      return {
        status: 'REJECTED_PRECONDITION',
        reason: `cannot approve: gate is ${gate.status}. ${gate.blockingReasons.join('; ')}`
      };
    }

    const decidedAt = this.clock.now();
    const decision: DecisionRecord = {
      decisionId: randomUUID(),
      proposalId: proposal.proposalId,
      subjectId: proposal.subjectId,
      candidateDigest: proposal.candidateDigest,
      type: input.type,
      environment,
      evidenceFingerprint: gate.evidenceFingerprint,
      // Immutable snapshot: the conclusion is frozen with the exact gate view
      // it was based on — including which waivers it relied on. Evidence or
      // waiver expiry arriving later is still recorded, but this snapshot
      // never changes.
      gateSnapshot: gate,
      decidedAt,
      decidedBy: input.decidedBy,
      note: input.note ?? null
    };

    // Compare-and-set at the storage layer: only one concurrent decision can
    // transition the OPEN proposal. The loser gets CONFLICT — two contradictory
    // valid conclusions are impossible.
    const committed = this.repo.commitDecision(decision);
    if (!committed) {
      const winner = this.repo.getDecisionForProposal(proposal.proposalId);
      return {
        status: 'CONFLICT',
        reason: winner
          ? `proposal already ${winner.type === 'APPROVE' ? 'APPROVED' : 'REJECTED'} by ${winner.decidedBy}`
          : 'proposal was concurrently closed'
      };
    }

    // Fault point: decision is durably committed. If armed, crash before
    // replying. A retry finds the proposal already closed and returns CONFLICT
    // referencing the committed decision — no second decision is created.
    if (this.faults.shouldFail('decision.after-commit-before-reply')) {
      throw new InjectedCrash('decision.after-commit-before-reply');
    }

    return { status: 'DECIDED', decision };
  }

  // --- waivers -------------------------------------------------------------

  /**
   * A reviewer applies for a time-limited waiver. The waiver starts in
   * REQUESTED and does nothing until a second, distinct reviewer confirms it.
   * Its scope is fixed at request time and can only ever cover the named
   * (candidate digest, consumer, environment, compat direction). The candidate
   * must exist and be OPEN, the consumer must be required for the subject, and
   * the requested compat direction must match the candidate's actual static
   * result — so a waiver written for a benign change can never later cover a
   * riskier candidate.
   */
  requestWaiver(input: RequestWaiverInput): WaiverOutcome {
    const environment = input.environment ?? DEFAULT_ENVIRONMENT;
    if (input.ttlMs <= 0) return { status: 'DENIED', reason: 'ttlMs must be positive' };
    if (!input.reason?.trim()) return { status: 'DENIED', reason: 'a waiver must carry a reason' };

    return this.repo.transaction<WaiverOutcome>(() => {
      const subject = this.repo.getSubject(input.subjectId);
      if (!subject) return { status: 'DENIED', reason: `unknown subject "${input.subjectId}"` };

      const proposal = this.repo.getProposalByDigest(input.subjectId, input.candidateDigest);
      if (!proposal) return { status: 'DENIED', reason: `no candidate with digest ${input.candidateDigest}` };
      if (proposal.state !== 'OPEN') {
        return { status: 'DENIED', reason: `candidate is ${proposal.state}; waivers only apply to the open candidate` };
      }
      if (!subject.requiredConsumers.includes(input.consumerId)) {
        return { status: 'DENIED', reason: `consumer "${input.consumerId}" is not required for this subject` };
      }
      if (proposal.compat.result !== input.compatDirection) {
        return {
          status: 'DENIED',
          reason: `compat direction mismatch: candidate is ${proposal.compat.result}, waiver requested for ${input.compatDirection}`
        };
      }

      const now = this.clock.now();
      const waiver: WaiverRecord = {
        waiverId: randomUUID(),
        subjectId: input.subjectId,
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        environment,
        compatDirection: input.compatDirection,
        status: 'REQUESTED',
        reason: input.reason.trim(),
        requestedBy: input.requestedBy,
        requestedAt: now,
        expiresAt: now + input.ttlMs,
        confirmedBy: null,
        confirmedAt: null,
        closedBy: null,
        closedAt: null,
        endReason: null
      };
      this.repo.insertWaiver(waiver);
      this.repo.appendEvent('waiver.requested', now, { subjectId: input.subjectId, proposalId: proposal.proposalId }, {
        waiverId: waiver.waiverId,
        requestedBy: input.requestedBy,
        scope: { candidateDigest: input.candidateDigest, consumerId: input.consumerId, environment, compatDirection: input.compatDirection },
        expiresAt: waiver.expiresAt,
        reason: waiver.reason
      });
      return { status: 'REQUESTED', waiver };
    });
  }

  /**
   * A second reviewer confirms a REQUESTED waiver, making it ACTIVE. Dual
   * control: the confirmer must differ from the requester. The transition is a
   * compare-and-set on REQUESTED, so concurrent/duplicate confirmations cannot
   * double-activate.
   */
  confirmWaiver(waiverId: string, confirmedBy: string): WaiverOutcome {
    return this.repo.transaction<WaiverOutcome>(() => {
      const waiver = this.repo.getWaiver(waiverId);
      if (!waiver) return { status: 'DENIED', reason: `unknown waiver "${waiverId}"` };
      if (waiver.status !== 'REQUESTED') {
        return { status: 'DENIED', reason: `waiver is ${waiver.status}; only a REQUESTED waiver can be confirmed` };
      }
      if (waiver.requestedBy === confirmedBy) {
        return { status: 'DENIED', reason: 'dual control: the confirming reviewer must differ from the requester' };
      }
      // Expiry can pass before confirmation; do not activate a dead waiver.
      if (this.clock.now() >= waiver.expiresAt) {
        this.repo.expireWaivers(this.clock.now());
        return { status: 'DENIED', reason: 'waiver has already expired and cannot be confirmed' };
      }
      const ok = this.repo.confirmWaiver(waiverId, confirmedBy, this.clock.now());
      if (!ok) return { status: 'DENIED', reason: 'waiver was concurrently transitioned' };
      return { status: 'CONFIRMED', waiver: this.repo.getWaiver(waiverId)! };
    });
  }

  /** A second reviewer declines a REQUESTED waiver (terminal). */
  rejectWaiver(waiverId: string, rejectedBy: string, reason: string): WaiverOutcome {
    return this.repo.transaction<WaiverOutcome>(() => {
      const waiver = this.repo.getWaiver(waiverId);
      if (!waiver) return { status: 'DENIED', reason: `unknown waiver "${waiverId}"` };
      if (waiver.status !== 'REQUESTED') {
        return { status: 'DENIED', reason: `waiver is ${waiver.status}; only a REQUESTED waiver can be rejected` };
      }
      if (waiver.requestedBy === rejectedBy) {
        return { status: 'DENIED', reason: 'dual control: the rejecting reviewer must differ from the requester' };
      }
      const ok = this.repo.rejectWaiver(waiverId, rejectedBy, this.clock.now(), reason || 'rejected by reviewer');
      if (!ok) return { status: 'DENIED', reason: 'waiver was concurrently transitioned' };
      return { status: 'REJECTED', waiver: this.repo.getWaiver(waiverId)! };
    });
  }

  /** Withdraw an ACTIVE waiver early (terminal). It stops participating at once. */
  revokeWaiver(waiverId: string, revokedBy: string, reason: string): WaiverOutcome {
    return this.repo.transaction<WaiverOutcome>(() => {
      const waiver = this.repo.getWaiver(waiverId);
      if (!waiver) return { status: 'DENIED', reason: `unknown waiver "${waiverId}"` };
      if (waiver.status !== 'ACTIVE') {
        return { status: 'DENIED', reason: `waiver is ${waiver.status}; only an ACTIVE waiver can be revoked` };
      }
      const ok = this.repo.revokeWaiver(waiverId, revokedBy, this.clock.now(), reason || 'revoked by reviewer');
      if (!ok) return { status: 'DENIED', reason: 'waiver was concurrently transitioned' };
      return { status: 'REVOKED', waiver: this.repo.getWaiver(waiverId)! };
    });
  }

  getWaiver(waiverId: string): WaiverRecord | undefined {
    return this.repo.getWaiver(waiverId);
  }

  // --- staged rollout ------------------------------------------------------

  /**
   * Create a staged rollout for an APPROVED candidate. The rollout is bound to
   * the exact decision snapshot — decisionId, proposalId, candidateDigest,
   * evidenceFingerprint and environment are copied from the committed decision
   * and never derived from mutable state. Only receipts carrying that same
   * fingerprint (and naming the live wave attempt) can ever advance it, which is
   * what keeps a rollout tied to one decision and one successor. At most one
   * non-terminal rollout may exist per (subject, environment).
   */
  createRollout(input: CreateRolloutInput): RolloutOutcome {
    const waveNames = input.waves.map((w) => w.trim()).filter((w) => w.length > 0);
    if (waveNames.length === 0) {
      return { status: 'DENIED', reason: 'a rollout must schedule at least one wave' };
    }

    return this.repo.transaction<RolloutOutcome>(() => {
      const decision = this.repo.getDecision(input.decisionId);
      if (!decision) return { status: 'DENIED', reason: `unknown decision "${input.decisionId}"` };
      if (decision.type !== 'APPROVE') {
        return { status: 'DENIED', reason: `decision is a ${decision.type}; only an APPROVE can be rolled out` };
      }

      // One live rollout per (subject, environment). The DB also enforces this
      // with a partial unique index; checking here yields a friendly message.
      const active = this.repo.getActiveRollout(decision.subjectId, decision.environment);
      if (active) {
        return {
          status: 'DENIED',
          reason: `a rollout is already in progress for ${decision.subjectId} in ${decision.environment} (${active.rolloutId})`
        };
      }

      const now = this.clock.now();
      const rolloutId = randomUUID();
      const rollout: RolloutRecord = {
        rolloutId,
        subjectId: decision.subjectId,
        environment: decision.environment,
        kind: 'RELEASE',
        // Bind to the decision snapshot verbatim.
        decisionId: decision.decisionId,
        proposalId: decision.proposalId,
        candidateDigest: decision.candidateDigest,
        evidenceFingerprint: decision.evidenceFingerprint,
        status: 'PENDING',
        createdAt: now,
        createdBy: input.createdBy,
        supersedesRolloutId: null,
        note: input.note ?? null,
        holdReason: null
      };
      const waves: WaveRecord[] = waveNames.map((name, i) => ({
        waveId: randomUUID(),
        rolloutId,
        ordinal: i + 1,
        name,
        status: 'PENDING' as WaveStatus,
        attempt: 1,
        startedAt: null,
        settledAt: null
      }));
      this.repo.insertRollout(rollout, waves);
      this.repo.appendEvent('rollout.created', now, { subjectId: decision.subjectId, proposalId: decision.proposalId }, {
        rolloutId,
        kind: 'RELEASE',
        decisionId: decision.decisionId,
        candidateDigest: decision.candidateDigest,
        evidenceFingerprint: decision.evidenceFingerprint,
        environment: decision.environment,
        waves: waves.map((w) => ({ waveId: w.waveId, ordinal: w.ordinal, name: w.name }))
      });
      return { status: 'CREATED', rollout, waves };
    });
  }

  /**
   * Start the next PENDING wave (lowest ordinal). Refuses while a wave is still
   * IN_PROGRESS or the rollout is PAUSED/terminal — waves are continuous, one at
   * a time, and only advance on a decisive receipt.
   */
  startNextWave(rolloutId: string): { status: 'STARTED'; wave: WaveRecord } | { status: 'DENIED'; reason: string } {
    const now = this.clock.now();
    const rollout = this.repo.getRollout(rolloutId);
    if (!rollout) return { status: 'DENIED', reason: `unknown rollout "${rolloutId}"` };
    if (rollout.status === 'PAUSED') {
      return { status: 'DENIED', reason: 'rollout is paused; resume it before starting the next wave' };
    }
    // A coverage gap from a mid-rollout topology change holds all not-yet-started
    // waves until the linked re-validation is resolved. The explanation lives on
    // the rollout's holdReason and the OPEN revalidation, so the workbench can
    // say exactly why the next wave will not start.
    if (rollout.holdReason) {
      const open = this.repo.getOpenRevalidation(rolloutId);
      return {
        status: 'DENIED',
        reason: open
          ? `held for re-validation ${open.revalidationId}: ${rollout.holdReason}`
          : `held: ${rollout.holdReason}`
      };
    }
    const wave = this.repo.startNextWave(rolloutId, now);
    if (!wave) {
      return { status: 'DENIED', reason: 'no startable wave (one may be in progress, or all are settled)' };
    }
    return { status: 'STARTED', wave };
  }

  /**
   * Ingest a receipt from a deployment adapter. Idempotent by receiptId. The
   * pure classifier decides whether a first-seen receipt is decisive for the
   * current wave attempt and matches the rollout's bound decision fingerprint;
   * duplicates, stale/out-of-order receipts, and fingerprint mismatches are
   * stored (applied=false) but never advance the rollout. The durable write and
   * the wave settlement happen in one transaction, then a fault point can crash
   * before replying so a retry finds the receipt already applied.
   */
  reportReceipt(input: ReportReceiptInput): ReceiptOutcome {
    const receivedAt = this.clock.now();

    const outcome = this.repo.transaction<ReceiptOutcome>(() => {
      const rollout = this.repo.getRollout(input.rolloutId);
      if (!rollout) return { status: 'DENIED', reason: `unknown rollout "${input.rolloutId}"` };

      // Idempotency: a receipt id lands at most once. A retried delivery is
      // acknowledged without any second effect.
      const prior = this.repo.getReceipt(input.receiptId);
      if (prior) return { status: 'DUPLICATE', receipt: prior };

      const view = this.toRolloutView(rollout);
      const disposition = classifyReceipt(view, {
        rolloutId: input.rolloutId,
        waveId: input.waveId,
        attempt: input.attempt,
        result: input.result,
        evidenceFingerprint: input.evidenceFingerprint,
        detail: input.detail
      });

      const applied = disposition.kind === 'ADVANCE';
      const ignoredReason = disposition.kind === 'IGNORE' ? disposition.reason : null;

      // If decisive, compute how the wave (and possibly the rollout) settles.
      let settle: { waveId: string; toStatus: WaveStatus; rolloutToStatus: RolloutStatus | null } | null = null;
      if (disposition.kind === 'ADVANCE') {
        const waveStatus = nextWaveStatus(disposition.result);
        let rolloutToStatus: RolloutStatus | null = null;
        if (waveStatus === 'SUCCEEDED') {
          // The rollout completes only when this was the last wave; otherwise it
          // stays IN_PROGRESS awaiting the next wave to be started.
          const remaining = this.repo
            .listWaves(input.rolloutId)
            .filter((w) => w.waveId !== input.waveId && w.status !== 'SUCCEEDED');
          rolloutToStatus = remaining.length === 0 ? 'COMPLETED' : null;
        } else if (waveStatus === 'FAILED') {
          // A failed wave fails the rollout; the owner may retry or roll back.
          rolloutToStatus = 'FAILED';
        }
        // UNKNOWN leaves the wave IN_PROGRESS (waveStatus === current), so we do
        // not settle: record the receipt but keep waiting.
        if (waveStatus !== 'IN_PROGRESS') {
          settle = { waveId: input.waveId, toStatus: waveStatus, rolloutToStatus };
        }
      }

      const receipt: ReceiptRecord = {
        receiptId: input.receiptId,
        rolloutId: input.rolloutId,
        waveId: input.waveId,
        attempt: input.attempt,
        result: input.result,
        evidenceFingerprint: input.evidenceFingerprint,
        receivedAt,
        detail: input.detail ?? null,
        applied,
        ignoredReason
      };
      const stored = this.repo.applyReceipt(receipt, settle, receivedAt);

      return disposition.kind === 'ADVANCE'
        ? { status: 'ADVANCED', receipt: stored, result: disposition.result }
        : { status: 'IGNORED', receipt: stored, reason: disposition.reason };
    });

    // Fault point: the receipt is durably recorded above. If armed we crash
    // before replying; a retry with the same receiptId hits the idempotency
    // branch and returns DUPLICATE — the effect happened exactly once.
    if (this.faults.shouldFail('rollout.receipt.after-write-before-reply')) {
      throw new InjectedCrash('rollout.receipt.after-write-before-reply');
    }

    return outcome;
  }

  /** Pause an in-flight rollout; no wave advances until it is resumed. */
  pauseRollout(rolloutId: string): { status: 'PAUSED' | 'DENIED'; reason?: string } {
    const now = this.clock.now();
    const ok = this.repo.setRolloutStatus(rolloutId, ['PENDING', 'IN_PROGRESS'], 'PAUSED', now, 'rollout.paused', {
      rolloutId
    });
    return ok ? { status: 'PAUSED' } : { status: 'DENIED', reason: 'rollout is not in a pausable state' };
  }

  /** Resume a paused rollout back to IN_PROGRESS. */
  resumeRollout(rolloutId: string): { status: 'RESUMED' | 'DENIED'; reason?: string } {
    const now = this.clock.now();
    const ok = this.repo.setRolloutStatus(rolloutId, ['PAUSED'], 'IN_PROGRESS', now, 'rollout.resumed', {
      rolloutId
    });
    return ok ? { status: 'RESUMED' } : { status: 'DENIED', reason: 'rollout is not paused' };
  }

  /**
   * Retry a wave. Bumps the wave's attempt counter and re-opens it, which makes
   * every receipt for the prior attempt stale (they no longer name the live
   * attempt), so a late/duplicate receipt from the failed try cannot settle the
   * retried wave.
   */
  retryWave(rolloutId: string, waveId: string): { status: 'RETRIED'; attempt: number } | { status: 'DENIED'; reason: string } {
    const now = this.clock.now();
    const attempt = this.repo.retryWave(rolloutId, waveId, now);
    if (attempt === undefined) {
      return { status: 'DENIED', reason: 'wave is not retryable (rollout terminal, or wave already succeeded)' };
    }
    return { status: 'RETRIED', attempt };
  }

  /**
   * Roll back an environment to a prior known-good candidate. This is a
   * deployment-only action: it creates a new ROLLBACK-kind rollout that
   * redeploys the target digest and marks the superseded rollout ROLLED_BACK. It
   * deliberately does NOT call commitDecision, mutate any decision snapshot, or
   * touch waivers — a rollback never rewrites the original contract decision and
   * never revives a lapsed/expired waiver. The rollback binds to the target
   * candidate's own APPROVE decision fingerprint if one exists.
   */
  rollback(input: RollbackInput): RolloutOutcome {
    const environment = input.environment ?? DEFAULT_ENVIRONMENT;
    const waveNames = input.waves.map((w) => w.trim()).filter((w) => w.length > 0);
    if (waveNames.length === 0) {
      return { status: 'DENIED', reason: 'a rollback must schedule at least one wave' };
    }

    return this.repo.transaction<RolloutOutcome>(() => {
      const subject = this.repo.getSubject(input.subjectId);
      if (!subject) return { status: 'DENIED', reason: `unknown subject "${input.subjectId}"` };

      // The target must be a candidate that was actually APPROVED for this
      // environment before — that is what "a prior known-good version" means,
      // and it supplies the fingerprint receipts for the rollback must match.
      const target = this.repo.getProposalByDigest(input.subjectId, input.targetDigest);
      if (!target) {
        return { status: 'DENIED', reason: `no candidate with digest ${input.targetDigest} for subject` };
      }
      const targetDecision = this.repo.getDecisionForProposal(target.proposalId);
      if (!targetDecision || targetDecision.type !== 'APPROVE') {
        return { status: 'DENIED', reason: 'rollback target was never approved; cannot roll back to it' };
      }
      if (targetDecision.environment !== environment) {
        return {
          status: 'DENIED',
          reason: `rollback target was approved for ${targetDecision.environment}, not ${environment}`
        };
      }

      const now = this.clock.now();

      // Supersede the current live rollout for this environment, if any. We use
      // CAS transitions so a concurrent completion is respected.
      const active = this.repo.getActiveRollout(input.subjectId, environment);
      if (active) {
        this.repo.setRolloutStatus(
          active.rolloutId,
          ['PENDING', 'IN_PROGRESS', 'PAUSED'],
          'ROLLED_BACK',
          now,
          'rollout.rolled_back',
          { rolloutId: active.rolloutId, targetDigest: input.targetDigest }
        );
      }

      const rolloutId = randomUUID();
      const rollout: RolloutRecord = {
        rolloutId,
        subjectId: input.subjectId,
        environment,
        kind: 'ROLLBACK',
        // Deployment-only: it references the target's decision for its
        // fingerprint but records no new contract decision of its own.
        decisionId: targetDecision.decisionId,
        proposalId: target.proposalId,
        candidateDigest: target.candidateDigest,
        evidenceFingerprint: targetDecision.evidenceFingerprint,
        status: 'PENDING',
        createdAt: now,
        createdBy: input.createdBy,
        supersedesRolloutId: active?.rolloutId ?? null,
        note: input.note ?? null,
        holdReason: null
      };
      const waves: WaveRecord[] = waveNames.map((name, i) => ({
        waveId: randomUUID(),
        rolloutId,
        ordinal: i + 1,
        name,
        status: 'PENDING' as WaveStatus,
        attempt: 1,
        startedAt: null,
        settledAt: null
      }));
      this.repo.insertRollout(rollout, waves);
      this.repo.appendEvent('rollout.created', now, { subjectId: input.subjectId, proposalId: target.proposalId }, {
        rolloutId,
        kind: 'ROLLBACK',
        supersedesRolloutId: active?.rolloutId ?? null,
        targetDigest: target.candidateDigest,
        evidenceFingerprint: targetDecision.evidenceFingerprint,
        environment,
        waves: waves.map((w) => ({ waveId: w.waveId, ordinal: w.ordinal, name: w.name }))
      });
      return { status: 'CREATED', rollout, waves };
    });
  }

  getRolloutDetail(rolloutId: string): RolloutDetail | undefined {
    const rollout = this.repo.getRollout(rolloutId);
    if (!rollout) return undefined;
    return {
      rollout,
      waves: this.repo.listWaves(rolloutId),
      receipts: this.repo.listReceipts(rolloutId),
      revalidations: this.repo.listRevalidations(rolloutId)
    };
  }

  listRollouts(subjectId: string): RolloutDetail[] {
    return this.repo.listRollouts(subjectId).map((rollout) => ({
      rollout,
      waves: this.repo.listWaves(rollout.rolloutId),
      receipts: this.repo.listReceipts(rollout.rolloutId),
      revalidations: this.repo.listRevalidations(rollout.rolloutId)
    }));
  }

  /**
   * Conclude a topology-change re-validation. The owner either RESUMES (the
   * coverage gap for the newly-required consumers is now closed — fresh PASS or
   * a matching waiver — so the hold is lifted and future waves may start again)
   * or keeps the rollout HELD (a traceable decision to wait). Re-validation is
   * a fresh conclusion on the same proposal lineage; it NEVER alters the
   * immutable contract decision snapshot, nor the candidate digest, waivers, or
   * already-settled wave boundaries.
   */
  resolveRevalidation(
    revalidationId: string,
    resolution: RevalidationResolution,
    resolvedBy: string,
    note?: string
  ): { status: 'RESOLVED'; resolution: RevalidationResolution } | { status: 'DENIED'; reason: string } {
    return this.repo.transaction(() => {
      const reval = this.repo.getRevalidation(revalidationId);
      if (!reval) return { status: 'DENIED', reason: `unknown re-validation "${revalidationId}"` } as const;
      if (reval.status !== 'OPEN') {
        return { status: 'DENIED', reason: `re-validation is already ${reval.status}` } as const;
      }
      const rollout = this.repo.getRollout(reval.rolloutId);
      if (!rollout) return { status: 'DENIED', reason: 'rollout no longer exists' } as const;

      if (resolution === 'RESUMED') {
        // Only allow resuming when the gap is genuinely closed now: every
        // added consumer must have a fresh PASS for the deployed candidate.
        // This re-checks live reality so an owner cannot resume into the very
        // gap that caused the hold.
        const subject = this.repo.getSubject(reval.subjectId)!;
        const proposal = this.repo.getProposal(reval.proposalId);
        if (!proposal) return { status: 'DENIED', reason: 'proposal no longer exists' } as const;
        const stillGap = this.coverageGap(proposal, reval.addedConsumers, subject.freshnessWindowMs);
        if (stillGap.length > 0) {
          return {
            status: 'DENIED',
            reason: `cannot resume: consumer(s) ${stillGap.join(', ')} still lack a fresh PASS for the deployed candidate`
          } as const;
        }
      }

      const now = this.clock.now();
      const ok = this.repo.resolveRevalidation(revalidationId, resolution, resolvedBy, note ?? null, now);
      if (!ok) return { status: 'DENIED', reason: 're-validation was concurrently resolved' } as const;

      // RESUMED lifts the operational hold so future waves may start again.
      // HELD leaves the hold in place (with the audit trail recording why).
      if (resolution === 'RESUMED') {
        this.repo.setRolloutHold(reval.rolloutId, null, now, 'rollout.hold_cleared', {
          rolloutId: reval.rolloutId,
          revalidationId
        });
      }
      return { status: 'RESOLVED', resolution } as const;
    });
  }

  private toRolloutView(rollout: RolloutRecord): RolloutView {
    return {
      rolloutId: rollout.rolloutId,
      status: rollout.status,
      binding: {
        decisionId: rollout.decisionId ?? '',
        proposalId: rollout.proposalId ?? '',
        candidateDigest: rollout.candidateDigest,
        evidenceFingerprint: rollout.evidenceFingerprint,
        environment: rollout.environment
      },
      waves: this.repo.listWaves(rollout.rolloutId).map((w) => ({
        waveId: w.waveId,
        ordinal: w.ordinal,
        status: w.status,
        attempt: w.attempt
      }))
    };
  }

  // --- read models ---------------------------------------------------------

  getProposalView(proposalId: string, environment: Environment = DEFAULT_ENVIRONMENT): ProposalView | undefined {
    // Sweep expired waivers so a read never shows a lapsed grace as active.
    this.repo.expireWaivers(this.clock.now());
    const proposal = this.repo.getProposal(proposalId);
    if (!proposal || proposal.proposalId === SENTINEL_PROPOSAL) return undefined;
    const subject = this.repo.getSubject(proposal.subjectId)!;
    const gate = this.evaluateProposalGate(proposal, subject.requiredConsumers, subject.freshnessWindowMs, environment);
    const decision = proposal.decisionId ? this.repo.getDecision(proposal.decisionId) ?? null : null;
    const waivers = this.repo.listWaiversForCandidate(proposal.subjectId, proposal.candidateDigest);

    // Lineage: resolve the predecessor and the successor (the proposal that
    // named this one as its predecessor), so the workbench can show the chain.
    const predecessor = proposal.predecessorId ? this.repo.getProposal(proposal.predecessorId) : undefined;
    const successor = this.repo
      .listProposals(proposal.subjectId)
      .find((p) => p.predecessorId === proposal.proposalId);
    const lineage = {
      predecessorId: proposal.predecessorId,
      predecessorDigest: predecessor?.candidateDigest ?? null,
      successorId: successor?.proposalId ?? null,
      successorDigest: successor?.candidateDigest ?? null
    };
    return { proposal, gate, decision, waivers, lineage };
  }

  /**
   * Consistent snapshot for the workbench. Built entirely from durable storage
   * so a reconnecting client sees the same authoritative state regardless of
   * in-process event history.
   */
  snapshot(environment: Environment = DEFAULT_ENVIRONMENT): {
    at: number;
    environment: Environment;
    subjects: Array<{
      subject: ReturnType<Repository['getSubject']>;
      current: ProposalView | null;
      history: Array<{ proposalId: string; digest: string; state: string; seq: number; predecessorId: string | null; decision: DecisionRecord | null }>;
      rollouts: RolloutDetail[];
    }>;
    eventSeq: number;
  } {
    // A single expiry sweep up front makes the whole snapshot internally
    // consistent with the current logical time.
    this.repo.expireWaivers(this.clock.now());
    const now = this.clock.now();
    const subjects = this.repo
      .listSubjects()
      .filter((s) => s.subjectId !== SENTINEL_SUBJECT)
      .map((subject) => {
      const proposals = this.repo.listProposals(subject.subjectId);
      const open = proposals.find((p) => p.state === 'OPEN');
      const current = open ? this.getProposalView(open.proposalId, environment)! : null;
      const history = proposals
        .filter((p) => p.proposalId !== SENTINEL_PROPOSAL)
        .map((p) => ({
          proposalId: p.proposalId,
          digest: p.candidateDigest,
          state: p.state,
          seq: p.seq,
          predecessorId: p.predecessorId,
          decision: p.decisionId ? this.repo.getDecision(p.decisionId) ?? null : null
        }));
      // Rollouts for the requested environment only, so the workbench view is
      // scoped to the environment the owner is driving.
      const rollouts = this.listRollouts(subject.subjectId).filter((r) => r.rollout.environment === environment);
      return { subject, current, history, rollouts };
    });
    const events = this.repo.listEvents();
    const eventSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    return { at: now, environment, subjects, eventSeq };
  }

  listEvents(sinceSeq = 0) {
    return this.repo.listEvents(sinceSeq);
  }

  // --- internals -----------------------------------------------------------

  /**
   * Coverage check for a topology-change re-validation. Returns the subset of
   * `consumers` that the ALREADY-DEPLOYED candidate does not yet cover: i.e. the
   * consumer has no fresh PASS for this candidate digest (missing, stale, or a
   * FAIL). This deliberately reads ALL evidence for the candidate — not just the
   * "applied" set the gate/decision used — because the deployed proposal is
   * closed (APPROVED), so post-decision evidence for a newly-required consumer
   * is stored but not "applied". Reading it here lets a re-validation conclude
   * on fresh reality WITHOUT ever mutating the immutable decision snapshot.
   */
  private coverageGap(proposal: ProposalRecord, consumers: string[], freshnessWindowMs: number): string[] {
    const now = this.clock.now();
    const all = this.repo.listEvidenceForProposal(proposal.proposalId);
    const newest = new Map<string, { verdict: Verdict; producedAt: number; receivedAt: number; reportId: string }>();
    for (const e of all) {
      const prev = newest.get(e.consumerId);
      const isNewer =
        !prev ||
        e.producedAt > prev.producedAt ||
        (e.producedAt === prev.producedAt && e.receivedAt > prev.receivedAt) ||
        (e.producedAt === prev.producedAt && e.receivedAt === prev.receivedAt && e.reportId > prev.reportId);
      if (isNewer) newest.set(e.consumerId, { verdict: e.verdict, producedAt: e.producedAt, receivedAt: e.receivedAt, reportId: e.reportId });
    }
    const gap: string[] = [];
    for (const c of consumers) {
      const ev = newest.get(c);
      const fresh = ev && now - ev.producedAt <= freshnessWindowMs;
      if (!ev || !fresh || ev.verdict !== 'PASS') gap.push(c);
    }
    return gap;
  }

  private evaluateProposalGate(
    proposal: ProposalRecord,
    requiredConsumers: string[],
    freshnessWindowMs: number,
    environment: Environment
  ): GateEvaluation {
    const applied = this.repo.listAppliedEvidence(proposal.proposalId);
    const appliedEvidence: AppliedEvidence[] = applied.map((e) => ({
      reportId: e.reportId,
      consumerId: e.consumerId,
      verdict: e.verdict,
      producedAt: e.producedAt,
      receivedAt: e.receivedAt,
      detail: e.detail ?? undefined
    }));
    // Only ACTIVE waivers for this exact candidate are handed to the gate. The
    // gate re-checks scope + expiry, but expired waivers have already been
    // swept out by the caller.
    const activeWaivers: ActiveWaiver[] = this.repo
      .listActiveWaivers(proposal.subjectId, proposal.candidateDigest)
      .map((w) => ({
        waiverId: w.waiverId,
        scope: {
          candidateDigest: w.candidateDigest,
          consumerId: w.consumerId,
          environment: w.environment,
          compatDirection: w.compatDirection
        },
        expiresAt: w.expiresAt
      }));
    return evaluateGate({
      requiredConsumers,
      appliedEvidence,
      compat: proposal.compat,
      submittedAt: proposal.submittedAt,
      now: this.clock.now(),
      freshnessWindowMs,
      candidateDigest: proposal.candidateDigest,
      environment,
      waivers: activeWaivers
    });
  }

  private sentinelEnsured = false;
  private ensureSentinelProposal(): void {
    if (this.sentinelEnsured) return;
    if (!this.repo.getProposal(SENTINEL_PROPOSAL)) {
      // A hidden subject+proposal pair that anchors audit rows for evidence
      // that targets unknown subjects. Never surfaced in views/snapshots.
      const now = this.clock.now();
      this.repo.upsertSubject({
        subjectId: SENTINEL_SUBJECT,
        requiredConsumers: ['__none__'],
        freshnessWindowMs: 1,
        createdAt: now
      });
      this.repo.insertProposal({
        proposalId: SENTINEL_PROPOSAL,
        subjectId: SENTINEL_SUBJECT,
        candidateDigest: 'sha256:sentinel',
        baselineSchema: {},
        candidateSchema: {},
        compat: { result: 'UNKNOWN', changes: [] },
        state: 'SUPERSEDED',
        seq: 0,
        submittedAt: now,
        submittedBy: 'system',
        decisionId: null,
        predecessorId: null
      });
    }
    this.sentinelEnsured = true;
  }
}

const SENTINEL_SUBJECT = '__unknown__';
const SENTINEL_PROPOSAL = '__unknown_proposal__';

export class ServiceError extends Error {
  constructor(
    public readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
