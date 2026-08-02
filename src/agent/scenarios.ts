import type { Scenario } from "./scenario.js";

const baseline = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    amount: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
  },
  required: ["orderId", "amount", "currency"],
  additionalProperties: false,
};

const candidate = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    orderId: { type: "string" },
    amount: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
    note: { type: "string" },
  },
  required: ["orderId", "amount", "currency"],
  additionalProperties: false,
};

const consumerSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
};

export function happyPathScenario(): Scenario {
  return {
    name: "happy-path",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
      { consumerId: "shipping", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      {
        action: "report",
        consumerId: "billing",
        result: "pass",
        detail: "compiled against candidate",
      },
      {
        action: "report",
        consumerId: "payments",
        result: "pass",
        detail: "contract tests pass",
      },
      {
        action: "report",
        consumerId: "shipping",
        result: "pass",
        detail: "consumer schema validates",
      },
      { action: "expect-blockers", minBlockers: 0 },
      { action: "decide", kind: "approve", decider: "release-bot" },
    ],
  };
}

export function duplicateEvidenceScenario(): Scenario {
  return {
    name: "duplicate-evidence",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      {
        action: "report",
        consumerId: "billing",
        result: "pass",
        duplicate: true,
      },
      {
        action: "report",
        consumerId: "payments",
        result: "pass",
        duplicate: true,
      },
      { action: "expect-blockers", minBlockers: 0 },
      { action: "decide", kind: "approve" },
    ],
  };
}

export function staleEvidenceScenario(): Scenario {
  return {
    name: "stale-evidence",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 30000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "advance-clock", ms: 31000 },
      { action: "expect-blockers", minBlockers: 2 },
      { action: "decide", kind: "approve", expectBlocked: true },
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "advance-clock", ms: 1000 },
      { action: "expect-blockers", minBlockers: 0 },
      { action: "decide", kind: "approve" },
    ],
  };
}

export function crashAfterWriteScenario(): Scenario {
  return {
    name: "crash-after-write",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      {
        action: "report",
        consumerId: "billing",
        result: "pass",
        crashAfterWrite: true,
      },
      { action: "restart-server" },
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "expect-blockers", minBlockers: 0 },
      { action: "decide", kind: "approve" },
    ],
  };
}

export function wrongDigestScenario(): Scenario {
  return {
    name: "wrong-digest-rejected",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: "report",
        consumerId: "billing",
        result: "pass",
        wrongDigest: true,
      },
      { action: "expect-blockers", minBlockers: 1 },
    ],
  };
}

export function unknownConsumerScenario(): Scenario {
  return {
    name: "unknown-consumer-rejected",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: "report",
        consumerId: "analytics",
        result: "pass",
        unknownConsumer: true,
      },
      { action: "expect-blockers", minBlockers: 1 },
    ],
  };
}

export function exemptionApprovedScenario(): Scenario {
  return {
    name: "exemption-approved",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "expect-blockers", minBlockers: 1 },
      {
        action: "request-exemption",
        consumerId: "payments",
        environment: "prod",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 3600000,
        captureExemptionAs: "ex1",
      },
      { action: "expect-blockers", minBlockers: 1 },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
        comment: "lgtm",
      },
      { action: "expect-blockers", minBlockers: 1 },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: true,
        comment: "agreed",
      },
      { action: "expect-blockers", minBlockers: 0, expectAppliedExemptions: 1 },
      { action: "decide", kind: "approve", decider: "release-mgr" },
    ],
  };
}

export function exemptionExpiryScenario(): Scenario {
  return {
    name: "exemption-expiry",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: "request-exemption",
        consumerId: "billing",
        environment: "prod",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 30000,
        captureExemptionAs: "ex1",
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: true,
      },
      { action: "expect-blockers", minBlockers: 0, expectAppliedExemptions: 1 },
      { action: "advance-clock", ms: 31000 },
      { action: "expect-blockers", minBlockers: 1, expectAppliedExemptions: 0 },
      {
        action: "decide",
        kind: "approve",
        decider: "release-mgr",
        expectBlocked: true,
      },
    ],
  };
}

