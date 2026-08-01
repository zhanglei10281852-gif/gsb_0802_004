import type { EvidenceStatus, JsonSchema } from '../core/types.js';

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
  action: 'report' | 'wait' | 'advance-clock' | 'crash-server' | 'restart-server' | 'expect-blockers' | 'decide' | 'sleep-real';
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
  kind?: 'approve' | 'reject';
  decider?: string;
  expectBlocked?: boolean;
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
