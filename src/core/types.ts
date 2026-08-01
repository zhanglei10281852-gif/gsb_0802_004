export type Verdict = 'pass' | 'fail';
/** superseded 为派生状态：status 仍为 open 但已被后继提案替代关闭。 */
export type ProposalStatus = 'open' | 'approved' | 'rejected' | 'superseded';
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

/** 被生效中豁免抵消的阻塞项：不再参与阻塞，但保留可解释痕迹。 */
export interface WaivedBlocker extends Blocker {
  exemptionId: string;
  confirmedBy: string[];
}

export interface GateResult {
  status: 'ready' | 'blocked';
  blockers: Blocker[];
  /** 被豁免覆盖的阻塞项（仅展示用，不影响 status 判定）。 */
  waived: WaivedBlocker[];
}

/** 兼容方向：backward=候选相对基线的消费方方向；forward=生产方方向（本系统当前无对应阻塞项）。 */
export type ExemptionDirection = 'backward' | 'forward';
export type ExemptionStoredStatus = 'pending' | 'active' | 'rejected' | 'revoked' | 'expired';
export type ExemptionStatus = ExemptionStoredStatus;

export interface ExemptionConfirmation {
  by: string;
  at: number;
}

/**
 * 限时豁免：由两名不同审核人共同确认后生效，仅覆盖指定的
 * 候选摘要、消费方、环境与兼容方向；到期或被撤销后不再参与新决策。
 */
export interface Exemption {
  id: string;
  proposalId: string;
  candidateDigest: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  requestedAt: number;
  ttlMs: number;
  expiresAt: number;
  status: ExemptionStoredStatus;
  confirmations: ExemptionConfirmation[];
  rejectedBy: string | null;
  rejectedAt: number | null;
  rejectReason: string | null;
  revokedBy: string | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface ExemptionView extends Exemption {
  /** 含到期计算的有效状态：active 且超过 expiresAt 时为 expired。 */
  effectiveStatus: ExemptionStatus;
}

/** 决策时刻冻结的不可变快照。之后到达的证据/豁免变更不会改变其内容。 */
export interface DecisionSnapshot {
  proposalId: string;
  version: number;
  environment: string;
  baselineDigest: string;
  candidateDigest: string;
  compat: CompatResult;
  gate: GateResult;
  /** 决策时每个消费方实际采用的证据（逐条拷贝）。 */
  evidenceUsed: EvidenceRecord[];
  /** 决策时实际生效的豁免（逐条拷贝，含复核人）。 */
  exemptionsUsed: ExemptionView[];
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
  environment: string;
  evidenceTtlMs: number;
  createdAt: number;
  updatedAt: number;
  evidence: EvidenceRecord[];
  gate: GateResult;
  exemptions: ExemptionView[];
  /** 谱系：由哪个提案派生而来（无则 null）。 */
  predecessorId: string | null;
  /** 谱系：被哪个后继提案替代/派生（无则 null）。 */
  supersededById: string | null;
  decision: Decision | null;
  events: DomainEvent[];
}