export function exemptionRevokedScenario(): Scenario {
  return {
    name: "exemption-revoked",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: "request-exemption",
        consumerId: "billing",
        environment: "prod",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 3600000,
        captureExemptionAs: "ex1",
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: true,
      },
      { action: "expect-blockers", minBlockers: 0, expectAppliedExemptions: 1 },
      { action: "revoke-exemption", exemptionId: "ex1", revokedBy: "bob" },
      { action: "expect-blockers", minBlockers: 1, expectAppliedExemptions: 0 },
      {
        action: "decide",
        kind: "approve",
        decider: "release-mgr",
        expectBlocked: true,
      },
    ],
  };
}

export function exemptionRejectedScenario(): Scenario {
  return {
    name: "exemption-rejected",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      {
        action: "request-exemption",
        consumerId: "billing",
        environment: "prod",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 3600000,
        captureExemptionAs: "ex1",
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: false,
        comment: "risk too high",
      },
      { action: "expect-blockers", minBlockers: 1, expectAppliedExemptions: 0 },
      {
        action: "decide",
        kind: "approve",
        decider: "release-mgr",
        expectBlocked: true,
      },
    ],
  };
}

export function exemptionScopeMismatchScenario(): Scenario {
  return {
    name: "exemption-scope-mismatch",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      {
        action: "request-exemption",
        consumerId: "billing",
        environment: "staging",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 3600000,
        captureExemptionAs: "ex1",
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: true,
      },
      {
        action: "expect-blockers",
        minBlockers: 2,
        environment: "prod",
        expectAppliedExemptions: 0,
      },
      { action: "report", consumerId: "payments", result: "pass" },
      {
        action: "expect-blockers",
        minBlockers: 1,
        environment: "prod",
        expectAppliedExemptions: 0,
      },
    ],
  };
}

export function lineageSuccessorScenario(): Scenario {
  const revisedCandidate = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      orderId: { type: "string" },
      amount: { type: "number", minimum: 0 },
      currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
      note: { type: "string" },
      channel: { type: "string" },
    },
    required: ["orderId", "amount", "currency"],
    additionalProperties: false,
  };
  return {
    name: "lineage-successor",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "expect-blockers", minBlockers: 1 },
      {
        action: "request-exemption",
        consumerId: "payments",
        environment: "prod",
        direction: "backward",
        requestedBy: "alice",
        ttlMs: 3600000,
        captureExemptionAs: "ex1",
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "bob",
        approved: true,
      },
      {
        action: "review-exemption",
        exemptionId: "ex1",
        reviewer: "carol",
        approved: true,
      },
      { action: "expect-blockers", minBlockers: 0, expectAppliedExemptions: 1 },

      {
        action: "create-successor",
        candidate: revisedCandidate,
        author: "upstream-dave",
        note: "revised after review: removed enum narrowing",
        captureProposalAs: "succ1",
      },

      {
        action: "expect-status",
        targetProposal: "root",
        expectedStatus: "superseded",
      },
      {
        action: "expect-status",
        targetProposal: "succ1",
        expectedStatus: "open",
      },

      {
        action: "report-to-predecessor",
        consumerId: "payments",
        result: "pass",
        expectRejectedReason: "proposal-superseded",
      },

      {
        action: "report",
        targetProposal: "root",
        consumerId: "billing",
        result: "pass",
        expectRejectedReason: "proposal-superseded",
      },

      {
        action: "expect-blockers",
        targetProposal: "succ1",
        minBlockers: 2,
        maxBlockers: 2,
        expectAppliedExemptions: 0,
      },
      {
        action: "expect-blockers",
        targetProposal: "root",
        minBlockers: 1,
        maxBlockers: 1,
        expectAppliedExemptions: 0,
      },

      {
        action: "decide",
        targetProposal: "succ1",
        kind: "approve",
        expectBlocked: true,
      },

      {
        action: "report",
        targetProposal: "succ1",
        consumerId: "billing",
        result: "pass",
      },
      {
        action: "report",
        targetProposal: "succ1",
        consumerId: "payments",
        result: "pass",
      },
      { action: "expect-blockers", targetProposal: "succ1", minBlockers: 0 },
      {
        action: "decide",
        targetProposal: "succ1",
        kind: "approve",
        decider: "release-mgr",
      },
    ],
  };
}

