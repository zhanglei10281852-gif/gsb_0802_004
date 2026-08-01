import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from './clock.js';
import { computeBlockers, computeFreshness, canTransition, isTerminal, isReady } from './gate.js';
import type { CompatibilityReport, EvidenceRecord, StoredProposal } from './types.js';

const clock = new ManualClock(1000);

const compat: CompatibilityReport = {
  compatible: true,
  violations: [],
  comparedAt: 0,
  baselineDigest: 'b'.repeat(64),
  candidateDigest: 'c'.repeat(64),
};

function proposal(status: StoredProposal['status'] = 'collecting', ttlMs = 1000): StoredProposal {
  return {
    proposalId: 'p1',
    topic: 't',
    baseline: {},
    candidate: {},
    candidateDigest: 'c',
    baselineDigest: 'b',
    compatibility: compat,
    consumers: [
      { consumerId: 'a', schema: {} },
      { consumerId: 'b', schema: {} },
    ],
    author: 'x',
    status,
    createdAt: 0,
    ttlMs,
    decidedAt: null,
    decision: null,
  };
}

function ev(consumerId: string, status: EvidenceRecord['status'], receivedAt: number, key = 'k'): EvidenceRecord {
  return {
    evidenceId: `e-${consumerId}-${key}`,
    proposalId: 'p1',
    candidateDigest: 'c',
    consumerId,
    status,
    detail: '',
    reportedAt: receivedAt,
    receivedAt,
    idempotencyKey: key,
    agentRunId: 'r',
  };
}

test('missing evidence blocks', () => {
  const blockers = computeBlockers(compat, proposal().consumers, [], 1000, clock, 'collecting');
  assert.equal(blockers.length, 2);
  assert.ok(blockers.every((b) => b.code === 'missing-evidence'));
});

test('all passing fresh evidence means ready', () => {
  const evidence = [ev('a', 'pass', 900), ev('b', 'pass', 950)];
  const blockers = computeBlockers(compat, proposal().consumers, evidence, 1000, clock, 'collecting');
  assert.equal(isReady(blockers), true);
});

test('stale evidence blocks', () => {
  clock.set(5000);
  const evidence = [ev('a', 'pass', 900), ev('b', 'pass', 950)];
  const blockers = computeBlockers(compat, proposal().consumers, evidence, 1000, clock, 'collecting');
  assert.ok(blockers.some((b) => b.code === 'stale-evidence'));
});

test('fail evidence blocks even when fresh', () => {
  clock.set(1000);
  const evidence = [ev('a', 'pass', 900), ev('b', 'fail', 950)];
  const blockers = computeBlockers(compat, proposal().consumers, evidence, 1000, clock, 'collecting');
  assert.ok(blockers.some((b) => b.code === 'failing-evidence'));
});

test('incompatible schema blocks when not all consumers verified or exempted', () => {
  const bad: CompatibilityReport = { ...compat, compatible: false, violations: [{ path: '', kind: 'minimum-raised', message: 'x' }] };
  const withAllPassing = computeBlockers(bad, proposal().consumers, [ev('a', 'pass', 900), ev('b', 'pass', 950)], 1000, clock, 'collecting');
  assert.equal(withAllPassing.some((b) => b.code === 'incompatible-schema'), false);

  const oneMissing = computeBlockers(bad, proposal().consumers, [ev('a', 'pass', 900)], 1000, clock, 'collecting');
  assert.ok(oneMissing.some((b) => b.code === 'incompatible-schema'));
});

test('already-decided proposals are terminal and block further', () => {
  const blockers = computeBlockers(compat, proposal('approved').consumers, [], 1000, clock, 'approved');
  assert.ok(blockers.some((b) => b.code === 'already-decided'));
  assert.equal(isTerminal('approved'), true);
  assert.equal(isTerminal('rejected'), true);
  assert.equal(isTerminal('collecting'), false);
});

test('freshness reports missing/stale/fresh', () => {
  clock.set(5000);
  const f = computeFreshness(proposal().consumers, [ev('a', 'pass', 4500)], 1000, clock);
  assert.equal(f.a!.status, 'fresh');
  assert.equal(f.b!.status, 'missing');
  clock.set(7000);
  const f2 = computeFreshness(proposal().consumers, [ev('a', 'pass', 4500)], 1000, clock);
  assert.equal(f2.a!.status, 'stale');
});

test('transition rules', () => {
  assert.equal(canTransition('open', 'collecting'), true);
  assert.equal(canTransition('collecting', 'ready'), true);
  assert.equal(canTransition('ready', 'approved'), true);
  assert.equal(canTransition('approved', 'rejected'), false);
});
