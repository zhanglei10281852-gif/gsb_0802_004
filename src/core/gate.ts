import type {
  Blocker,
  CompatResult,
  DecisionAction,
  EvidenceRecord,
  GateResult,
} from './types.js';

export interface GateParams {
  candidateDigest: string;
  consumers: string[];
  /** 提案的全部证据（函数内部只采用当前候选且适用的证据）。 */
  evidence: EvidenceRecord[];
  compat: CompatResult;
  now: number;
  ttlMs: number;
}

/** 每个消费方针对当前候选的最新适用证据。 */
export function latestApplicableEvidence(
  evidence: EvidenceRecord[],
  candidateDigest: string,
): Map<string, EvidenceRecord> {
  const latest = new Map<string, EvidenceRecord>();
  for (const ev of evidence) {
    if (!ev.appliesToCurrent || ev.candidateDigest !== candidateDigest) continue;
    const prev = latest.get(ev.consumerId);
    if (!prev || ev.recordedAt > prev.recordedAt || (ev.recordedAt === prev.recordedAt && ev.id > prev.id)) {
      latest.set(ev.consumerId, ev);
    }
  }
  return latest;
}

/**
 * 门禁状态机（纯函数）：
 * 就绪 = 每个必需消费方都有针对当前精确候选摘要的、未过期的、通过的证据，
 * 且兼容性判定非破坏性。其他任何情况都给出可解释的阻塞原因。
 */
export function evaluateGate(params: GateParams): GateResult {
  const blockers: Blocker[] = [];
  const latest = latestApplicableEvidence(params.evidence, params.candidateDigest);

  for (const consumer of params.consumers) {
    const ev = latest.get(consumer);
    if (!ev) {
      blockers.push({
        code: 'missing_evidence',
        consumer,
        message: `缺少消费方 ${consumer} 针对当前候选的验证证据`,
      });
      continue;
    }
    if (params.now - ev.recordedAt > params.ttlMs) {
      blockers.push({
        code: 'stale_evidence',
        consumer,
        message: `消费方 ${consumer} 的证据已过期（记录于 ${ev.recordedAt}，已超过 TTL ${params.ttlMs}ms）`,
      });
      continue;
    }
    if (ev.verdict === 'fail') {
      blockers.push({
        code: 'failed_evidence',
        consumer,
        message: `消费方 ${consumer} 的验证未通过（run ${ev.runId}）`,
      });
    }
  }

  if (params.compat.status === 'breaking') {
    blockers.push({ code: 'breaking_compat', message: '候选契约相对基线包含破坏性变更' });
  }

  return { status: blockers.length === 0 ? 'ready' : 'blocked', blockers };
}

/**
 * 针对具体决策动作过滤仍然生效的阻塞项：
 * - 驳回：缺失/过期证据仍然阻塞（不能对证据不齐的候选下结论），失败/破坏性恰恰是驳回理由；
 * - 批准：全部阻塞生效，但破坏性变更可经负责人显式确认（acknowledgeBreaking）豁免。
 */
export function decisionBlockers(
  gate: GateResult,
  action: DecisionAction,
  acknowledgeBreaking: boolean,
): Blocker[] {
  let blockers = gate.blockers;
  if (action === 'reject') {
    blockers = blockers.filter((b) => b.code === 'missing_evidence' || b.code === 'stale_evidence');
  }
  if (action === 'approve' && acknowledgeBreaking) {
    blockers = blockers.filter((b) => b.code !== 'breaking_compat');
  }
  return blockers;
}
