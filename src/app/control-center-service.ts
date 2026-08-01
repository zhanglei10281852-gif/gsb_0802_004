import { randomUUID } from 'node:crypto';
import { candidateDigest } from '../domain/digest.js';
import { analyzeCompatibility } from '../domain/compatibility.js';
import { evaluateGate } from '../domain/gate.js';
import type { Clock } from '../domain/clock.js';
import type {
  AppliedEvidence,
  GateEvaluation,
  JsonSchema,
  Verdict
} from '../domain/types.js';
import type {
  DecisionRecord,
  ProposalRecord,
  Repository
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
  type: 'APPROVE' | 'REJECT';
  decidedBy: string;
  note?: string;
}

export type DecideOutcome =
  | { status: 'DECIDED'; decision: DecisionRecord }
  | { status: 'CONFLICT'; reason: string }
  | { status: 'REJECTED_PRECONDITION'; reason: string };

export interface ProposalView {
  proposal: ProposalRecord;
  gate: GateEvaluation;
  decision: DecisionRecord | null;
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
    const gate = this.evaluateProposalGate(proposal, subject.requiredConsumers, subject.freshnessWindowMs);

    // Guard against acting on a stale view: if the caller supplied the
    // fingerprint they saw and evidence has moved since, refuse.
    if (input.expectedFingerprint && input.expectedFingerprint !== gate.evidenceFingerprint) {
      return {
        status: 'REJECTED_PRECONDITION',
        reason: 'evidence changed since the view was loaded; reload and re-evaluate'
      };
    }

    // Approval is only permitted for a candidate whose evidence is complete
    // and fresh right now. Rejections are always allowed on an open proposal.
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
      evidenceFingerprint: gate.evidenceFingerprint,
      // Immutable snapshot: the conclusion is frozen with the exact gate view
      // it was based on. Evidence arriving later is still stored, but this
      // snapshot never changes.
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

  // --- read models ---------------------------------------------------------

  getProposalView(proposalId: string): ProposalView | undefined {
    const proposal = this.repo.getProposal(proposalId);
    if (!proposal || proposal.proposalId === SENTINEL_PROPOSAL) return undefined;
    const subject = this.repo.getSubject(proposal.subjectId)!;
    const gate = this.evaluateProposalGate(proposal, subject.requiredConsumers, subject.freshnessWindowMs);
    const decision = proposal.decisionId ? this.repo.getDecision(proposal.decisionId) ?? null : null;
    return { proposal, gate, decision };
  }

  /**
   * Consistent snapshot for the workbench. Built entirely from durable storage
   * so a reconnecting client sees the same authoritative state regardless of
   * in-process event history.
   */
  snapshot(): {
    at: number;
    subjects: Array<{
      subject: ReturnType<Repository['getSubject']>;
      current: ProposalView | null;
      history: Array<{ proposalId: string; digest: string; state: string; seq: number; decision: DecisionRecord | null }>;
    }>;
    eventSeq: number;
  } {
    const now = this.clock.now();
    const subjects = this.repo
      .listSubjects()
      .filter((s) => s.subjectId !== SENTINEL_SUBJECT)
      .map((subject) => {
      const proposals = this.repo.listProposals(subject.subjectId);
      const open = proposals.find((p) => p.state === 'OPEN');
      const current = open ? this.getProposalView(open.proposalId)! : null;
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
    return { at: now, subjects, eventSeq };
  }

  listEvents(sinceSeq = 0) {
    return this.repo.listEvents(sinceSeq);
  }

  // --- internals -----------------------------------------------------------

  private evaluateProposalGate(
    proposal: ProposalRecord,
    requiredConsumers: string[],
    freshnessWindowMs: number
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
    return evaluateGate({
      requiredConsumers,
      appliedEvidence,
      compat: proposal.compat,
      submittedAt: proposal.submittedAt,
      now: this.clock.now(),
      freshnessWindowMs
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
