import { randomUUID } from 'node:crypto';
import { candidateDigest } from '../domain/digest.js';
import { analyzeCompatibility } from '../domain/compatibility.js';
import { evaluateGate } from '../domain/gate.js';
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
  WaiverRecord
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
}

export interface SubmitCandidateResult {
  proposal: ProposalRecord;
  /** True if an identical candidate already existed (idempotent submit). */
  deduplicated: boolean;
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
    this.repo.transaction(() => {
      this.repo.upsertSubject({
        subjectId: input.subjectId,
        requiredConsumers: [...input.requiredConsumers],
        freshnessWindowMs: input.freshnessWindowMs,
        createdAt: now
      });
      this.repo.appendEvent('subject.registered', now, { subjectId: input.subjectId }, {
        requiredConsumers: input.requiredConsumers,
        freshnessWindowMs: input.freshnessWindowMs
      });
    });
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
        return { proposal: existing, deduplicated: true };
      }

      // A new distinct candidate supersedes the current OPEN proposal, if any.
      // This is what makes "the current proposal" a well-defined target and
      // lets us reject late evidence for older candidates.
      const open = this.repo.getOpenProposal(input.subjectId);
      if (open) {
        this.repo.markSuperseded(open.proposalId, now);
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
        decisionId: null
      };
      this.repo.insertProposal(proposal);
      this.repo.appendEvent('proposal.submitted', now, { subjectId: input.subjectId, proposalId: proposal.proposalId }, {
        candidateDigest: digest,
        compat: compat.result,
        supersededOpen: open?.proposalId ?? null
      });
      return { proposal, deduplicated: false };
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
        ignoredReason = `candidate is ${targetProposal.state}, not the current open proposal`;
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
    return { proposal, gate, decision, waivers };
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
      history: Array<{ proposalId: string; digest: string; state: string; seq: number; decision: DecisionRecord | null }>;
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
          decision: p.decisionId ? this.repo.getDecision(p.decisionId) ?? null : null
        }));
      return { subject, current, history };
    });
    const events = this.repo.listEvents();
    const eventSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    return { at: now, environment, subjects, eventSeq };
  }

  listEvents(sinceSeq = 0) {
    return this.repo.listEvents(sinceSeq);
  }

  // --- internals -----------------------------------------------------------

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
        decisionId: null
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
