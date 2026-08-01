import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/storage/schema.js';
import { ProposalRepository, type EvidenceInput } from '../src/storage/repository.js';
import { ExemptionRepository } from '../src/storage/exemption-repository.js';
import { ManualClock } from '../src/core/clock.js';
import { ConflictError, GateBlockedError, ProposalAlreadyDecidedError } from '../src/core/errors.js';
import type { ProposalInput } from '../src/core/types.js';

interface Harness {
  db: DB;
  clock: ManualClock;
  repo: ProposalRepository;
  exemptions: ExemptionRepository;
  dir: string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lineage-'));
  const db = openDatabase(join(dir, 'lineage.sqlite'));
  const clock = new ManualClock(1_000_000);
  const repo = new ProposalRepository(db, clock);
  const exemptions = new ExemptionRepository(db, clock, repo.events);
  repo.setExemptionRepository(exemptions);
  return { db, clock, repo, exemptions, dir };
}

function sampleProposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    topic: 'order.events',
    baseline: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' }, amt: { type: 'number', minimum: 0 } },
      required: ['id', 'amt'],
      additionalProperties: true,
    },
    candidate: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'string' },
        amt: { type: 'number', minimum: 0 },
        note: { type: 'string' },
      },
      required: ['id', 'amt'],
      additionalProperties: true,
    },
    consumers: [
      { consumerId: 'billing', schema: { type: 'object' } },
      { consumerId: 'payments', schema: { type: 'object' } },
    ],
    author: 'alice',
    ttlMs: 60000,
    ...overrides,
  };
}

function revisedCandidate(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { type: 'string' },
      amt: { type: 'number', minimum: 0 },
      note: { type: 'string' },
      channel: { type: 'string' },
    },
    required: ['id', 'amt'],
    additionalProperties: true,
  };
}

function evidence(
  proposalId: string,
  digest: string,
  consumerId: string,
  key: string,
  clock: ManualClock,
  status: 'pass' | 'fail' | 'error' = 'pass',
): EvidenceInput {
  return {
    proposalId,
    candidateDigest: digest,
    consumerId,
    status,
    detail: `${status} result`,
    reportedAt: clock.now(),
    idempotencyKey: key,
    agentRunId: 'run-1',
  };
}

function cleanup(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('successor has a new digest and a lineage link back to its predecessor', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    const { predecessor, successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
      note: 'revised',
    });

    assert.notEqual(successor.proposalId, pred.proposalId);
    assert.notEqual(successor.candidateDigest, pred.candidateDigest);
    assert.equal(successor.lineage.predecessorId, pred.proposalId);
    assert.equal(successor.lineage.successorId, null);
    assert.equal(successor.lineage.note, 'revised');

    assert.equal(predecessor.status, 'superseded');
    assert.equal(predecessor.lineage.successorId, successor.proposalId);
    assert.equal(predecessor.lineage.supersededBy, 'dave');
    assert.ok(predecessor.lineage.supersededAt);

    const refreshed = h.repo.requireById(pred.proposalId);
    assert.equal(refreshed.status, 'superseded');
    assert.equal(refreshed.lineage.successorId, successor.proposalId);
  } finally {
    cleanup(h);
  }
});

test('successor starts with no evidence or exemptions, even when names match the predecessor', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'k1', h.clock));
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'payments', 'k2', h.clock));

    h.exemptions.request({
      proposalId: pred.proposalId,
      consumerId: 'billing',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 3600000,
    });

    const { successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
    });

    assert.equal(h.repo.getEvidence(successor.proposalId).length, 0);
    assert.equal(h.exemptions.listForProposal(successor.proposalId).length, 0);
    assert.equal(h.repo.getEvidence(pred.proposalId).length, 2);
  } finally {
    cleanup(h);
  }
});

