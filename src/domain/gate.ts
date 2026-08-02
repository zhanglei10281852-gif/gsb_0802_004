import type {
  CompatibilityResult,
  EvidenceRecord,
  EvidenceSubmission,
  Exemption,
  ExemptionDirection,
  ExemptionRequest,
  Proposal,
  ProposalStatus,
} from './types.js';

export interface GateEvaluation {
  gateReady: boolean;
  blockingReasons: string[];
  missingConsumerIds: string[];
  compatibleConsumers: string[];
  incompatibleConsumers: string[];
  exemptedConsumerIds: string[];
  appliedExemptions: Exemption[];
}

export function isExemptionActive(ex: Exemption, now: number): boolean {
  return (
    ex.status === 'active' &&
    now >= ex.validFrom &&
    now <= ex.validUntil
  );
}

export function exemptionMatches(
  ex: Exemption,
  candidateHash: string,
  consumerId: string,
  environment: string,
): boolean {
  return (
    ex.candidateHash === candidateHash &&
    ex.consumerId === consumerId &&
    ex.environment === environment
  );
}

export function evaluateGate(
  proposal: Proposal,
  evidence: EvidenceRecord[],
  requiredConsumerIds: string[],
  exemptions: Exemption[],
  now: number,
): GateEvaluation {
  const blockingReasons: string[] = [];
  const byConsumer = new Map<string, EvidenceRecord>();
  for (const e of evidence) {
    if (e.proposalId !== proposal.id) continue;
    byConsumer.set(e.consumerId, e);
  }

  const effectiveExemptions = new Map<string, Exemption>();
  for (const ex of exemptions) {
    if (
      ex.status === 'active' &&
      exemptionMatches(ex, proposal.candidateHash, ex.consumerId, proposal.environment) &&
      isExemptionActive(ex, now) &&
      ex.direction === 'compatible'
    ) {
      effectiveExemptions.set(ex.consumerId, ex);
    }
  }

  const missingConsumerIds: string[] = [];
  const compatibleConsumers: string[] = [];
  const incompatibleConsumers: string[] = [];
  const exemptedConsumerIds: string[] = [];
  const appliedExemptions: Exemption[] = [];

  for (const cid of requiredConsumerIds) {
    const e = byConsumer.get(cid);
    if (e) {
      if (e.verdict === 'compatible') {
        compatibleConsumers.push(cid);
      } else if (e.verdict === 'incompatible') {
        incompatibleConsumers.push(cid);
        blockingReasons.push(`consumer "${cid}" reported incompatible: ${e.details}`);
      } else {
        incompatibleConsumers.push(cid);
        blockingReasons.push(`consumer "${cid}" reported error: ${e.details}`);
      }
      continue;
    }

    const waiver = effectiveExemptions.get(cid);
    if (waiver) {
      exemptedConsumerIds.push(cid);
      appliedExemptions.push(waiver);
    } else {
      missingConsumerIds.push(cid);
      blockingReasons.push(`missing evidence from consumer "${cid}" (no active exemption)`);
    }
  }

  if (!proposal.systemCompatibility.compatible) {
    for (const issue of proposal.systemCompatibility.issues) {
      blockingReasons.push(`system compatibility: [${issue.code}] ${issue.message} (at ${issue.path})`);
    }
  }

  if (proposal.status === 'approved' || proposal.status === 'rejected') {
    blockingReasons.push(`proposal already ${proposal.status}`);
  }
  if (proposal.status === 'superseded') {
    blockingReasons.push('proposal has been superseded by a newer revision');
  }

  return {
    gateReady:
      missingConsumerIds.length === 0 &&
      incompatibleConsumers.length === 0 &&
      proposal.systemCompatibility.compatible &&
      proposal.status === 'pending',
    blockingReasons,
    missingConsumerIds,
    compatibleConsumers,
    incompatibleConsumers,
    exemptedConsumerIds,
    appliedExemptions,
  };
}

export type DecisionTransition =
  | { ok: true; newStatus: 'approved' | 'rejected' }
  | { ok: false; reason: string };

