import type { ReceiptOutcome, ReceiptResult, Rollout, Wave, WaveStatus } from './types.js';

/**
 * 回执分类（纯函数）：判断一条部署回执能否推进波次。
 * 只有绑定同一决策快照、且指向当前波次（部署中）的回执返回 applied；
 * 其余（决策快照不匹配、非当前/非部署中波次、发布暂停、发布已关闭）都被隔离。
 * 幂等去重在存储层按 receiptKey 完成（duplicate）。
 *
 * 覆盖缺口语义：因拓扑变化（coverage_gap）暂停时，已经开始部署的当前波次
 * 允许完成（回执 applied），但尚未开始的波次不会启动——保证落盘回执与
 * 拓扑变更按任意到达顺序都得到确定结果。
 */
export function classifyReceipt(
  rollout: Rollout,
  wave: Wave,
  receiptDecisionId: string,
): ReceiptOutcome {
  if (receiptDecisionId !== rollout.decisionId) return 'stale_decision';
  if (rollout.status === 'completed' || rollout.status === 'rolled_back') return 'closed';
  if (rollout.status === 'paused') {
    // 覆盖缺口暂停：仅放行在途的当前部署波次，其余原因暂停一律不推进。
    if (
      rollout.pausedReason === 'coverage_gap' &&
      wave.ordinal === rollout.currentOrdinal &&
      wave.status === 'deploying'
    ) {
      return 'applied';
    }
    return 'paused';
  }
  if (wave.ordinal !== rollout.currentOrdinal || wave.status !== 'deploying') return 'stale_wave';
  return 'applied';
}

/** 回执结果映射到波次终态（仅 applied 时使用）。 */
export function waveStatusForResult(result: ReceiptResult): WaveStatus {
  switch (result) {
    case 'success':
      return 'succeeded';
    case 'failure':
      return 'failed';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * 回退目标校验（纯函数）：目标必须是“已知版本”——
 * 0 表示回到发布前；否则对应波次必须已成功。
 */
export function isKnownRollbackTarget(waves: Wave[], toWaveOrdinal: number): boolean {
  if (!Number.isInteger(toWaveOrdinal) || toWaveOrdinal < 0) return false;
  if (toWaveOrdinal === 0) return true;
  const target = waves.find((w) => w.ordinal === toWaveOrdinal);
  return target !== undefined && target.status === 'succeeded';
}
