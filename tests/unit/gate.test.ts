import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../../src/domain/gate.ts';
import type { AppliedEvidence, CompatReport, GateInput } from '../../src/domain/types.ts';

const compat: CompatReport = { result: 'COMPATIBLE', changes: [] };

function ev(partial: Partial<AppliedEvidence> & { consumerId: string; verdict: 'PASS' | 'FAIL' }): AppliedEvidence {
  return {
    reportId: partial.reportId ?? `r-${partial.consumerId}`,
    consumerId: partial.consumerId,
    verdict: partial.verdict,
    producedAt: partial.producedAt ?? 0,
    receivedAt: partial.receivedAt ?? 0,
    detail: partial.detail
  };
}

function input(over: Partial<GateInput>): GateInput {
  return {
    requiredConsumers: ['a', 'b'],
    appliedEvidence: [],
    compat,
    submittedAt: 0,
    now: 0,
    freshnessWindowMs: 1000,
    ...over
  };
}

test('all fresh PASS -> READY and canApprove', () => {
  const r = evaluateGate(input({ appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' }), ev({ consumerId: 'b', verdict: 'PASS' })] }));
  assert.equal(r.status, 'READY');
  assert.equal(r.canApprove, true);
});

test('missing consumer -> COLLECTING, cannot approve', () => {
  const r = evaluateGate(input({ appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' })] }));
  assert.equal(r.status, 'COLLECTING');
  assert.equal(r.canApprove, false);
  assert.ok(r.blockingReasons.some((x) => x.includes('b')));
});

test('any FAIL -> BLOCKED', () => {
  const r = evaluateGate(input({ appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' }), ev({ consumerId: 'b', verdict: 'FAIL' })] }));
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.canApprove, false);
});

test('stale evidence -> COLLECTING', () => {
  const r = evaluateGate(
    input({
      now: 5000,
      freshnessWindowMs: 1000,
      appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS', producedAt: 0 }), ev({ consumerId: 'b', verdict: 'PASS', producedAt: 4900 })]
    })
  );
  const a = r.consumers.find((c) => c.consumerId === 'a')!;
  assert.equal(a.status, 'STALE');
  assert.equal(r.status, 'COLLECTING');
});

test('newest report per consumer wins regardless of arrival order', () => {
  // Older FAIL arrives after newer PASS; newest producedAt should win.
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      appliedEvidence: [
        ev({ consumerId: 'a', verdict: 'PASS', producedAt: 100, receivedAt: 10, reportId: 'new' }),
        ev({ consumerId: 'a', verdict: 'FAIL', producedAt: 50, receivedAt: 20, reportId: 'old' })
      ]
    })
  );
  assert.equal(r.status, 'READY');
  assert.equal(r.consumers[0].reportId, 'new');
});

test('evidence for non-required consumer does not count', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' }), ev({ consumerId: 'rogue', verdict: 'FAIL' })]
    })
  );
  assert.equal(r.status, 'READY');
});

test('fingerprint is stable for same winning evidence, changes when evidence changes', () => {
  const base = input({ requiredConsumers: ['a'], appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS', reportId: 'r1', producedAt: 1 })] });
  const f1 = evaluateGate(base).evidenceFingerprint;
  const f2 = evaluateGate(base).evidenceFingerprint;
  assert.equal(f1, f2);
  const changed = evaluateGate(
    input({ requiredConsumers: ['a'], appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS', reportId: 'r2', producedAt: 2 })] })
  ).evidenceFingerprint;
  assert.notEqual(f1, changed);
});

test('BREAKING compat adds an advisory but does not block a fresh PASS gate', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      compat: { result: 'BREAKING', changes: [] },
      appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' })]
    })
  );
  assert.equal(r.status, 'READY');
  assert.ok(r.advisories.length > 0);
});