test('creating a successor revokes all pending and approved exemptions on the predecessor by exact scope', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());

    const ex = h.exemptions.request({
      proposalId: pred.proposalId,
      consumerId: 'billing',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 3600000,
    });
    h.exemptions.review({ exemptionId: ex.exemptionId, reviewer: 'bob', approved: true, comment: 'ok' });
    h.exemptions.review({ exemptionId: ex.exemptionId, reviewer: 'carol', approved: true, comment: 'ok' });

    const pending = h.exemptions.request({
      proposalId: pred.proposalId,
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 3600000,
    });

    h.repo.createSuccessor(pred.proposalId, { candidate: revisedCandidate(), author: 'dave' });

    const approvedAfter = h.exemptions.getById(ex.exemptionId)!;
    assert.equal(approvedAfter.status, 'revoked');
    assert.equal(approvedAfter.revokedBy, 'dave');
    const pendingAfter = h.exemptions.getById(pending.exemptionId)!;
    assert.equal(pendingAfter.status, 'revoked');

    const events = h.repo.events.readForProposal(pred.proposalId);
    const revocations = events.filter((e) => e.eventType === 'exemption-revoked');
    assert.equal(revocations.length, 2);
    for (const e of revocations) {
      const payload = e.payload as { reason: string };
      assert.equal(payload.reason, 'proposal-superseded');
    }
    assert.ok(events.some((e) => e.eventType === 'proposal-superseded'));
  } finally {
    cleanup(h);
  }
});

test('late evidence arriving at a superseded predecessor is rejected and attributed to it, never the successor', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'k1', h.clock));

    const { successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
    });

    const late = h.repo.ingestEvidence(
      evidence(pred.proposalId, pred.candidateDigest, 'payments', 'late-k', h.clock),
    );
    assert.equal(late.accepted, false);
    assert.equal(late.reason, 'proposal-superseded');

    assert.equal(h.repo.getEvidence(pred.proposalId).length, 1);
    assert.equal(h.repo.getEvidence(successor.proposalId).length, 0);

    const events = h.repo.events.readForProposal(pred.proposalId);
    const rejection = events.find(
      (e) => e.eventType === 'evidence-rejected',
    ) as { payload: { reason: string; successorId?: string } } | undefined;
    assert.ok(rejection);
    assert.equal(rejection.payload.reason, 'proposal-superseded');
    assert.equal(rejection.payload.successorId, successor.proposalId);

    const successorEvents = h.repo.events.readForProposal(successor.proposalId);
    assert.ok(!successorEvents.some((e) => e.eventType === 'evidence-rejected'));
  } finally {
    cleanup(h);
  }
});

test('concurrent old results cannot release the successor; it stays blocked until its own evidence arrives', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'k1', h.clock));
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'payments', 'k2', h.clock));

    const { successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
    });

    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'late1', h.clock));
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'payments', 'late2', h.clock));

    const view = h.repo.refreshGateStatus(successor.proposalId);
    assert.ok(view.blockers.length >= 2, `successor should be blocked, got ${view.blockers.length}`);
    assert.equal(view.proposal.status, 'open');

    assert.throws(
      () => h.repo.decide({ proposalId: successor.proposalId, kind: 'approve', decider: 'mgr', rationale: 'nope' }),
      GateBlockedError,
    );
  } finally {
    cleanup(h);
  }
});

test('a superseded proposal cannot be decided or superseded again', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    const { successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
    });

    assert.throws(
      () => h.repo.decide({ proposalId: pred.proposalId, kind: 'approve', decider: 'mgr', rationale: 'x' }),
      ConflictError,
    );

    assert.throws(
      () =>
        h.repo.createSuccessor(pred.proposalId, {
          candidate: revisedCandidate(),
          author: 'eve',
        }),
      ConflictError,
    );

    void successor;
  } finally {
    cleanup(h);
  }
});