export function lineageRecoveryScenario(): Scenario {
  const revisedCandidate = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      orderId: { type: "string" },
      amount: { type: "number", minimum: 0 },
      currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
      note: { type: "string" },
    },
    required: ["orderId", "amount", "currency"],
    additionalProperties: false,
  };
  return {
    name: "lineage-recovery",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [{ consumerId: "billing", schema: consumerSchema }],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "expect-blockers", minBlockers: 0 },
      {
        action: "create-successor",
        candidate: revisedCandidate,
        author: "upstream-dave",
        note: "revision before release",
        captureProposalAs: "succ1",
      },
      {
        action: "expect-status",
        targetProposal: "root",
        expectedStatus: "superseded",
      },

      { action: "crash-server" },
      { action: "restart-server" },

      {
        action: "expect-status",
        targetProposal: "root",
        expectedStatus: "superseded",
      },
      {
        action: "expect-status",
        targetProposal: "succ1",
        expectedStatus: "open",
      },
      {
        action: "report",
        targetProposal: "root",
        consumerId: "billing",
        result: "pass",
        expectRejectedReason: "proposal-superseded",
      },
      {
        action: "report",
        targetProposal: "succ1",
        consumerId: "billing",
        result: "pass",
      },
      { action: "expect-blockers", targetProposal: "succ1", minBlockers: 0 },
      {
        action: "decide",
        targetProposal: "succ1",
        kind: "approve",
        decider: "release-mgr",
      },
    ],
  };
}

export function rolloutPhasedScenario(): Scenario {
  return {
    name: "rollout-phased",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "expect-blockers", minBlockers: 0 },
      { action: "decide", kind: "approve", decider: "release-mgr" },

      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        previousVersion: "v1.4.2",
        captureRolloutAs: "r1",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "active",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        detail: "canary healthy",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        detail: "prod healthy",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "completed",
      },
    ],
  };
}

export function rolloutDuplicateOutOfOrderScenario(): Scenario {
  return {
    name: "rollout-duplicate-out-of-order",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "decide", kind: "approve", decider: "release-mgr" },
      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        captureRolloutAs: "r1",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-early",
        detail: "prod reported early (out of order)",
        expectAccepted: false,
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "pending",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-key",
        detail: "canary ok",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-key",
        detail: "canary ok (duplicate)",
        expectAccepted: true,
        expectDeduped: true,
      },
      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-key",
        detail: "prod ok",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "completed",
      },
    ],
  };
}

export function rolloutPauseResumeRollbackScenario(): Scenario {
  return {
    name: "rollout-pause-retry-rollback",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "decide", kind: "approve", decider: "release-mgr" },
      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        previousVersion: "v1.4.2",
        captureRolloutAs: "r1",
      },

      { action: "pause-rollout", targetRollout: "r1", pausedBy: "on-call" },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "paused",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-while-paused",
        detail: "canary finished during pause",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "pending",
      },

      { action: "resume-rollout", targetRollout: "r1", resumedBy: "on-call" },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "unknown",
        idempotencyKey: "prod-unknown",
        detail: "health check timed out",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "unknown",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "active",
      },

      {
        action: "retry-wave",
        targetRollout: "r1",
        waveSequence: 2,
        retriedBy: "on-call",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "failure",
        idempotencyKey: "prod-fail",
        detail: "smoke tests failed",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "failed",
      },

      {
        action: "rollback-rollout",
        targetRollout: "r1",
        rolledBackBy: "on-call",
        rollbackNote: "revert to v1.4.2",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "rolled-back",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "rolled-back",
      },
    ],
  };
}

export function rolloutReceiptLossRecoveryScenario(): Scenario {
  return {
    name: "rollout-receipt-loss-recovery",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "decide", kind: "approve", decider: "release-mgr" },
      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        captureRolloutAs: "r1",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-crash-key",
        detail: "canary ok, but server crashes before reply",
        crashAfterReceipt: true,
      },
      { action: "restart-server" },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-crash-key",
        detail: "canary ok (retried after crash)",
        expectAccepted: true,
        expectDeduped: true,
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 1,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-key",
        detail: "prod ok",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "completed",
      },
    ],
  };
}

