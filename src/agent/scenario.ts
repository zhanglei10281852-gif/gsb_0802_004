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
    | "revoke-exemption";
  consumerId?: string;
  result?: EvidenceStatus;
  detail?: string;
  duplicate?: boolean;
  wrongDigest?: boolean;
  unknownConsumer?: boolean;
  oldDigest?: string;
  crashAfterWrite?: boolean;
  ms?: number;
  minBlockers?: number;
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
