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
import type { ProposalInput, ReceiptInput, RequiredConsumerAddition } from '../src/core/types.js';
import {
  computeCoverageGaps,
  requiredConsumers,
  shouldAutoPauseForGap,
  applyGapPause,
  canResume,
  resumeAfterReverification,
} from '../src/core/topology.js';

interface Harness {
  db: DB;
  clock: ManualClock;
  repo: ProposalRepository;
  exemptions: ExemptionRepository;
  rollouts: RolloutRepository;
  dir: string;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gate-topology-'));
  const db = openDatabase(join(dir, 'topology.sqlite'));
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
  for (const [i, consumerId] of ['billing', 'payments'].entries()) {
    h.repo.ingestEvidence({
      proposalId: proposal.proposalId,
      candidateDigest: proposal.candidateDigest,
      consumerId,
      status: 'pass',
      detail: 'ok',
      reportedAt: h.clock.now(),
      idempotencyKey: `k${i}`,
      agentRunId: 'r1',
    } satisfies EvidenceInput);
  }
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

function startRollout(h: Harness, proposalId: string) {
  const { rollout } = h.rollouts.create({
    proposalId,
    owner: 'release-mgr',
    waves: [
      { environment: 'canary', adapter: 'canary-adapter' },
      { environment: 'prod', adapter: 'prod-adapter' },
    ],
    previousVersion: 'v1.4.2',
  });
  return rollout;
}

function receipt(
  rolloutId: string,
  waveSequence: number,
  result: 'success' | 'failure' | 'unknown',
  key: string,
  clock: ManualClock,
): ReceiptInput {
  return {
    rolloutId,
    waveSequence,
    result,
    message: 'deployed',
    reportedAt: clock.now(),
    idempotencyKey: key,
    adapterRunId: `adapter-${key}`,
  };
}

function addition(consumerId: string, now: number, reverified = false): RequiredConsumerAddition {
  return {
    consumerId,
    addedAt: now,
    addedBy: 'platform-oncall',
    reason: 'became required',
    schema: { type: 'object' },
    reverifiedAt: reverified ? now : null,
    reverifiedBy: reverified ? 'agent-1' : null,
    evidenceId: reverified ? 'ev-x' : null,
  };
}

test('pure coverage gaps classify no-evidence, not-pass and stale; required set unions base + additions', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const proposal = h.repo.requireById(proposalId);
    const now = h.clock.now();
    const additions = [addition('analytics', now)];

    const ids = requiredConsumers(proposal, additions).map((c) => c.consumerId);
    assert.deepEqual(ids.sort(), ['analytics', 'billing', 'payments']);

    const evidence = h.repo.getEvidence(proposalId);
    let gaps = computeCoverageGaps(proposal, additions, evidence, now, proposal.ttlMs);
    assert.deepEqual(gaps, [{ consumerId: 'analytics', reason: 'no-evidence' }]);

    h.clock.advance(proposal.ttlMs + 1);
    gaps = computeCoverageGaps(proposal, additions, evidence, h.clock.now(), proposal.ttlMs);
    assert.ok(gaps.find((g) => g.consumerId === 'billing' && g.reason === 'stale'));
    assert.ok(gaps.find((g) => g.consumerId === 'analytics' && g.reason === 'no-evidence'));
  } finally {
    cleanup(h);
  }
});

test('adding a required consumer does not mutate the historical decision snapshot or consumers', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const before = h.repo.requireById(proposalId);
    const snapshotBefore = JSON.stringify(before.decision);
    const consumersBefore = JSON.stringify(before.consumers);

    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required mid-rollout',
      schema: { type: 'object' },
    });

    const after = h.repo.requireById(proposalId);
    assert.equal(JSON.stringify(after.decision), snapshotBefore);
    assert.equal(JSON.stringify(after.consumers), consumersBefore);
    assert.equal(after.consumers.length, 2);
    assert.ok(after.requiredConsumers.some((c) => c.consumerId === 'analytics'));
    assert.equal(after.additions!.length, 1);
    assert.equal(after.additions![0]!.reverifiedAt, null);

    const events = h.repo.events.readForProposal(proposalId);
    assert.ok(events.some((e) => e.eventType === 'topology-changed'));
    assert.equal(h.repo.events.verifyChain(proposalId), true);
  } finally {
    cleanup(h);
  }
});