export function rolloutTopologyChangeScenario(): Scenario {
  return {
    name: "rollout-topology-change",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "decide", kind: "approve", decider: "release-mgr" },
      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        previousVersion: "v1.4.2",
        captureRolloutAs: "r1",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "active",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-ok",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "add-required-consumer",
        consumerId: "analytics",
        author: "platform-oncall",
        reason: "analytics became required during rollout",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "paused",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-early",
        expectAccepted: true,
        expectDeduped: false,
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "paused",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-early",
        expectAccepted: true,
        expectDeduped: true,
      },

      {
        action: "report-gap-evidence",
        consumerId: "analytics",
        idempotencyKey: "analytics-reverify",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "completed",
      },
    ],
  };
}

export function rolloutConcurrentReceiptTopologyScenario(): Scenario {
  return {
    name: "rollout-concurrent-receipt-topology",
    topic: "order.events",
    baseline,
    candidate,
    consumers: [
      { consumerId: "billing", schema: consumerSchema },
      { consumerId: "payments", schema: consumerSchema },
    ],
    ttlMs: 60000,
    steps: [
      { action: "report", consumerId: "billing", result: "pass" },
      { action: "report", consumerId: "payments", result: "pass" },
      { action: "decide", kind: "approve", decider: "release-mgr" },
      {
        action: "create-rollout",
        owner: "release-mgr",
        waves: [
          { environment: "canary", adapter: "canary-adapter" },
          { environment: "prod", adapter: "prod-adapter" },
        ],
        captureRolloutAs: "r1",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 1,
        result: "success",
        idempotencyKey: "canary-ok",
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "deploying",
      },

      {
        action: "add-required-consumer",
        consumerId: "analytics",
        author: "platform-oncall",
        reason: "topology change while prod wave is deploying",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "paused",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-while-paused",
        expectAccepted: true,
        expectDeduped: false,
      },
      {
        action: "expect-wave-status",
        targetRollout: "r1",
        waveSequence: 2,
        expectedWaveStatus: "succeeded",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "paused",
      },

      {
        action: "rollout-receipt",
        targetRollout: "r1",
        waveSequence: 2,
        result: "success",
        idempotencyKey: "prod-while-paused",
        expectAccepted: true,
        expectDeduped: true,
      },

      {
        action: "report-gap-evidence",
        consumerId: "analytics",
        idempotencyKey: "analytics-reverify",
      },
      {
        action: "expect-rollout-status",
        targetRollout: "r1",
        expectedStatus: "completed",
      },
    ],
  };
}

export const scenarios: Record<string, () => Scenario> = {
  "happy-path": happyPathScenario,
  "duplicate-evidence": duplicateEvidenceScenario,
  "stale-evidence": staleEvidenceScenario,
  "crash-after-write": crashAfterWriteScenario,
  "wrong-digest": wrongDigestScenario,
  "unknown-consumer": unknownConsumerScenario,
  "exemption-approved": exemptionApprovedScenario,
  "exemption-expiry": exemptionExpiryScenario,
  "exemption-revoked": exemptionRevokedScenario,
  "exemption-rejected": exemptionRejectedScenario,
  "exemption-scope-mismatch": exemptionScopeMismatchScenario,
  "lineage-successor": lineageSuccessorScenario,
  "lineage-recovery": lineageRecoveryScenario,
  "rollout-phased": rolloutPhasedScenario,
  "rollout-duplicate-out-of-order": rolloutDuplicateOutOfOrderScenario,
  "rollout-pause-retry-rollback": rolloutPauseResumeRollbackScenario,
  "rollout-receipt-loss-recovery": rolloutReceiptLossRecoveryScenario,
  "rollout-topology-change": rolloutTopologyChangeScenario,
  "rollout-concurrent-receipt-topology":
    rolloutConcurrentReceiptTopologyScenario,
};
