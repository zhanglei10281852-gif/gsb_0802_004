import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../src/storage/schema.js';
import {
  ProposalRepository,
  type EvidenceInput,
} from '../src/storage/repository.js';
import { ExemptionRepository } from '../src/storage/exemption-repository.js';
import { RolloutRepository } from '../src/storage/rollout-repository.js';
import { ManualClock } from '../src/core/clock.js';
import { ConflictError } from '../src/core/errors.js';
import type { ProposalInput, ReceiptInput } from '../src/core/types.js';

interface Harness {
  db: DB;
  clock: ManualClock;
  repo: ProposalRepository;
  exemptions: ExemptionRepository;
  rollouts: RolloutRepository;
  dir: string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gate-rollout-'));
  const db = openDatabase(join(dir, 'rollout.sqlite'));
  const clock = new ManualClock(2_000_000);
  const repo = new ProposalRepository(db, clock);
  const exemptions = new ExemptionRepository(db, clock, repo.events);
  const rollouts = new RolloutRepository(db, clock, repo, repo.events);
  repo.setExemptionRepository(exemptions);
  return { db, clock, repo, exemptions, rollouts, dir };
}

function cleanup(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

function approveProposal(h: Harness): { proposalId: string; candidateDigest: string } {
  const { proposal } = h.repo.create(sampleProposal());
  const ev1: EvidenceInput = {
    proposalId: proposal.proposalId,
    candidateDigest: proposal.candidateDigest,
    consumerId: 'billing',
    status: 'pass',
    detail: 'ok',
    reportedAt: h.clock.now(),
    idempotencyKey: 'k1',
    agentRunId: 'r1',
  };
  const ev2: EvidenceInput = {
    proposalId: proposal.proposalId,
    candidateDigest: proposal.candidateDigest,
    consumerId: 'payments',
    status: 'pass',
    detail: 'ok',
    reportedAt: h.clock.now(),
    idempotencyKey: 'k2',
    agentRunId: 'r1',
  };
  h.repo.ingestEvidence(ev1);
  h.repo.ingestEvidence(ev2);
  h.repo.refreshGateStatus(proposal.proposalId);
  h.repo.decide({
    proposalId: proposal.proposalId,
    kind: 'approve',
    decider: 'release-mgr',
    rationale: 'all green',
  });
  h.rollouts.drainEvents();
  return { proposalId: proposal.proposalId, candidateDigest: proposal.candidateDigest };
}

function receipt(
  rolloutId: string,
  waveSequence: number,
  result: 'success' | 'failure' | 'unknown',
  key: string,
  clock: ManualClock,
  detail = 'deployed',
): ReceiptInput {
  return {
    rolloutId,
    waveSequence,
    result,
    message: detail,
    reportedAt: clock.now(),
    idempotencyKey: key,
    adapterRunId: `adapter-${key}`,
  };
}

const WAVES = [
  { environment: 'canary', adapter: 'canary-adapter' },
  { environment: 'prod', adapter: 'prod-adapter' },
];

test('a rollout can only be created from an approved decision and is bound to its exact snapshot', () => {
  const h = makeHarness();
  try {
    const { proposal: notApproved } = h.repo.create(sampleProposal());
    assert.throws(
      () =>
        h.rollouts.create({
          proposalId: notApproved.proposalId,
          owner: 'mgr',
          waves: WAVES,
        }),
      ConflictError,
    );

    const { proposalId, candidateDigest } = approveProposal(h);
    const decided = h.repo.requireById(proposalId);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'release-mgr',
      waves: WAVES,
      previousVersion: 'v1.0.0',
      autoStart: false,
    });

    assert.equal(rollout.status, 'planned');
    assert.equal(rollout.snapshot.proposalId, proposalId);
    assert.equal(rollout.snapshot.candidateDigest, candidateDigest);
    assert.equal(rollout.snapshot.decisionKind, 'approve');
    assert.equal(rollout.snapshot.decider, 'release-mgr');
    assert.equal(rollout.snapshot.lastEventId, decided.decision!.lastEventId);
    assert.equal(rollout.currentWaveSequence, 0);
    assert.equal(rollout.waves.length, 2);
    assert.equal(rollout.waves[0]!.status, 'pending');
  } finally {
    cleanup(h);
  }
});

test('successful receipts advance waves in order; duplicate key is exactly-once effective', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: WAVES,
    });
    assert.equal(rollout.status, 'active');
    assert.equal(rollout.waves[0]!.status, 'deploying');

    const r1 = h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'key-1', h.clock),
    );
    assert.equal(r1.accepted, true);
    assert.equal(r1.deduped, false);

    let stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.waves[0]!.status, 'succeeded');
    assert.equal(stored.waves[1]!.status, 'deploying');
    assert.equal(stored.currentWaveSequence, 2);

    const dup = h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'key-1', h.clock),
    );
    assert.equal(dup.accepted, true);
    assert.equal(dup.deduped, true);
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.receipts.length, 1);
    assert.equal(stored.waves[1]!.status, 'deploying');

    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'success', 'key-2', h.clock),
    );
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.waves[1]!.status, 'succeeded');
  } finally {
    cleanup(h);
  }
});

