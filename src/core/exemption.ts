import type {
  AppliedExemption,
  ExemptionDirection,
  ExemptionRecord,
  ExemptionStatus,
} from './types.js';
import { digest } from './digest.js';

export const REQUIRED_EXEMPTION_APPROVALS = 2;

export function exemptionApprovalCount(exemption: ExemptionRecord): number {
  return exemption.reviews.filter((r) => r.approved).length;
}

export function isExemptionApproved(exemption: ExemptionRecord): boolean {
  return exemptionApprovalCount(exemption) >= REQUIRED_EXEMPTION_APPROVALS;
}

export function isExemptionExpired(exemption: ExemptionRecord, now: number): boolean {
  return exemption.status === 'approved' && now > exemption.expiresAt;
}

export function effectiveExemptionStatus(exemption: ExemptionRecord, now: number): ExemptionStatus {
  if (exemption.status === 'approved' && now > exemption.expiresAt) {
    return 'expired';
  }
  return exemption.status;
}

export function isExemptionActive(exemption: ExemptionRecord, now: number): boolean {
  return effectiveExemptionStatus(exemption, now) === 'approved';
}

export function directionCovers(
  exemptionDirection: ExemptionDirection,
  requiredDirection: ExemptionDirection,
): boolean {
  if (exemptionDirection === requiredDirection) return true;
  if (exemptionDirection === 'both') return true;
  return false;
}

export interface ExemptionScopeFilter {
  candidateDigest: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
}

export function exemptionMatchesScope(
  exemption: ExemptionRecord,
  scope: ExemptionScopeFilter,
): boolean {
  return (
    exemption.candidateDigest === scope.candidateDigest &&
    exemption.consumerId === scope.consumerId &&
    exemption.environment === scope.environment &&
    directionCovers(exemption.direction, scope.direction)
  );
}

export function findActiveExemption(
  exemptions: ExemptionRecord[],
  scope: ExemptionScopeFilter,
  now: number,
): ExemptionRecord | undefined {
  return exemptions.find(
    (e) => isExemptionActive(e, now) && exemptionMatchesScope(e, scope),
  );
}

export function toAppliedExemption(exemption: ExemptionRecord): AppliedExemption {
  return {
    exemptionId: exemption.exemptionId,
    consumerId: exemption.consumerId,
    environment: exemption.environment,
    direction: exemption.direction,
    requestedBy: exemption.requestedBy,
    reviewers: exemption.reviews.filter((r) => r.approved).map((r) => r.reviewer),
    expiresAt: exemption.expiresAt,
    reason: exemption.reason,
  };
}

export function appliedExemptionsDigest(applied: AppliedExemption[]): string {
  return digest(
    [...applied]
      .sort((a, b) =>
        a.consumerId.localeCompare(b.consumerId) || a.exemptionId.localeCompare(b.exemptionId),
      )
      .map((a) => ({
        exemptionId: a.exemptionId,
        consumerId: a.consumerId,
        environment: a.environment,
        direction: a.direction,
        reviewers: [...a.reviewers].sort(),
        expiresAt: a.expiresAt,
      })),
  );
}

export const EMPTY_EXEMPTIONS_DIGEST = digest([]);
