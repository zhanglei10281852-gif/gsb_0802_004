import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepo, baselineSchema, compatibleCandidate, breakingCandidate } from './helpers.js';
import { Repository } from '../src/storage/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { VirtualClock } from '../src/domain/clock.js';
import type { EvidenceSubmission } from '../src/domain/types.js';

function evidence(
  proposalId: string,
  consumerId: string,
  candidateHash: string,
  verdict: 'compatible' | 'incompatible' | 'error' = 'compatible',
  key?: string,
): EvidenceSubmission {
  return {
    proposalId,
    consumerId,
    candidateHash,
    verdict,
    details: `${consumerId} says ${verdict}`,
    idempotencyKey: key ?? `key-${consumerId}-${Math.random().toString(36).slice(2)}`,
  };
}

describe('Repository', () => {
  let ctx: ReturnType<typeof createTestRepo>;

  beforeEach(() => {
    ctx = createTestRepo();
  });
  afterEach(() => ctx.cleanup());

  it('creates a proposal and dedupes by candidate hash', () => {
    const { repo } = ctx;
    const a = repo.createProposal(compatibleCandidate, baselineSchema);
    const b = repo.createProposal(compatibleCandidate, baselineSchema);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(a.proposal.id).toBe(b.proposal.id);
  });

  it('rejects evidence from an unknown consumer', () => {
    const { repo } = ctx;
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    const res = repo.submitEvidence(evidence(proposal.id, 'ghost', proposal.candidateHash));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toContain('unknown consumer');
  });

  it('rejects evidence with a mismatched candidate hash (late result from old candidate)', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    const res = repo.submitEvidence(evidence(proposal.id, 'c1', 'deadbeefdeadbeef'));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toContain('hash mismatch');
  });

  it('dedupes identical retries via idempotency key', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    const key = 'retry-key-1';
    const first = repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', key));
    const second = repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', key));
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (first.accepted && second.accepted) {
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(first.evidence.id).toBe(second.evidence.id);
    }
    const all = repo.listEvidence(proposal.id);
    expect(all.length).toBe(1);
  });

  it('updates evidence when a genuinely new idempotency key arrives', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'incompatible', 'k1'));
    const updated = repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k2'));
    expect(updated.accepted).toBe(true);
    if (updated.accepted) {
      expect(updated.evidence.verdict).toBe('compatible');
      expect(updated.deduped).toBe(false);
    }
    expect(repo.listEvidence(proposal.id).length).toBe(1);
  });

  it('blocks approval until all registered consumers report compatible', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    repo.registerConsumer('c2', 'Consumer 2');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);

    let detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.missingConsumerIds).toContain('c1');
    expect(detail.missingConsumerIds).toContain('c2');

    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.missingConsumerIds).toEqual(['c2']);

    repo.submitEvidence(evidence(proposal.id, 'c2', proposal.candidateHash, 'compatible', 'k2'));
    detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(true);
    expect(detail.blockingReasons.length).toBe(0);
  });

  it('blocks approval when a consumer reports incompatible', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'incompatible', 'k1'));
    const detail = repo.getProposalDetail(proposal.id)!;
    expect(detail.gateReady).toBe(false);
    expect(detail.blockingReasons.some((r) => r.includes('incompatible'))).toBe(true);
  });

  it('blocks approval when the system detects a breaking change even with all consumer evidence', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(breakingCandidate, baselineSchema);
    expect(proposal.systemCompatibility.compatible).toBe(false);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    const decision = repo.decide(proposal.id, 'approve', 'ship it');
    expect(decision.ok).toBe(false);
  });

  it('allows rejection regardless of gate state', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    const res = repo.decide(proposal.id, 'reject', 'not now');
    expect(res.ok).toBe(true);
  });

  it('freezes an immutable snapshot at decision time', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    const decided = repo.decide(proposal.id, 'approve', 'go');
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    const snapshotEvidenceCount = decided.decision.snapshot.evidence.length;

    const late = repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'incompatible', 'k-late'));
    expect(late.accepted).toBe(false);

    const stored = repo.getDecision(proposal.id)!;
    expect(stored.snapshot.evidence.length).toBe(snapshotEvidenceCount);
    expect(stored.snapshot.evidence[0]!.verdict).toBe('compatible');
  });

  it('prevents two concurrent/sequential decisions on the same proposal', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    const first = repo.decide(proposal.id, 'approve', 'one');
    const second = repo.decide(proposal.id, 'reject', 'two');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('records a causal event for every mutation', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    repo.decide(proposal.id, 'approve', 'go');
    const events = repo.listEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('consumer_registered');
    expect(types).toContain('proposal_created');
    expect(types).toContain('evidence_accepted');
    expect(types).toContain('decision_made');
    const clocks = events.map((e) => e.clock);
    expect([...clocks].sort((a, b) => a - b)).toEqual(clocks);
  });

  it('rejects unknown proposal evidence and records a rejection event', () => {
    const { repo } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const res = repo.submitEvidence(evidence('nope', 'c1', 'whatever'));
    expect(res.accepted).toBe(false);
    const events = repo.listEvents();
    expect(events.some((e) => e.type === 'evidence_rejected')).toBe(true);
  });

  it('recovers full state from SQLite across repository restarts', () => {
    const { repo, db, clock } = ctx;
    repo.registerConsumer('c1', 'Consumer 1');
    const { proposal } = repo.createProposal(compatibleCandidate, baselineSchema);
    repo.submitEvidence(evidence(proposal.id, 'c1', proposal.candidateHash, 'compatible', 'k1'));
    repo.decide(proposal.id, 'approve', 'go');
    const beforeEvents = repo.listEvents();
    db.close();

    const db2 = openDatabase((db as unknown as { name: string }).name);
    const repo2 = new Repository(db2, { clock: new VirtualClock(0) });
    const recovered = repo2.recover();
    expect(recovered.proposals.length).toBe(1);
    expect(recovered.consumers.length).toBe(1);
    expect(recovered.events.length).toBe(beforeEvents.length);
    expect(recovered.lamport).toBe(beforeEvents[beforeEvents.length - 1]!.clock);

    const detail = repo2.getProposalDetail(proposal.id)!;
    expect(detail.proposal.status).toBe('approved');
    expect(detail.decision).not.toBeNull();
    expect(detail.evidence.length).toBe(1);
    db2.close();
  });
});
