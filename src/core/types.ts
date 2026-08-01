export type Verdict = 'pass' | 'fail';
export type ProposalStatus = 'open' | 'approved' | 'rejected';
export type DecisionAction = 'approve' | 'reject';

export interface CompatFinding {
  /** 发生位置（JSON Pointer 风格，# 表示根）。 */
  path: string;
  /** 规则标识，如 required.dropped / type.widened。 */
  rule: string;
  message: string;
  /** 是否为破坏性发现；false 表示“无法静态判定，需人工复核”。 */
  breaking: boolean;
}

export interface CompatResult {
  status: 'compatible' | 'breaking';
  findings: CompatFinding[];
}

export interface EvidenceInput {
  consumerId: string;
  candidateDigest: string;
  verdict: Verdict;
  runId: string;
  idempotencyKey: string;
  details?: unknown;
}

export interface EvidenceRecord extends EvidenceInput {
  id: number;
  proposalId: string;
  /** 服务器时钟记录的接收时刻。 */
  recordedAt: number;
  /** 接收时是否对应当前候选（迟到的旧候选/已关闭提案证据为 false）。 */
  appliesToCurrent: boolean;
}

export type BlockerCode =
  | 'missing_evidence'
  | 'stale_evidence'
  | 'failed_evidence'
  | 'breaking_compat';

export interface Blocker {
  code: BlockerCode;
  consumer?: string;
  message: string;
}

export interface GateResult {
  status: 'ready' | 'blocked';
  blockers: Blocker[];
}

/** 决策时刻冻结的不可变快照。之后到达的证据不会改变其内容。 */
export interface DecisionSnapshot {
  proposalId: string;
  version: number;
  baselineDigest: string;
  candidateDigest: string;
  compat: CompatResult;
  gate: GateResult;
  /** 决策时每个消费方实际采用的证据（逐条拷贝）。 */
  evidenceUsed: EvidenceRecord[];
  action: DecisionAction;
  decidedBy: string;
  rationale: string | null;
  decidedAt: number;
  acknowledgeBreaking: boolean;
}

export interface Decision {
  id: string;
  proposalId: string;
  action: DecisionAction;
  decidedBy: string;
  rationale: string | null;
  decidedAt: number;
  snapshot: DecisionSnapshot;
}

export interface DomainEvent {
  id: number;
  ts: number;
  proposalId: string;
  type: string;
  payload: unknown;
}

export interface ProposalDetail {
  id: string;
  title: string;
  status: ProposalStatus;
  version: number;
  baseline: unknown;
  candidate: unknown;
  baselineDigest: string;
  candidateDigest: string;
  compat: CompatResult;
  consumers: string[];
  evidenceTtlMs: number;
  createdAt: number;
  updatedAt: number;
  evidence: EvidenceRecord[];
  gate: GateResult;
  decision: Decision | null;
  events: DomainEvent[];
}