test('a coverage gap auto-pauses an active rollout and blocks operator resume until verified', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const rollout = startRollout(h, proposalId);

    h.rollouts.reportReceipt(receipt(rollout.rolloutId, 1, 'success', 'canary', h.clock));
    let stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.currentWaveSequence, 2);

    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required mid-rollout',
      schema: { type: 'object' },
    });
    const { paused, gapConsumerIds: gaps } = h.rollouts.evaluateTopologyPause(proposalId);
    assert.deepEqual(paused, [rollout.rolloutId]);
    assert.deepEqual(gaps, ['analytics']);

    stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'paused');
    assert.equal(stored.pauseReason, 'topology-gap');
    assert.deepEqual(stored.gapConsumerIds, ['analytics']);
    assert.equal(stored.waves[1]!.status, 'deploying');

    assert.throws(
      () => h.rollouts.resume(rollout.rolloutId, 'operator'),
      ConflictError,
    );
  } finally {
    cleanup(h);
  }
});

test('a receipt that lands while topology-paused is recorded deterministically but does not complete the rollout', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const rollout = startRollout(h, proposalId);
    h.rollouts.reportReceipt(receipt(rollout.rolloutId, 1, 'success', 'canary', h.clock));

    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required',
      schema: { type: 'object' },
    });
    h.rollouts.evaluateTopologyPause(proposalId);

    const r = h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'success', 'prod-concurrent', h.clock),
    );
    assert.equal(r.accepted, true);
    assert.equal(r.deduped, false);

    const stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'paused');
    assert.equal(stored.waves[1]!.status, 'succeeded');
    assert.equal(stored.receipts.length, 2);

    const dup = h.rollouts.reportReceipt(
      receipt(rollout.rolloutId, 2, 'success', 'prod-concurrent', h.clock),
    );
    assert.equal(dup.accepted, true);
    assert.equal(dup.deduped, true);
    assert.equal(h.rollouts.requireById(rollout.rolloutId).receipts.length, 2);
  } finally {
    cleanup(h);
  }
});

test('re-verification PASS for the addition closes the gap, concludes on the lineage, and completes the rollout', () => {
  const h = makeHarness();
  try {
    const { proposalId, candidateDigest } = approveProposal(h);
    const rollout = startRollout(h, proposalId);
    h.rollouts.reportReceipt(receipt(rollout.rolloutId, 1, 'success', 'canary', h.clock));
    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required',
      schema: { type: 'object' },
    });
    h.rollouts.evaluateTopologyPause(proposalId);
    h.rollouts.reportReceipt(receipt(rollout.rolloutId, 2, 'success', 'prod', h.clock));

    const res = h.repo.ingestEvidence({
      proposalId,
      candidateDigest,
      consumerId: 'analytics',
      status: 'pass',
      detail: 're-verified against candidate',
      reportedAt: h.clock.now(),
      idempotencyKey: 'analytics-reverify',
      agentRunId: 'agent-reverify',
    });
    assert.equal(res.accepted, true);
    assert.equal(res.deduped, false);

    const additionAfter = h.repo.getAdditions(proposalId).find((a) => a.consumerId === 'analytics')!;
    assert.notEqual(additionAfter.reverifiedAt, null);
    assert.equal(additionAfter.reverifiedBy, 'agent-reverify');
    assert.ok(additionAfter.evidenceId);

    const resumed = h.rollouts.evaluateTopologyResume(proposalId);
    assert.deepEqual(resumed, [rollout.rolloutId]);

    const stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.pauseReason, null);
    assert.deepEqual(stored.gapConsumerIds, []);

    const events = h.repo.events.readForProposal(proposalId);
    assert.ok(events.some((e) => e.eventType === 'reverification-concluded'));
    assert.ok(events.some((e) => e.eventType === 'rollout-resumed'));
    assert.ok(events.some((e) => e.eventType === 'rollout-completed'));
    assert.equal(h.repo.events.verifyChain(proposalId), true);
  } finally {
    cleanup(h);
  }
});

