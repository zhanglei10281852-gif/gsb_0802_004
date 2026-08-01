import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo, baselineSchema, compatibleCandidate } from './helpers.js';
import { Repository } from '../src/storage/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { VirtualClock } from '../src/domain/clock.js';

const revisedCandidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    note: { type: 'string' },
    priority: { type: 'string' },
  },
  required: ['orderId'],
};

describe('Proposal lineage and successors', () => {
  let ctx: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    ctx = createTestRepo();
  });
  afterEach(() => ctx.cleanup());

  it('creates a successor with a new candidate hash and marks the parent superseded', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    expect(parent.revision).toBe(1);
    expect(parent.parentProposalId).toBeNull();
    expect(parent.lineageRootId).toBe(parent.id);

    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.successor.candidateHash).not.toBe(parent.candidateHash);
    expect(result.successor.parentProposalId).toBe(parent.id);
    expect(result.successor.replacesCandidateHash).toBe(parent.candidateHash);
    expect(result.successor.revision).toBe(2);
    expect(result.successor.lineageRootId).toBe(parent.lineageRootId);
    expect(result.superseded.status).toBe('superseded');

    const detail = repo.getProposalDetail(result.successor.id)!;
    expect(detail.parent?.id).toBe(parent.id);
    expect(detail.lineage.successorIds).toEqual([]);
    const parentDetail = repo.getProposalDetail(parent.id)!;
    expect(parentDetail.lineage.successorIds).toEqual([result.successor.id]);
  });

  it('does not carry evidence from the parent to the successor', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence({
      proposalId: parent.id,
      consumerId: 'c1',
      candidateHash: parent.candidateHash,
      verdict: 'compatible',
      details: 'ok',
      idempotencyKey: 'k1',
    });

    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const successorDetail = repo.getProposalDetail(result.successor.id)!;
    expect(successorDetail.evidence).toHaveLength(0);
    expect(successorDetail.gateReady).toBe(false);
    expect(successorDetail.missingConsumerIds).toContain('c1');
  });

  it('voids open exemptions from the parent so they cannot unblock the successor', () => {
    const { repo, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    repo.registerConsumer('c2', 'Consumer 2');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const t = clock.now();
    const req = repo.requestExemption({
      candidateHash: parent.candidateHash,
      consumerId: 'c2',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 10000,
    });
    repo.confirmExemption((req as any).exemption.id, 'bob');

    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const oldExemptions = repo.listExemptions(parent.candidateHash);
    expect(oldExemptions.every((e) => e.status === 'voided')).toBe(true);

    const successorDetail = repo.getProposalDetail(result.successor.id)!;
    expect(successorDetail.appliedExemptions).toHaveLength(0);
    expect(successorDetail.exemptions.every((e) => e.status === 'voided')).toBe(true);
    expect(successorDetail.exemptedConsumerIds).toEqual([]);
  });

  it('does not inherit an exemption even when the consumer and environment names are identical', () => {
    const { repo, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema, 'production');
    const t = clock.now();
    const req = repo.requestExemption({
      candidateHash: parent.candidateHash,
      consumerId: 'c1',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 10000,
    });
    repo.confirmExemption((req as any).exemption.id, 'bob');
    repo.createSuccessor(parent.id, revisedCandidate);

    const successor = repo.listProposals().find((p) => p.parentProposalId === parent.id)!;
    const successorExemptions = repo.listExemptions(successor.candidateHash);
    expect(successorExemptions).toHaveLength(0);
  });

  it('files a late result for the superseded parent and does not let it release the successor', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    repo.registerConsumer('c2', 'Consumer 2');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const successor = result.successor;

    const late = repo.submitEvidence({
      proposalId: parent.id,
      consumerId: 'c1',
      candidateHash: parent.candidateHash,
      verdict: 'compatible',
      details: 'build finally finished',
      idempotencyKey: 'late-1',
    });
    expect(late.accepted).toBe(true);
    if (late.accepted) expect(late.evidence.late).toBe(true);

    const parentDetail = repo.getProposalDetail(parent.id)!;
    expect(parentDetail.evidence.find((e) => e.consumerId === 'c1')?.late).toBe(true);

    const successorDetail = repo.getProposalDetail(successor.id)!;
    expect(successorDetail.evidence).toHaveLength(0);
    expect(successorDetail.gateReady).toBe(false);
  });

  it('rejects evidence for the successor that carries the old candidate hash', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wrong = repo.submitEvidence({
      proposalId: result.successor.id,
      consumerId: 'c1',
      candidateHash: parent.candidateHash,
      verdict: 'compatible',
      details: 'stale hash',
      idempotencyKey: 'wrong-hash',
    });
    expect(wrong.accepted).toBe(false);
  });

  it('blocks decisions on a superseded proposal', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.createSuccessor(parent.id, revisedCandidate);
    const decision = repo.decide(parent.id, 'approve', 'should fail');
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain('superseded');
  });

  it('records replacement, closure, late submission, and exemption voiding in the causal chain', () => {
    const { repo, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const t = clock.now();
    const req = repo.requestExemption({
      candidateHash: parent.candidateHash,
      consumerId: 'c1',
      environment: 'production',
      direction: 'compatible',
      reason: 'offline',
      requesterId: 'alice',
      validFrom: t,
      validUntil: t + 10000,
    });
    repo.confirmExemption((req as any).exemption.id, 'bob');
    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    repo.submitEvidence({
      proposalId: parent.id,
      consumerId: 'c1',
      candidateHash: parent.candidateHash,
      verdict: 'compatible',
      details: 'late',
      idempotencyKey: 'late-2',
    });

    const types = repo.listEvents().map((e) => e.type);
    expect(types).toContain('successor_created');
    expect(types).toContain('proposal_superseded');
    expect(types).toContain('exemption_voided');
    expect(types).toContain('evidence_received_late');
  });

  it('recovers lineage across repository restarts', () => {
    const { repo, db, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal: parent } = repo.createProposal(compatibleCandidate, baselineSchema);
    const result = repo.createSuccessor(parent.id, revisedCandidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const successorId = result.successor.id;
    const rootId = parent.lineageRootId;
    const eventCount = repo.listEvents().length;
    db.close();

    const db2 = openDatabase((db as unknown as { name: string }).name);
    const repo2 = new Repository(db2, { clock: new VirtualClock(0) });
    const recovered = repo2.getProposalDetail(successorId)!;
    expect(recovered.proposal.parentProposalId).toBe(parent.id);
    expect(recovered.proposal.lineageRootId).toBe(rootId);
    expect(recovered.proposal.revision).toBe(2);
    expect(recovered.parent?.status).toBe('superseded');
    expect(recovered.parent?.candidateHash).toBe(parent.candidateHash);
    expect(repo2.listEvents().length).toBe(eventCount);
    expect(repo2.recover().lamport).toBeGreaterThan(0);
    db2.close();
  });
});