test('out-of-order receipt for a future wave is rejected and cannot advance the rollout', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: WAVES,
    });

    const early = h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'success', 'early', h.clock),
    );
    assert.equal(early.accepted, false);
    assert.equal(early.reason, 'wave-not-current');

    const stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.currentWaveSequence, 1);
    assert.equal(stored.waves[1]!.status, 'pending');
    assert.equal(stored.receipts.length, 0);

    const events = h.repo.events.readForProposal(proposalId);
    assert.ok(events.some((e) => e.eventType === 'receipt-rejected'));
  } finally {
    cleanup(h);
  }
});

test('pause holds wave advancement; a success while paused records but does not advance until resume', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: WAVES,
    });

    h.rollouts.pause(rollout.rolloutId, 'on-call');
    let stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'paused');

    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'paused-key', h.clock),
    );
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.waves[0]!.status, 'succeeded');
    assert.equal(stored.waves[1]!.status, 'pending');
    assert.equal(stored.currentWaveSequence, 1);

    h.rollouts.resume(rollout.rolloutId, 'on-call');
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'active');
    assert.equal(stored.waves[1]!.status, 'deploying');
    assert.equal(stored.currentWaveSequence, 2);
  } finally {
    cleanup(h);
  }
});

test('unknown result leaves the wave retriable; retry resets it to deploying; failure fails the rollout', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: WAVES,
    });

    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'unknown', 'unk', h.clock, 'timeout'),
    );
    let stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'active');
    assert.equal(stored.waves[0]!.status, 'unknown');

    h.rollouts.retry(rollout.rolloutId, 1, 'on-call');
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.waves[0]!.status, 'deploying');
    assert.equal(stored.waves[0]!.attempts, 2);

    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'ok-after-retry', h.clock),
    );
    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'failure', 'fail', h.clock, 'smoke failed'),
    );
    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.waves[1]!.status, 'failed');
  } finally {
    cleanup(h);
  }
});

test('rollback marks the rollout rolled-back but does not alter the contract decision or revive exemptions', () => {
  const h = makeHarness();
  try {
    const { proposal: p } = h.repo.create(sampleProposal());
    const proposalId = p.proposalId;

    const ex = h.exemptions.request({
      proposalId,
      consumerId: 'billing',
      environment: 'prod',
      direction: 'backward',
      reason: 'offline',
      requestedBy: 'alice',
      ttlMs: 3600000,
    });
    h.exemptions.review({ exemptionId: ex.exemptionId, reviewer: 'bob', approved: true, comment: 'ok' });
    h.exemptions.review({ exemptionId: ex.exemptionId, reviewer: 'carol', approved: true, comment: 'ok' });

    h.repo.ingestEvidence({
      proposalId,
      candidateDigest: p.candidateDigest,
      consumerId: 'billing',
      status: 'pass',
      detail: 'ok',
      reportedAt: h.clock.now(),
      idempotencyKey: 'k1',
      agentRunId: 'r1',
    });
    h.repo.ingestEvidence({
      proposalId,
      candidateDigest: p.candidateDigest,
      consumerId: 'payments',
      status: 'pass',
      detail: 'ok',
      reportedAt: h.clock.now(),
      idempotencyKey: 'k2',
      agentRunId: 'r1',
    });
    h.repo.refreshGateStatus(proposalId);
    h.repo.decide({
      proposalId,
      kind: 'approve',
      decider: 'release-mgr',
      rationale: 'approved with billing exemption',
    });

    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: WAVES,
      previousVersion: 'v1.4.2',
    });
    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'canary', h.clock),
    );
    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'failure', 'prod-fail', h.clock),
    );

    const beforeDecision = JSON.stringify(h.repo.requireById(proposalId).decision);
    h.rollouts.rollback(rollout.rolloutId, 'on-call', 'revert to v1.4.2');

    const after = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(after.status, 'rolled-back');
    assert.equal(after.rollbackTargetWaveId, after.waves[1]!.waveId);
    assert.equal(after.previousVersion, 'v1.4.2');

    const proposalAfter = h.repo.requireById(proposalId);
    assert.equal(proposalAfter.status, 'approved');
    assert.equal(JSON.stringify(proposalAfter.decision), beforeDecision);

    const exemptionAfter = h.exemptions.getById(ex.exemptionId)!;
    assert.notEqual(exemptionAfter.status, 'revoked');
  } finally {
    cleanup(h);
  }
});