export function decide(
  currentStatus: ProposalStatus,
  gateReady: boolean,
  action: 'approve' | 'reject',
): DecisionTransition {
  if (currentStatus === 'approved' || currentStatus === 'rejected') {
    return { ok: false, reason: `proposal already ${currentStatus}; decisions are immutable` };
  }
  if (currentStatus === 'superseded') {
    return { ok: false, reason: 'proposal has been superseded; decisions must be made on the latest revision' };
  }
  if (action === 'approve' && !gateReady) {
    return { ok: false, reason: 'cannot approve: gate is not ready' };
  }
  return { ok: true, newStatus: action === 'approve' ? 'approved' : 'rejected' };
}

export interface EvidenceValidation {
  ok: boolean;
  reason?: string;
}

export function validateEvidenceSubmission(
  submission: EvidenceSubmission,
  proposal: Proposal | undefined,
  knownConsumerIds: Set<string>,
): EvidenceValidation {
  if (!proposal) {
    return { ok: false, reason: 'unknown proposal' };
  }
  if (!knownConsumerIds.has(submission.consumerId)) {
    return { ok: false, reason: `unknown consumer "${submission.consumerId}"` };
  }
  if (submission.candidateHash !== proposal.candidateHash) {
    return {
      ok: false,
      reason: `candidate hash mismatch: evidence is for "${submission.candidateHash}", proposal is "${proposal.candidateHash}"`,
    };
  }
  if (proposal.status !== 'pending') {
    return { ok: false, reason: `proposal already ${proposal.status}; evidence no longer accepted` };
  }
  if (!submission.idempotencyKey) {
    return { ok: false, reason: 'idempotencyKey is required' };
  }
  if (submission.verdict !== 'compatible' && submission.verdict !== 'incompatible' && submission.verdict !== 'error') {
    return { ok: false, reason: `invalid verdict "${submission.verdict}"` };
  }
  return { ok: true };
}

export interface ExemptionValidation {
  ok: boolean;
  reason?: string;
}

export function validateExemptionRequest(
  req: ExemptionRequest,
  knownConsumerIds: Set<string>,
  now: number,
): ExemptionValidation {
  if (!req.candidateHash) return { ok: false, reason: 'candidateHash is required' };
  if (!req.consumerId || !knownConsumerIds.has(req.consumerId)) {
    return { ok: false, reason: `unknown consumer "${req.consumerId}"` };
  }
  if (!req.environment) return { ok: false, reason: 'environment is required' };
  if (req.direction !== 'compatible' && req.direction !== 'incompatible') {
    return { ok: false, reason: `invalid direction "${req.direction as string}"` };
  }
  if (!req.requesterId) return { ok: false, reason: 'requesterId is required' };
  if (!req.reason || !req.reason.trim()) return { ok: false, reason: 'reason is required' };
  if (!Number.isFinite(req.validFrom) || !Number.isFinite(req.validUntil)) {
    return { ok: false, reason: 'validFrom and validUntil must be finite numbers' };
  }
  if (req.validUntil <= req.validFrom) {
    return { ok: false, reason: 'validUntil must be after validFrom' };
  }
  if (req.validUntil <= now) {
    return { ok: false, reason: 'validUntil must be in the future' };
  }
  return { ok: true };
}

export function validateExemptionConfirmation(
  ex: Exemption,
  confirmerId: string,
): ExemptionValidation {
  if (!confirmerId) return { ok: false, reason: 'confirmerId is required' };
  if (ex.status !== 'pending') {
    return { ok: false, reason: `exemption is ${ex.status}, not pending` };
  }
  if (confirmerId === ex.requesterId) {
    return { ok: false, reason: 'confirmer must be a different reviewer than the requester' };
  }
  return { ok: true };
}

export function validateExemptionClosure(
  ex: Exemption,
  reviewerId: string,
  action: 'reject' | 'revoke',
): ExemptionValidation {
  if (!reviewerId) return { ok: false, reason: 'reviewerId is required' };
  if (action === 'reject' && ex.status !== 'pending') {
    return { ok: false, reason: `cannot reject a ${ex.status} exemption` };
  }
  if (action === 'revoke' && ex.status !== 'active') {
    return { ok: false, reason: `cannot revoke a ${ex.status} exemption` };
  }
  return { ok: true };
}

export function summarizeCompatibility(result: CompatibilityResult): string {
  if (result.compatible) return 'backward compatible';
  return result.issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
}

export function directionLabel(d: ExemptionDirection): string {
  return d === 'compatible' ? 'expected compatible' : 'acknowledged incompatible';
}