test('re-verification with a non-PASS result keeps the gap and the rollout paused', () => {
  const h = makeHarness();
  try {
    const { proposalId, candidateDigest } = approveProposal(h);
    const rollout = startRollout(h, proposalId);
    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required',
      schema: { type: 'object' },
    });
    h.rollouts.evaluateTopologyPause(proposalId);

    h.repo.ingestEvidence({
      proposalId,
      candidateDigest,
      consumerId: 'analytics',
      status: 'fail',
      detail: 'incompatible',
      reportedAt: h.clock.now(),
      idempotencyKey: 'analytics-fail',
      agentRunId: 'agent-reverify',
    });
    const resumed = h.rollouts.evaluateTopologyResume(proposalId);
    assert.deepEqual(resumed, []);
    assert.equal(h.rollouts.requireById(rollout.rolloutId).status, 'paused');
  } finally {
    cleanup(h);
  }
});

test('topology additions preserve round 1-4 boundaries: decision and bound rollout snapshot stay immutable', () => {
  const h = makeHarness();
  try {
    const { proposalId, candidateDigest } = approveProposal(h);
    const decided = h.repo.requireById(proposalId);
    const decisionBefore = JSON.stringify(decided.decision);

    const { rollout } = h.rollouts.create({
      proposalId,
      owner: 'release-mgr',
      waves: [
        { environment: 'canary', adapter: 'canary-adapter' },
        { environment: 'prod', adapter: 'prod-adapter' },
      ],
      previousVersion: 'v1.4.2',
    });
    const boundSnapshot = JSON.stringify(rollout.snapshot);

    h.rollouts.reportReceipt(receipt(rollout.rolloutId, 1, 'success', 'canary', h.clock));
    h.repo.addRequiredConsumer({
      proposalId,
      consumerId: 'analytics',
      addedBy: 'platform-oncall',
      reason: 'required',
      schema: { type: 'object' },
    });
    h.rollouts.evaluateTopologyPause(proposalId);
    h.repo.ingestEvidence({
      proposalId,
      candidateDigest,
      consumerId: 'analytics',
      status: 'pass',
      detail: 're-verified',
      reportedAt: h.clock.now(),
      idempotencyKey: 'analytics-reverify',
      agentRunId: 'agent-reverify',
    });
    h.rollouts.evaluateTopologyResume(proposalId);

    const after = h.repo.requireById(proposalId);
    assert.equal(JSON.stringify(after.decision), decisionBefore);
    assert.equal(after.decision!.candidateDigest, candidateDigest);
    assert.equal(after.consumers.length, 2);

    const stored = h.rollouts.requireById(rollout.rolloutId);
    assert.equal(JSON.stringify(stored.snapshot), boundSnapshot);
    assert.equal(stored.snapshot.candidateDigest, candidateDigest);
    assert.equal(stored.snapshot.decisionKind, 'approve');
    assert.equal(stored.previousVersion, 'v1.4.2');
    assert.equal(h.repo.events.verifyChain(proposalId), true);
  } finally {
    cleanup(h);
  }
});

test('pure pause/resume helpers distinguish topology-gap from operator pauses', () => {
  const h = makeHarness();
  try {
    const { proposalId } = approveProposal(h);
    const rollout = startRollout(h, proposalId);
    const now = h.clock.now();
    const gaps = [{ consumerId: 'analytics', reason: 'no-evidence' as const }];

    assert.equal(shouldAutoPauseForGap(rollout, gaps), true);
    assert.equal(shouldAutoPauseForGap(rollout, []), false);

    const paused = applyGapPause(rollout, gaps, now);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'topology-gap');

    assert.equal(canResume(paused, gaps, 'operator'), false);
    assert.equal(canResume(paused, [], 'operator'), true);
    assert.equal(canResume(paused, gaps, 'system'), false);

    const operatorPaused = { ...rollout, status: 'paused' as const, pauseReason: 'operator' as const, gapConsumerIds: [] };
    assert.equal(canResume(operatorPaused, gaps, 'operator'), true);

    const resumed = resumeAfterReverification(paused, [], now);
    assert.ok(resumed);
    assert.equal(resumed!.status, 'active');
    assert.equal(resumeAfterReverification(paused, gaps, now), null);
  } finally {
    cleanup(h);
  }
});
