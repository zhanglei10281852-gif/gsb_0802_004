import type { Blocker, CompatResult, Decision, ProposalDetail } from './api';

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
