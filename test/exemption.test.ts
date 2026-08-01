import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo, baselineSchema, compatibleCandidate } from './helpers.js';

describe('Exemption repository lifecycle', () => {
  let ctx: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    ctx = createTestRepo();
  });
  afterEach(() => ctx.cleanup());

  function setupTwoConsumers() {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    repo.registerConsumer('c2', 'Consumer 2');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    return proposal;
  }

  function c1Evidence(proposalId: string, candidateHash: string, key = 'k-c1') {
    const { repo } = ctx;
    const res = repo.submitEvidence({
      proposalId,
      consumerId: 'c1',
      candidateHash,
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: key,
    });
    expect(res.accepted).toBe(true);
  }

  it('requires two different reviewers to activate an exemption', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();

    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.exemption.status).toBe('pending');

    const selfConfirm = repo.confirmExemption(requested.exemption.id, 'alice');
    expect(selfConfirm.ok).toBe(false);

    const bobConfirm = repo.confirmExemption(requested.exemption.id, 'bob');
    expect(bobConfirm.ok).toBe(true);
    if (bobConfirm.ok) {
      expect(bobConfirm.exemption.status).toBe('active');
      expect(bobConfirm.exemption.confirmerId).toBe('bob');
    }
  });

  it('blocks approval without the second reviewer even after request', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();
    repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.missingConsumerIds).toContain('c2');
  });

  it('unblocks the gate once confirmed and freezes into the decision snapshot', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    c1Evidence(proposal.id, proposal.candidateHash);
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');

    const before = repo.getProposalDetail(proposal.id)!;
    expect(before.gateReady).toBe(true);
    expect(before.exemptedConsumerIds).toEqual(['c2']);

    const decision = repo.decide(proposal.id, 'approve', 'go with waiver');
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.decision.snapshot.appliedExemptions).toHaveLength(1);
    const frozen = decision.decision.snapshot.appliedExemptions[0]!;
    expect(frozen.consumerId).toBe('c2');
    expect(frozen.requesterId).toBe('alice');
    expect(frozen.confirmerId).toBe('bob');
    expect(frozen.validUntil).toBe(t + 1000);
  });

  it('expires after validUntil and stops participating in new decisions', () => {
    const { repo, clock } = ctx;
    const proposal = setupTwoConsumers();
    c1Evidence(proposal.id, proposal.candidateHash);
    const t = clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');
    expect(repo.getProposalDetail(proposal.id)!.gateReady).toBe(true);

    clock.advance(1001);
    const expired = repo.sweepExpiredExemptions();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe('expired');

    const after = repo.getProposalDetail(proposal.id)!;
    expect(after.gateReady).toBe(false);
    expect(after.missingConsumerIds).toContain('c2');
    expect(after.appliedExemptions).toHaveLength(0);

    const decision = repo.decide(proposal.id, 'approve', 'should fail');
    expect(decision.ok).toBe(false);
  });

  it('revocation removes an active exemption from future decisions', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    c1Evidence(proposal.id, proposal.candidateHash);
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    const exId = (requested as any).exemption.id as string;
    repo.confirmExemption(exId, 'bob');
    expect(repo.getProposalDetail(proposal.id)!.gateReady).toBe(true);

    const revoked = repo.closeExemption(exId, 'carol', 'revoke', 'consumer came back early');
    expect(revoked.ok).toBe(true);
    expect(repo.getProposalDetail(proposal.id)!.gateReady).toBe(false);
  });

  it('does not apply an exemption for a different environment', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'staging',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');
    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.appliedExemptions).toHaveLength(0);
  });

  it('does not apply an incompatible-direction exemption to unblock approval', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'incompatible',
      reason: 'known break accepted by risk',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');
    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
  });

  it('does not let an exemption override actual incompatible evidence', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');
    repo.submitEvidence({
      proposalId: proposal.id,
      consumerId: 'c1',
      candidateHash: proposal.candidateHash,
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: 'k1',
    });
    repo.submitEvidence({
      proposalId: proposal.id,
      consumerId: 'c2',
      candidateHash: proposal.candidateHash,
      verdict: 'incompatible',
      details: 'breaks parser',
      idempotencyKey: 'k2',
    });
    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.incompatibleConsumerIds).toContain('c2');
    expect(detail.exemptedConsumerIds).toEqual([]);
  });

  it('never waives system compatibility even with an exemption', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const breaking = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { orderId: { type: 'string' }, amount: { type: 'number', minimum: 0 } },
      required: ['orderId', 'amount'],
    };
    const { proposal } = repo.createProposal(breaking, baselineSchema);
    expect(proposal.systemCompatibility.compatible).toBe(false);
    const t = ctx.clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c1',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    repo.confirmExemption((requested as any).exemption.id, 'bob');
    const decision = repo.decide(proposal.id, 'approve', 'should fail');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('system compatibility');
  });

  it('keeps the frozen snapshot unchanged after revocation and expiry', () => {
    const { repo, clock } = ctx;
    const proposal = setupTwoConsumers();
    c1Evidence(proposal.id, proposal.candidateHash);
    const t = clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    const exId = (requested as any).exemption.id as string;
    repo.confirmExemption(exId, 'bob');
    const decision = repo.decide(proposal.id, 'approve', 'go');
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    clock.advance(2000);
    repo.sweepExpiredExemptions();
    repo.closeExemption(exId, 'carol', 'revoke', 'late revoke after expiry');

    const stored = repo.getDecision(proposal.id)!;
    expect(stored.snapshot.appliedExemptions).toHaveLength(1);
    expect(stored.snapshot.appliedExemptions[0]!.id).toBe(exId);
    expect(stored.snapshot.appliedExemptions[0]!.confirmerId).toBe('bob');
  });

  it('records the full exemption lifecycle in the causal audit chain', () => {
    const { repo, clock } = ctx;
    const proposal = setupTwoConsumers();
    const t = clock.now();
    const requested = repo.requestExemption({
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    });
    const exId = (requested as any).exemption.id as string;
    repo.confirmExemption(exId, 'bob');
    clock.advance(2000);
    repo.sweepExpiredExemptions();

    const types = repo.listEvents().map((e) => e.type);
    expect(types).toContain('exemption_requested');
    expect(types).toContain('exemption_confirmed');
    expect(types).toContain('exemption_expired');
  });

  it('rejects a duplicate open exemption for the same candidate/consumer/env/direction', () => {
    const { repo } = ctx;
    const proposal = setupTwoConsumers();
    const t = ctx.clock.now();
    const body = {
      candidateHash: proposal.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible' as const,
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 1000,
    };
    expect(repo.requestExemption(body).ok).toBe(true);
    expect(repo.requestExemption(body).ok).toBe(false);
  });
});