test('a decided (approved/rejected) predecessor cannot be superseded', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'k1', h.clock));
    h.repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'payments', 'k2', h.clock));
    h.repo.refreshGateStatus(pred.proposalId);
    h.repo.decide({ proposalId: pred.proposalId, kind: 'approve', decider: 'mgr', rationale: 'ok' });

    assert.throws(
      () => h.repo.createSuccessor(pred.proposalId, { candidate: revisedCandidate(), author: 'dave' }),
      ProposalAlreadyDecidedError,
    );
  } finally {
    cleanup(h);
  }
});

test('restart recovery preserves lineage and the successor remains blocked until re-verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lineage-restart-'));
  const dbPath = join(dir, 'restart.sqlite');
  const clock = new ManualClock(1_000_000);
  let db = openDatabase(dbPath);
  let repo = new ProposalRepository(db, clock);
  let exemptions = new ExemptionRepository(db, clock, repo.events);
  repo.setExemptionRepository(exemptions);

  let successorId = '';
  let predecessorId = '';
  try {
    const { proposal: pred } = repo.create(sampleProposal());
    predecessorId = pred.proposalId;
    repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'billing', 'k1', clock));
    repo.ingestEvidence(evidence(pred.proposalId, pred.candidateDigest, 'payments', 'k2', clock));
    const { successor } = repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
      note: 'pre-restart revision',
    });
    successorId = successor.proposalId;
    db.close();

    const db2 = openDatabase(dbPath);
    const clock2 = new ManualClock(clock.now());
    repo = new ProposalRepository(db2, clock2);
    exemptions = new ExemptionRepository(db2, clock2, repo.events);
    repo.setExemptionRepository(exemptions);

    const restoredPred = repo.requireById(predecessorId);
    assert.equal(restoredPred.status, 'superseded');
    assert.equal(restoredPred.lineage.successorId, successorId);

    const restoredSucc = repo.requireById(successorId);
    assert.equal(restoredSucc.lineage.predecessorId, predecessorId);
    assert.equal(restoredSucc.lineage.note, 'pre-restart revision');
    assert.equal(repo.getEvidence(successorId).length, 0);

    const late = repo.ingestEvidence(
      evidence(predecessorId, restoredPred.candidateDigest, 'billing', 'late-after-restart', clock2),
    );
    assert.equal(late.accepted, false);
    assert.equal(late.reason, 'proposal-superseded');

    const blocked = repo.refreshGateStatus(successorId);
    assert.ok(blocked.blockers.length >= 2);

    assert.equal(repo.events.verifyChain(predecessorId), true);
    assert.equal(repo.events.verifyChain(successorId), true);

    db2.close();
  } finally {
    try { db.open && db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('the audit chain records proposal-superseded with the successor id and new digest', () => {
  const h = makeHarness();
  try {
    const { proposal: pred } = h.repo.create(sampleProposal());
    const { successor } = h.repo.createSuccessor(pred.proposalId, {
      candidate: revisedCandidate(),
      author: 'dave',
      note: 'audit me',
    });

    const events = h.repo.events.readForProposal(pred.proposalId);
    const superseded = events.find((e) => e.eventType === 'proposal-superseded') as
      | { payload: { predecessorId: string; successorId: string; candidateDigest: string; supersededBy: string; note: string } }
      | undefined;
    assert.ok(superseded);
    assert.equal(superseded.payload.predecessorId, pred.proposalId);
    assert.equal(superseded.payload.successorId, successor.proposalId);
    assert.equal(superseded.payload.candidateDigest, successor.candidateDigest);
    assert.equal(superseded.payload.supersededBy, 'dave');
    assert.equal(superseded.payload.note, 'audit me');

    const created = h.repo.events.readForProposal(successor.proposalId);
    assert.ok(created.some((e) => e.eventType === 'proposal-created'));
    assert.equal(h.repo.events.verifyChain(pred.proposalId), true);
    assert.equal(h.repo.events.verifyChain(successor.proposalId), true);
  } finally {
    cleanup(h);
  }
});
