import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../../src/domain/gate.ts';
import type { ActiveWaiver, AppliedEvidence, CompatReport, GateInput } from '../../src/domain/types.ts';

const compat: CompatReport = { result: 'COMPATIBLE', changes: [] };
const DIGEST = 'sha256:cand';
const ENV = 'production';

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

function waiver(over: Partial<ActiveWaiver> & { consumerId: string; expiresAt: number }): ActiveWaiver {
  return {
    waiverId: over.waiverId ?? `w-${over.consumerId}`,
    scope: {
      candidateDigest: over.scope?.candidateDigest ?? DIGEST,
      consumerId: over.consumerId,
      environment: over.scope?.environment ?? ENV,
      compatDirection: over.scope?.compatDirection ?? 'COMPATIBLE'
    },
    expiresAt: over.expiresAt
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
    candidateDigest: DIGEST,
    environment: ENV,
    waivers: [],
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

// --- waivers ---------------------------------------------------------------

test('active waiver covers a MISSING consumer -> WAIVED, gate READY', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      appliedEvidence: [],
      now: 100,
      waivers: [waiver({ consumerId: 'a', expiresAt: 1000 })]
    })
  );
  assert.equal(r.consumers[0].status, 'WAIVED');
  assert.equal(r.status, 'READY');
  assert.equal(r.canApprove, true);
  assert.equal(r.appliedWaivers.length, 1);
});

test('active waiver covers a STALE consumer', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      now: 5000,
      freshnessWindowMs: 1000,
      appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS', producedAt: 0 })],
      waivers: [waiver({ consumerId: 'a', expiresAt: 6000 })]
    })
  );
  assert.equal(r.consumers[0].status, 'WAIVED');
  assert.equal(r.status, 'READY');
});

test('a FAIL is never waived, even with a matching waiver', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      appliedEvidence: [ev({ consumerId: 'a', verdict: 'FAIL' })],
      waivers: [waiver({ consumerId: 'a', expiresAt: 1000 })]
    })
  );
  assert.equal(r.consumers[0].status, 'FAIL');
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.canApprove, false);
});

test('expired waiver does not participate; produces advisory', () => {
  const r = evaluateGate(
    input({
      requiredConsumers: ['a'],
      appliedEvidence: [],
      now: 1000,
      waivers: [waiver({ consumerId: 'a', expiresAt: 1000 })] // now >= expiresAt
    })
  );
  assert.equal(r.consumers[0].status, 'MISSING');
  assert.equal(r.status, 'COLLECTING');
  assert.ok(r.advisories.some((a) => a.includes('expired')));
});

test('waiver with wrong scope does not apply (digest/env/consumer/direction)', () => {
  const wrongDigest = waiver({ consumerId: 'a', expiresAt: 1000, scope: { candidateDigest: 'sha256:other', consumerId: 'a', environment: ENV, compatDirection: 'COMPATIBLE' } });
  const wrongEnv = waiver({ consumerId: 'a', expiresAt: 1000, scope: { candidateDigest: DIGEST, consumerId: 'a', environment: 'staging', compatDirection: 'COMPATIBLE' } });
  const wrongDir = waiver({ consumerId: 'a', expiresAt: 1000, scope: { candidateDigest: DIGEST, consumerId: 'a', environment: ENV, compatDirection: 'BREAKING' } });
  const wrongConsumer = waiver({ consumerId: 'b', expiresAt: 1000 });
  for (const w of [wrongDigest, wrongEnv, wrongDir, wrongConsumer]) {
    const r = evaluateGate(input({ requiredConsumers: ['a'], appliedEvidence: [], waivers: [w] }));
    assert.equal(r.status, 'COLLECTING', `waiver ${JSON.stringify(w.scope)} should not apply`);
  }
});

test('fingerprint changes when an applied waiver is present', () => {
  const withoutWaiver = evaluateGate(input({ requiredConsumers: ['a'], appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' })] }));
  const withWaiver = evaluateGate(
    input({ requiredConsumers: ['a'], appliedEvidence: [], now: 10, waivers: [waiver({ consumerId: 'a', expiresAt: 1000 })] })
  );
  assert.notEqual(withoutWaiver.evidenceFingerprint, withWaiver.evidenceFingerprint);
});

test('different environment yields different fingerprint', () => {
  const prod = evaluateGate(input({ requiredConsumers: ['a'], appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' })], environment: 'production' }));
  const stg = evaluateGate(input({ requiredConsumers: ['a'], appliedEvidence: [ev({ consumerId: 'a', verdict: 'PASS' })], environment: 'staging' }));
  assert.notEqual(prod.evidenceFingerprint, stg.evidenceFingerprint);
});
