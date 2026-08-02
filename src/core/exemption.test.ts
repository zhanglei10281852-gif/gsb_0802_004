import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_EXEMPTION_APPROVALS,
  appliedExemptionsDigest,
  directionCovers,
  effectiveExemptionStatus,
  exemptionMatchesScope,
  findActiveExemption,
  isExemptionActive,
  isExemptionApproved,
  toAppliedExemption,
} from './exemption.js';
import type { ExemptionRecord } from './types.js';

function makeExemption(overrides: Partial<ExemptionRecord> = {}): ExemptionRecord {
  return {
    exemptionId: 'ex1',
    proposalId: 'p1',
    candidateDigest: 'c'.repeat(64),
    consumerId: 'billing',
    environment: 'prod',
    direction: 'backward',
    reason: 'offline',
    requestedBy: 'alice',
    requestedAt: 1000,
    expiresAt: 2000,
    status: 'approved',
    reviews: [
      { reviewer: 'bob', reviewedAt: 1100, approved: true, comment: '' },
      { reviewer: 'carol', reviewedAt: 1200, approved: true, comment: '' },
    ],
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

test('requires two distinct approvals', () => {
  assert.equal(REQUIRED_EXEMPTION_APPROVALS, 2);
  assert.equal(isExemptionApproved(makeExemption({ reviews: [] })), false);
  assert.equal(
    isExemptionApproved(makeExemption({ reviews: [{ reviewer: 'bob', reviewedAt: 1, approved: true, comment: '' }] })),
    false,
  );
  assert.equal(
    isExemptionApproved(
      makeExemption({
        reviews: [
          { reviewer: 'bob', reviewedAt: 1, approved: true, comment: '' },
          { reviewer: 'carol', reviewedAt: 2, approved: true, comment: '' },
        ],
      }),
    ),
    true,
  );
});

test('expiry is computed lazily from clock without mutation', () => {
  const ex = makeExemption({ expiresAt: 5000, status: 'approved' });
  assert.equal(isExemptionActive(ex, 4999), true);
  assert.equal(isExemptionActive(ex, 5001), false);
  assert.equal(effectiveExemptionStatus(ex, 5001), 'expired');
  assert.equal(ex.status, 'approved');
});

test('revoked/rejected exemptions are never active', () => {
  assert.equal(isExemptionActive(makeExemption({ status: 'revoked' }), 1000), false);
  assert.equal(isExemptionActive(makeExemption({ status: 'rejected' }), 1000), false);
});

test('direction coverage: both covers everything; exact match required otherwise', () => {
  assert.equal(directionCovers('both', 'backward'), true);
  assert.equal(directionCovers('both', 'forward'), true);
  assert.equal(directionCovers('backward', 'backward'), true);
  assert.equal(directionCovers('backward', 'forward'), false);
  assert.equal(directionCovers('forward', 'backward'), false);
});

test('scope matching enforces exact candidate/consumer/environment/direction', () => {
  const ex = makeExemption();
  assert.equal(
    exemptionMatchesScope(ex, {
      candidateDigest: 'c'.repeat(64),
      consumerId: 'billing',
      environment: 'prod',
      direction: 'backward',
    }),
    true,
  );
  assert.equal(
    exemptionMatchesScope(ex, {
      candidateDigest: 'd'.repeat(64),
      consumerId: 'billing',
      environment: 'prod',
      direction: 'backward',
    }),
    false,
  );
  assert.equal(
    exemptionMatchesScope(ex, {
      candidateDigest: 'c'.repeat(64),
      consumerId: 'payments',
      environment: 'prod',
      direction: 'backward',
    }),
    false,
  );
  assert.equal(
    exemptionMatchesScope(ex, {
      candidateDigest: 'c'.repeat(64),
      consumerId: 'billing',
      environment: 'staging',
      direction: 'backward',
    }),
    false,
  );
});

test('findActiveExemption ignores expired and wrong-scope exemptions', () => {
  const ex = makeExemption({ expiresAt: 1000 });
  assert.ok(findActiveExemption([ex], {
    candidateDigest: ex.candidateDigest,
    consumerId: ex.consumerId,
    environment: ex.environment,
    direction: 'backward',
  }, 500));
  assert.equal(findActiveExemption([ex], {
    candidateDigest: ex.candidateDigest,
    consumerId: ex.consumerId,
    environment: ex.environment,
    direction: 'backward',
  }, 5000), undefined);
});

test('applied exemptions digest is stable and changes when set changes', () => {
  const ex = makeExemption();
  const applied = [toAppliedExemption(ex)];
  const d1 = appliedExemptionsDigest(applied);
  const d2 = appliedExemptionsDigest(applied);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
  const dEmpty = appliedExemptionsDigest([]);
  assert.notEqual(d1, dEmpty);
});
