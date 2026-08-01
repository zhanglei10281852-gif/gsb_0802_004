import type { Clock } from '../core/clock.js';
import type { DB } from '../storage/schema.js';
import { ProposalRepository, type EvidenceInput, type DecisionInput } from '../storage/repository.js';
import type { CausalEvent, GateView, ProposalInput, StoredProposal } from '../core/types.js';
import { computeBlockers, computeFreshness } from '../core/gate.js';

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
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly faults: FaultInjector = new NoFaults(),
    private readonly onEvent: OnEvent = () => {},
  ) {
    this.repo = new ProposalRepository(db, clock);
  }

  submitProposal(input: ProposalInput): { proposal: StoredProposal; event: CausalEvent } {
    const { proposal, event } = this.repo.create(input);
    this.repo.refreshGateStatus(proposal.proposalId);
    for (const e of this.repo.drainEvents()) this.onEvent(e);
    return { proposal: this.repo.requireById(proposal.proposalId), event };
  }

  reportEvidence(input: EvidenceInput): {
    accepted: boolean;
    deduped: boolean;
    reason?: string;
    proposal: StoredProposal;
  } {
    if (this.faults.shouldCrashAfterWrite?.('before-evidence-insert')) {
      this.simulateCrash();
    }
    const result = this.repo.ingestEvidence(input);
    if (!result.accepted) {
      for (const e of this.repo.drainEvents()) this.onEvent(e);
      return { accepted: false, deduped: false, reason: result.reason, proposal: this.repo.requireById(input.proposalId) };
    }
    if (this.faults.shouldCrashAfterWrite?.('after-evidence-insert')) {
      this.simulateCrash();
    }
    this.repo.refreshGateStatus(input.proposalId);
    for (const e of this.repo.drainEvents()) this.onEvent(e);
    return {
      accepted: true,
      deduped: result.deduped,
      proposal: this.repo.requireById(input.proposalId),
    };
  }

  private simulateCrash(): never {
    console.error('[fault] injected crash: process exit before response');
    process.exit(17);
  }

  decide(input: DecisionInput): { proposal: StoredProposal; event: CausalEvent } {
    const result = this.repo.decide(input);
    for (const e of this.repo.drainEvents()) this.onEvent(e);
    return { proposal: result.proposal, event: result.event };
  }

  getGateView(proposalId: string): GateView {
    const proposal = this.repo.requireById(proposalId);
    const evidence = this.repo.getEvidence(proposalId);
    const blockers = computeBlockers(
      proposal.compatibility,
      proposal.consumers,
      evidence,
      proposal.ttlMs,
      this.clock,
      proposal.status,
    );
    const evidenceFreshness = computeFreshness(
      proposal.consumers,
      evidence,
      proposal.ttlMs,
      this.clock,
    );
    return { proposal, evidence, blockers, evidenceFreshness, eventLog: this.repo.events.readForProposal(proposalId) };
  }

  listProposals(): StoredProposal[] {
    return this.repo.list();
  }
}