test('a rejected proposal cannot start a rollout, and only one active rollout per proposal', () => {
  const h = makeHarness();
  try {
    const { proposal: p } = h.repo.create(sampleProposal());
    h.repo.decide({
      proposalId: p.proposalId,
      kind: 'reject',
      decider: 'mgr',
      rationale: 'no',
    });
    assert.throws(
      () =>
        h.rollouts.create({
          proposalId: p.proposalId,
          owner: 'mgr',
          waves: WAVES,
        }),
      ConflictError,
    );

    h.clock.advance(1000);
    const { proposalId } = approveProposal(h);
    h.rollouts.create({ proposalId, owner: 'mgr', waves: WAVES });
    assert.throws(
      () =>
        h.rollouts.create({
          proposalId,
          owner: 'mgr',
          waves: WAVES,
        }),
      ConflictError,
    );
  } finally {
    cleanup(h);
  }
});

test('restart recovery preserves the rollout, waves, receipts and bound snapshot; hash chain verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-rollout-restart-'));
  const dbPath = join(dir, 'restart.sqlite');
  let db = openDatabase(dbPath);
  let clock = new ManualClock(2_000_000);
  let repo = new ProposalRepository(db, clock);
  let exemptions = new ExemptionRepository(db, clock, repo.events);
  let rollouts = new RolloutRepository(db, clock, repo, repo.events);
  repo.setExemptionRepository(exemptions);
  let rolloutId = '';
  let proposalId = '';
  try {
    const approved = (() => {
      const { proposal } = repo.create(sampleProposal());
      proposalId = proposal.proposalId;
      repo.ingestEvidence({
        proposalId: proposal.proposalId,
        candidateDigest: proposal.candidateDigest,
        consumerId: 'billing',
        status: 'pass',
        detail: 'ok',
        reportedAt: clock.now(),
        idempotencyKey: 'k1',
        agentRunId: 'r1',
      });
      repo.ingestEvidence({
        proposalId: proposal.proposalId,
        candidateDigest: proposal.candidateDigest,
        consumerId: 'payments',
        status: 'pass',
        detail: 'ok',
        reportedAt: clock.now(),
        idempotencyKey: 'k2',
        agentRunId: 'r1',
      });
      repo.refreshGateStatus(proposal.proposalId);
      repo.decide({
        proposalId: proposal.proposalId,
        kind: 'approve',
        decider: 'mgr',
        rationale: 'ok',
      });
      return proposal;
    })();

    const { rollout } = rollouts.create({
      proposalId: approved.proposalId,
      owner: 'mgr',
      waves: WAVES,
      previousVersion: 'v1.0.0',
    });
    rolloutId = rollout.rolloutId;
    rollouts.reportReceipt(receipt(rolloutId, 1, 'success', 'c1', clock));
    db.close();

    const db2 = openDatabase(dbPath);
    clock = new ManualClock(clock.now());
    repo = new ProposalRepository(db2, clock);
    exemptions = new ExemptionRepository(db2, clock, repo.events);
    rollouts = new RolloutRepository(db2, clock, repo, repo.events);
    repo.setExemptionRepository(exemptions);

    const restored = rollouts.requireById(rolloutId);
    assert.equal(restored.status, 'active');
    assert.equal(restored.currentWaveSequence, 2);
    assert.equal(restored.waves[0]!.status, 'succeeded');
    assert.equal(restored.waves[1]!.status, 'deploying');
    assert.equal(restored.receipts.length, 1);
    assert.equal(restored.snapshot.proposalId, proposalId);
    assert.equal(restored.snapshot.candidateDigest, approved.candidateDigest);
    assert.equal(restored.previousVersion, 'v1.0.0');

    const dup = rollouts.reportReceipt(receipt(rolloutId, 1, 'success', 'c1', clock));
    assert.equal(dup.deduped, true);

    rollouts.reportReceipt(receipt(rolloutId, 2, 'success', 'c2', clock));
    assert.equal(rollouts.requireById(rolloutId).status, 'completed');

    assert.equal(repo.events.verifyChain(proposalId), true);
    db2.close();
  } finally {
    try { db.open && db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('rollout lifecycle emits a complete causal chain on the bound proposal', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'mgr',
      waves: [{ environment: 'canary', adapter: 'canary-adapter' }],
    });
    h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 1, 'success', 'done', h.clock),
    );
    const events = h.repo.events.readForProposal(proposalId);
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes('rollout-created'));
    assert.ok(types.includes('rollout-started'));
    assert.ok(types.includes('wave-deploying'));
    assert.ok(types.includes('wave-result'));
    assert.ok(types.includes('rollout-completed'));
    assert.equal(h.repo.events.verifyChain(proposalId), true);
  } finally {
    cleanup(h);
  }
});
