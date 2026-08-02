import type { Clock } from "../core/clock.js";
import type { DB } from "../storage/schema.js";
import {
  ProposalRepository,
  type EvidenceInput,
  type DecisionInput,
} from "../storage/repository.js";
import {
  ExemptionRepository,
  type RequestExemptionInput,
  type ReviewExemptionInput,
} from "../storage/exemption-repository.js";
import {
  RolloutRepository,
  type ReceiptResult2,
} from "../storage/rollout-repository.js";
import type {
  CausalEvent,
  CreateRolloutInput,
  ExemptionRecord,
  GateView,
  ProposalInput,
  ReceiptInput,
  StoredProposal,
  StoredRollout,
  SuccessorInput,
} from "../core/types.js";
import {
  DEFAULT_ENVIRONMENT,
  computeFreshness,
  evaluateGate,
} from "../core/gate.js";

export interface FaultInjector {
  shouldCrashAfterWrite?(stage: string): boolean;
}

export class NoFaults implements FaultInjector {
  shouldCrashAfterWrite(): boolean {
    return false;
  }
}

export type OnEvent = (event: CausalEvent) => void;

export class GateService {
  readonly repo: ProposalRepository;
  readonly exemptions: ExemptionRepository;
  readonly rollouts: RolloutRepository;
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly faults: FaultInjector = new NoFaults(),
    private readonly onEvent: OnEvent = () => {},
  ) {
    this.repo = new ProposalRepository(db, clock);
    this.exemptions = new ExemptionRepository(db, clock, this.repo.events);
    this.rollouts = new RolloutRepository(
      db,
      clock,
      this.repo,
      this.repo.events,
    );
    this.repo.setExemptionRepository(this.exemptions);
  }

  private publishDrained(): void {
    for (const e of this.repo.drainEvents()) this.onEvent(e);
    for (const e of this.exemptions.drainEvents()) this.onEvent(e);
    for (const e of this.rollouts.drainEvents()) this.onEvent(e);
  }

  submitProposal(input: ProposalInput): {
    proposal: StoredProposal;
    event: CausalEvent;
  } {
    const { proposal, event } = this.repo.create(input);
    this.repo.refreshGateStatus(proposal.proposalId);
    this.publishDrained();
    return { proposal: this.repo.requireById(proposal.proposalId), event };
  }

  createSuccessor(
    predecessorId: string,
    input: SuccessorInput,
  ): {
    predecessor: StoredProposal;
    successor: StoredProposal;
  } {
    const result = this.repo.createSuccessor(predecessorId, input);
    this.repo.refreshGateStatus(result.successor.proposalId);
    this.publishDrained();
    return {
      predecessor: this.repo.requireById(predecessorId),
      successor: this.repo.requireById(result.successor.proposalId),
    };
  }

  reportEvidence(input: EvidenceInput): {
    accepted: boolean;
    deduped: boolean;
    reason?: string;
    proposal: StoredProposal;
  } {
    if (this.faults.shouldCrashAfterWrite?.("before-evidence-insert")) {
      this.simulateCrash();
    }
    const before = this.repo.requireById(input.proposalId);
    const wasReverification =
      before.status === "approved" &&
      (before.additions ?? []).some(
        (a) => a.consumerId === input.consumerId && a.reverifiedAt === null,
      );
    const result = this.repo.ingestEvidence(input);
    if (!result.accepted) {
      this.publishDrained();
      return {
        accepted: false,
        deduped: false,
        reason: result.reason,
        proposal: this.repo.requireById(input.proposalId),
      };
    }
    if (this.faults.shouldCrashAfterWrite?.("after-evidence-insert")) {
      this.simulateCrash();
    }
    this.repo.refreshGateStatus(input.proposalId);
    let resumedRollouts: string[] = [];
    if (wasReverification && !result.deduped) {
      resumedRollouts = this.rollouts.evaluateTopologyResume(
        input.proposalId,
      );
      if (resumedRollouts.length > 0) {
        this.enrichReverificationEvent(
          input.proposalId,
          input.consumerId,
          resumedRollouts,
        );
      }
    }
    this.publishDrained();
    return {
      accepted: true,
      deduped: result.deduped,
      proposal: this.repo.requireById(input.proposalId),
    };
  }

  addRequiredConsumer(input: {
    proposalId: string;
    consumerId: string;
    addedBy: string;
    reason: string;
    schema?: Record<string, unknown>;
  }): {
    proposal: StoredProposal;
    pausedRollouts: string[];
    gapConsumerIds: string[];
  } {
    const { proposal, addition } = this.repo.addRequiredConsumer({
      ...input,
      schema: input.schema ?? { type: "object" },
    });
    const { paused, gapConsumerIds } = this.rollouts.evaluateTopologyPause(
      input.proposalId,
    );
    this.enrichTopologyEvent(
      input.proposalId,
      addition.consumerId,
      paused,
      gapConsumerIds,
    );
    this.publishDrained();
    return {
      proposal: this.repo.requireById(input.proposalId),
      pausedRollouts: paused,
      gapConsumerIds,
    };
  }

  private enrichTopologyEvent(
    proposalId: string,
    consumerId: string,
    paused: string[],
    gapConsumerIds: string[],
  ): void {
    const rolloutId = paused[0] ?? null;
    this.repo.replaceLastEventPayload(
      proposalId,
      "topology-changed",
      (payload) => ({
        ...payload,
        rolloutId,
        rolloutPaused: paused.length > 0,
        gapConsumerIds,
        consumerId,
      }),
    );
  }

  private enrichReverificationEvent(
    proposalId: string,
    consumerId: string,
    resumedRollouts: string[],
  ): void {
    const proposal = this.repo.requireById(proposalId);
    const remainingGap = (proposal.additions ?? [])
      .filter((a) => a.reverifiedAt === null)
      .map((a) => a.consumerId);
    this.repo.replaceLastEventPayload(
      proposalId,
      "reverification-concluded",
      (payload) => ({
        ...payload,
        consumerId,
        rolloutId: resumedRollouts[0] ?? null,
        rolloutResumed: resumedRollouts.length > 0,
        remainingGapConsumerIds: remainingGap,
      }),
    );
  }

  private simulateCrash(): never {
    console.error("[fault] injected crash: process exit before response");
    process.exit(17);
  }

  decide(input: DecisionInput): {
    proposal: StoredProposal;
    event: CausalEvent;
  } {
    const result = this.repo.decide(input);
    this.publishDrained();
    return { proposal: result.proposal, event: result.event };
  }

  requestExemption(input: RequestExemptionInput): ExemptionRecord {
    const record = this.exemptions.request(input);
    this.repo.refreshGateStatus(input.proposalId, input.environment);
    this.publishDrained();
    return record;
  }

  reviewExemption(input: ReviewExemptionInput): ExemptionRecord {
    const record = this.exemptions.review(input);
    this.repo.refreshGateStatus(record.proposalId, record.environment);
    this.publishDrained();
    return record;
  }

  revokeExemption(exemptionId: string, revokedBy: string): ExemptionRecord {
    const record = this.exemptions.revoke(exemptionId, revokedBy);
    this.repo.refreshGateStatus(record.proposalId, record.environment);
    this.publishDrained();
    return record;
  }

  listExemptions(proposalId: string): ExemptionRecord[] {
    return this.exemptions.listForProposal(proposalId);
  }

  getGateView(
    proposalId: string,
    environment: string = DEFAULT_ENVIRONMENT,
  ): GateView {
    const proposal = this.repo.requireById(proposalId);
    const evidence = this.repo.getEvidence(proposalId);
    const exemptions = this.exemptions.listForProposal(proposalId);
    const effectiveExemptions =
      this.exemptions.listEffectiveForProposal(proposalId);
    const evaluation = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence,
      exemptions: effectiveExemptions,
      ttlMs: proposal.ttlMs,
      environment,
      clock: this.clock,
      currentStatus: proposal.status,
    });
    const evidenceFreshness = computeFreshness(
      proposal.consumers,
      evidence,
      proposal.ttlMs,
      this.clock,
    );
    return {
      proposal,
      evidence,
      blockers: evaluation.blockers,
      evidenceFreshness,
      exemptions,
      appliedExemptions: evaluation.appliedExemptions,
      environment,
      eventLog: this.repo.events.readForProposal(proposalId),
      rollouts: this.rollouts.listForProposal(proposalId),
    };
  }

  listProposals(): StoredProposal[] {
    return this.repo.list();
  }

  createRollout(input: CreateRolloutInput): {
    rollout: StoredRollout;
    proposal: StoredProposal;
  } {
    const result = this.rollouts.create(input);
    this.publishDrained();
    return result;
  }

  startRollout(rolloutId: string): StoredRollout {
    const rollout = this.rollouts.start(rolloutId);
    this.publishDrained();
    return rollout;
  }

  pauseRollout(rolloutId: string, pausedBy: string): StoredRollout {
    const rollout = this.rollouts.pause(rolloutId, pausedBy);
    this.publishDrained();
    return rollout;
  }

  resumeRollout(rolloutId: string, resumedBy: string): StoredRollout {
    const rollout = this.rollouts.resume(rolloutId, resumedBy);
    this.publishDrained();
    return rollout;
  }

  retryRolloutWave(
    rolloutId: string,
    waveSequence: number,
    retriedBy: string,
  ): StoredRollout {
    const rollout = this.rollouts.retry(rolloutId, waveSequence, retriedBy);
    this.publishDrained();
    return rollout;
  }

  rollbackRollout(
    rolloutId: string,
    rolledBackBy: string,
    note: string,
  ): StoredRollout {
    const rollout = this.rollouts.rollback(rolloutId, rolledBackBy, note);
    this.publishDrained();
    return rollout;
  }

  reportReceipt(input: ReceiptInput): ReceiptResult2 {
    if (this.faults.shouldCrashAfterWrite?.("before-receipt-insert")) {
      this.simulateCrash();
    }
    const result = this.rollouts.reportReceipt(input);
    if (this.faults.shouldCrashAfterWrite?.("after-receipt-insert")) {
      this.simulateCrash();
    }
    this.publishDrained();
    return result;
  }

  getRollout(rolloutId: string): StoredRollout {
    return this.rollouts.requireById(rolloutId);
  }

  listRolloutsForProposal(proposalId: string): StoredRollout[] {
    return this.rollouts.listForProposal(proposalId);
  }
}
