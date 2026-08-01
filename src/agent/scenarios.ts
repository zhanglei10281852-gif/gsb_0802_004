import type { Scenario } from './scenario.js';

const baseline = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
  },
  required: ['orderId', 'amount', 'currency'],
  additionalProperties: false,
};

const candidate = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
    note: { type: 'string' },
  },
  required: ['orderId', 'amount', 'currency'],
  additionalProperties: false,
};

const consumerSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
};

export function happyPathScenario(): Scenario {
  return {
    name: 'happy-path',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
      { consumerId: 'shipping', schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass', detail: 'compiled against candidate' },
      { action: 'report', consumerId: 'payments', result: 'pass', detail: 'contract tests pass' },
      { action: 'report', consumerId: 'shipping', result: 'pass', detail: 'consumer schema validates' },
      { action: 'expect-blockers', minBlockers: 0 },
      { action: 'decide', kind: 'approve', decider: 'release-bot' },
    ],
  };
}

export function duplicateEvidenceScenario(): Scenario {
  return {
    name: 'duplicate-evidence',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass', duplicate: true },
      { action: 'report', consumerId: 'payments', result: 'pass', duplicate: true },
      { action: 'expect-blockers', minBlockers: 0 },
      { action: 'decide', kind: 'approve' },
    ],
  };
}

export function staleEvidenceScenario(): Scenario {
  return {
    name: 'stale-evidence',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
    ],
    ttlMs: 30000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass' },
      { action: 'report', consumerId: 'payments', result: 'pass' },
      { action: 'advance-clock', ms: 31000 },
      { action: 'expect-blockers', minBlockers: 2 },
      { action: 'decide', kind: 'approve', expectBlocked: true },
      { action: 'report', consumerId: 'billing', result: 'pass' },
      { action: 'report', consumerId: 'payments', result: 'pass' },
      { action: 'advance-clock', ms: 1000 },
      { action: 'expect-blockers', minBlockers: 0 },
      { action: 'decide', kind: 'approve' },
    ],
  };
}

export function crashAfterWriteScenario(): Scenario {
  return {
    name: 'crash-after-write',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass', crashAfterWrite: true },
      { action: 'restart-server' },
      { action: 'report', consumerId: 'billing', result: 'pass' },
      { action: 'report', consumerId: 'payments', result: 'pass' },
      { action: 'expect-blockers', minBlockers: 0 },
      { action: 'decide', kind: 'approve' },
    ],
  };
}

export function wrongDigestScenario(): Scenario {
  return {
    name: 'wrong-digest-rejected',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [{ consumerId: 'billing', schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass', wrongDigest: true },
      { action: 'expect-blockers', minBlockers: 1 },
    ],
  };
}

export function unknownConsumerScenario(): Scenario {
  return {
    name: 'unknown-consumer-rejected',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [{ consumerId: 'billing', schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'analytics', result: 'pass', unknownConsumer: true },
      { action: 'expect-blockers', minBlockers: 1 },
    ],
  };
}

export function exemptionApprovedScenario(): Scenario {
  return {
    name: 'exemption-approved',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: 'report', consumerId: 'billing', result: 'pass' },
      { action: 'expect-blockers', minBlockers: 1 },
      {
        action: 'request-exemption',
        consumerId: 'payments',
        environment: 'prod',
        direction: 'backward',
        requestedBy: 'alice',
        ttlMs: 3600000,
        captureExemptionAs: 'ex1',
      },
      { action: 'expect-blockers', minBlockers: 1 },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'bob', approved: true, comment: 'lgtm' },
      { action: 'expect-blockers', minBlockers: 1 },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'carol', approved: true, comment: 'agreed' },
      { action: 'expect-blockers', minBlockers: 0, expectAppliedExemptions: 1 },
      { action: 'decide', kind: 'approve', decider: 'release-mgr' },
    ],
  };
}

export function exemptionExpiryScenario(): Scenario {
  return {
    name: 'exemption-expiry',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [{ consumerId: 'billing', schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: 'request-exemption',
        consumerId: 'billing',
        environment: 'prod',
        direction: 'backward',
        requestedBy: 'alice',
        ttlMs: 30000,
        captureExemptionAs: 'ex1',
      },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'bob', approved: true },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'carol', approved: true },
      { action: 'expect-blockers', minBlockers: 0, expectAppliedExemptions: 1 },
      { action: 'advance-clock', ms: 31000 },
      { action: 'expect-blockers', minBlockers: 1, expectAppliedExemptions: 0 },
      { action: 'decide', kind: 'approve', decider: 'release-mgr', expectBlocked: true },
    ],
  };
}

export function exemptionRevokedScenario(): Scenario {
  return {
    name: 'exemption-revoked',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [{ consumerId: 'billing', schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: 'request-exemption',
        consumerId: 'billing',
        environment: 'prod',
        direction: 'backward',
        requestedBy: 'alice',
        ttlMs: 3600000,
        captureExemptionAs: 'ex1',
      },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'bob', approved: true },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'carol', approved: true },
      { action: 'expect-blockers', minBlockers: 0, expectAppliedExemptions: 1 },
      { action: 'revoke-exemption', exemptionId: 'ex1', revokedBy: 'bob' },
      { action: 'expect-blockers', minBlockers: 1, expectAppliedExemptions: 0 },
      { action: 'decide', kind: 'approve', decider: 'release-mgr', expectBlocked: true },
    ],
  };
}

export function exemptionRejectedScenario(): Scenario {
  return {
    name: 'exemption-rejected',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [{ consumerId: 'billing', schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: 'request-exemption',
        consumerId: 'billing',
        environment: 'prod',
        direction: 'backward',
        requestedBy: 'alice',
        ttlMs: 3600000,
        captureExemptionAs: 'ex1',
      },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'bob', approved: true },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'carol', approved: false, comment: 'risk too high' },
      { action: 'expect-blockers', minBlockers: 1, expectAppliedExemptions: 0 },
      { action: 'decide', kind: 'approve', decider: 'release-mgr', expectBlocked: true },
    ],
  };
}

export function exemptionScopeMismatchScenario(): Scenario {
  return {
    name: 'exemption-scope-mismatch',
    topic: 'order.events',
    baseline,
    candidate,
    consumers: [
      { consumerId: 'billing', schema: consumerSchema },
      { consumerId: 'payments', schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      {
        action: 'request-exemption',
        consumerId: 'billing',
        environment: 'staging',
        direction: 'backward',
        requestedBy: 'alice',
        ttlMs: 3600000,
        captureExemptionAs: 'ex1',
      },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'bob', approved: true },
      { action: 'review-exemption', exemptionId: 'ex1', reviewer: 'carol', approved: true },
      { action: 'expect-blockers', minBlockers: 2, environment: 'prod', expectAppliedExemptions: 0 },
      { action: 'report', consumerId: 'payments', result: 'pass' },
      { action: 'expect-blockers', minBlockers: 1, environment: 'prod', expectAppliedExemptions: 0 },
    ],
  };
}

export const scenarios: Record<string, () => Scenario> = {
  'happy-path': happyPathScenario,
  'duplicate-evidence': duplicateEvidenceScenario,
  'stale-evidence': staleEvidenceScenario,
  'crash-after-write': crashAfterWriteScenario,
  'wrong-digest': wrongDigestScenario,
  'unknown-consumer': unknownConsumerScenario,
  'exemption-approved': exemptionApprovedScenario,
  'exemption-expiry': exemptionExpiryScenario,
  'exemption-revoked': exemptionRevokedScenario,
  'exemption-rejected': exemptionRejectedScenario,
  'exemption-scope-mismatch': exemptionScopeMismatchScenario,
};
