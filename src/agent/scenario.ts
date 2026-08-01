import type { EvidenceStatus, JsonSchema } from "../core/types.js";

export interface ConsumerScenario {
  consumerId: string;
  result: EvidenceStatus;
  detail?: string;
  delayMs?: number;
  duplicate?: boolean;
  duplicateDelayMs?: number;
  dropResponse?: boolean;
  wrongDigest?: boolean;
  unknownConsumer?: boolean;
  oldDigest?: string;
}

export interface ScenarioStep {
  action:
    | "report"
    | "wait"
    | "advance-clock"
    | "crash-server"
    | "restart-server"
    | "expect-blockers"
    | "decide"
    | "sleep-real"
    | "request-exemption"
    | "review-exemption"
    | "revoke-exemption"
    | "create-successor"
    | "report-to-predecessor"
    | "expect-status"
    | "create-rollout"
    | "rollout-receipt"
    | "pause-rollout"
    | "resume-rollout"
    | "retry-wave"
    | "rollback-rollout"
    | "expect-rollout-status"
    | "expect-wave-status";
  consumerId?: string;
  result?: EvidenceStatus | "success" | "failure" | "unknown";
  detail?: string;
  duplicate?: boolean;
  wrongDigest?: boolean;
  unknownConsumer?: boolean;
  oldDigest?: string;
  crashAfterWrite?: boolean;
  crashAfterReceipt?: boolean;
  ms?: number;
  minBlockers?: number;
  maxBlockers?: number;
  kind?: "approve" | "reject";
  decider?: string;
  expectBlocked?: boolean;
  environment?: string;
  direction?: "backward" | "forward" | "both";
  reason?: string;
  requestedBy?: string;
  ttlMs?: number;
  reviewer?: string;
  approved?: boolean;
  comment?: string;
  exemptionId?: string;
  revokedBy?: string;
  captureExemptionAs?: string;
  useExemption?: string;
  expectAppliedExemptions?: number;
  candidate?: JsonSchema;
  note?: string;
  author?: string;
  captureProposalAs?: string;
  targetProposal?: string;
  expectedStatus?: string;
  expectRejectedReason?: string;
  owner?: string;
  waves?: { environment: string; adapter: string }[];
  previousVersion?: string;
  captureRolloutAs?: string;
  targetRollout?: string;
  rolloutId?: string;
  waveSequence?: number;
  idempotencyKey?: string;
  adapterRunId?: string;
  pausedBy?: string;
  resumedBy?: string;
  retriedBy?: string;
  rolledBackBy?: string;
  rollbackNote?: string;
  expectedWaveStatus?: string;
  expectAccepted?: boolean;
  expectDeduped?: boolean;
}

export interface Scenario {
  name: string;
  topic: string;
  baseline: JsonSchema;
  candidate: JsonSchema;
  consumers: { consumerId: string; schema: JsonSchema }[];
  ttlMs: number;
  steps: ScenarioStep[];
}
