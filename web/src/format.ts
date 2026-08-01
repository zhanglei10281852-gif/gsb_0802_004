import type { Blocker, CompatResult, Decision, ExemptionDirection, ExemptionStatus, ProposalDetail } from './api';

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function shortDigest(digest: string, head = 16): string {
  return digest.length > head ? `${digest.slice(0, head)}…` : digest;
}

export const PROPOSAL_STATUS_LABEL: Record<ProposalDetail['status'], string> = {
  open: '开放',
  approved: '已批准',
  rejected: '已拒绝',
  superseded: '已替代',
};

export const COMPAT_STATUS_LABEL: Record<CompatResult['status'], string> = {
  compatible: '兼容',
  breaking: '破坏性变更',
};

export const DECISION_ACTION_LABEL: Record<Decision['action'], string> = {
  approve: '批准',
  reject: '驳回',
};

export const BLOCKER_CODE_LABEL: Record<Blocker['code'], string> = {
  missing_evidence: '缺少证据',
  stale_evidence: '证据过期',
  failed_evidence: '证据未通过',
  breaking_compat: '破坏性变更',
};

export const EXEMPTION_STATUS_LABEL: Record<ExemptionStatus, string> = {
  pending: '待复核',
  active: '生效中',
  rejected: '已拒绝',
  revoked: '已撤销',
  expired: '已过期',
};

export const EXEMPTION_DIRECTION_LABEL: Record<ExemptionDirection, string> = {
  backward: '消费方方向',
  forward: '生产方方向',
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  EXEMPTION_REQUESTED: '豁免申请',
  EXEMPTION_CONFIRMED: '豁免复核确认',
  EXEMPTION_REJECTED: '豁免被拒绝',
  EXEMPTION_REVOKED: '豁免被撤销',
  EXEMPTION_EXPIRED: '豁免到期',
  PROPOSAL_SUPERSEDED: '提案被替代',
  EVIDENCE_LATE: '迟到证据被隔离',
};
