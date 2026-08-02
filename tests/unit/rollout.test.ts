import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReceipt, nextWaveStatus, type RolloutView, type IncomingReceipt } from '../../src/domain/rollout.ts';

const FP = 'sha256:decision-fingerprint';

function rollout(overrides: Partial<RolloutView> = {}): RolloutView {
  return {
    rolloutId: 'ro-1',
    status: 'IN_PROGRESS',
    binding: {
      decisionId: 'd-1',
      proposalId: 'p-1',
      candidateDigest: 'sha256:cand',
      evidenceFingerprint: FP,
      environment: 'production'
    },
    waves: [
      { waveId: 'w-1', ordinal: 1, status: 'SUCCEEDED', attempt: 1 },
      { waveId: 'w-2', ordinal: 2, status: 'IN_PROGRESS', attempt: 1 }
    ],
    ...overrides
  };
}

function receipt(overrides: Partial<IncomingReceipt> = {}): IncomingReceipt {
  return {
    rolloutId: 'ro-1',
    waveId: 'w-2',
    attempt: 1,
    result: 'SUCCESS',
    evidenceFingerprint: FP,
    ...overrides
  };
}

test('a matching receipt for the live wave attempt advances', () => {
  const d = classifyReceipt(rollout(), receipt());
  assert.deepEqual(d, { kind: 'ADVANCE', result: 'SUCCESS' });
});

test('a receipt bound to a different decision fingerprint is inert', () => {
  const d = classifyReceipt(rollout(), receipt({ evidenceFingerprint: 'sha256:other' }));
  assert.equal(d.kind, 'IGNORE');
});

test('a receipt for a paused rollout is inert', () => {
  const d = classifyReceipt(rollout({ status: 'PAUSED' }), receipt());
  assert.equal(d.kind, 'IGNORE');
});

test('a receipt for a terminal rollout is inert', () => {
  for (const status of ['COMPLETED', 'FAILED', 'ROLLED_BACK', 'PENDING'] as const) {
    const d = classifyReceipt(rollout({ status }), receipt());
    assert.equal(d.kind, 'IGNORE', `status ${status}`);
  }
});

test('a receipt naming a non-current wave is inert (out of order)', () => {
  const d = classifyReceipt(rollout(), receipt({ waveId: 'w-1' }));
  assert.equal(d.kind, 'IGNORE');
});

test('a receipt for a stale attempt is inert', () => {
  // Current attempt is 1; a receipt for attempt 0 (superseded) or 2 (future) is inert.
  assert.equal(classifyReceipt(rollout(), receipt({ attempt: 0 })).kind, 'IGNORE');
  assert.equal(classifyReceipt(rollout(), receipt({ attempt: 2 })).kind, 'IGNORE');
});

test('a receipt when no wave is in progress is inert', () => {
  const r = rollout({
    waves: [{ waveId: 'w-1', ordinal: 1, status: 'SUCCEEDED', attempt: 1 }]
  });
  const d = classifyReceipt(r, receipt({ waveId: 'w-1' }));
  assert.equal(d.kind, 'IGNORE');
});

test('nextWaveStatus maps results; UNKNOWN is non-decisive', () => {
  assert.equal(nextWaveStatus('SUCCESS'), 'SUCCEEDED');
  assert.equal(nextWaveStatus('FAILURE'), 'FAILED');
  assert.equal(nextWaveStatus('UNKNOWN'), 'IN_PROGRESS');
});

test('an UNKNOWN receipt still advances (classification), but leaves the wave in progress', () => {
  const d = classifyReceipt(rollout(), receipt({ result: 'UNKNOWN' }));
  assert.deepEqual(d, { kind: 'ADVANCE', result: 'UNKNOWN' });
  assert.equal(nextWaveStatus('UNKNOWN'), 'IN_PROGRESS');
});
