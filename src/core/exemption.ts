import type { Exemption, ExemptionStatus } from './types.js';

/** 豁免生效所需的最少不同审核人数量（四眼原则）。 */
export const REQUIRED_CONFIRMS = 2;

/** 有效状态：active 且已超过到期时刻时视为 expired（惰性计算）。 */
export function effectiveExemptionStatus(e: Exemption, now: number): ExemptionStatus {
  if (e.status === 'active' && now > e.expiresAt) return 'expired';
  return e.status;
}

/**
 * 豁免是否可用于抵消指定上下文中的阻塞项：
 * 必须生效中、未到期，且四元组（候选摘要、消费方、环境、兼容方向）全部匹配。
 */
export function exemptionApplies(
  e: Exemption,
  now: number,
  context: { consumerId: string; candidateDigest: string; environment: string; direction: Exemption['direction'] },
): boolean {
  return (
    effectiveExemptionStatus(e, now) === 'active' &&
    e.candidateDigest === context.candidateDigest &&
    e.consumerId === context.consumerId &&
    e.environment === context.environment &&
    e.direction === context.direction
  );
}
