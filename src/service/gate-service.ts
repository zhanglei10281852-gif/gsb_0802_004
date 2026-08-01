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
import type {
  CausalEvent,
  ExemptionRecord,
  GateView,
  ProposalInput,
  StoredProposal,
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
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly faults: FaultInjector = new NoFaults(),
    private readonly onEvent: OnEvent = () => {},
  ) {
    this.repo = new ProposalRepository(db, clock);
    this.exemptions = new ExemptionRepository(db, clock, this.repo.events);
    this.repo.setExemptionRepository(this.exemptions);
  }

  private publishDrained(): void {
    for (const e of this.repo.drainEvents()) this.onEvent(e);
    for (const e of this.exemptions.drainEvents()) this.onEvent(e);
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
    this.publishDrained();
    return {
      accepted: true,
      deduped: result.deduped,
      proposal: this.repo.requireById(input.proposalId),
    };
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
    };
  }

  listProposals(): StoredProposal[] {
    return this.repo.list();
  }
}
