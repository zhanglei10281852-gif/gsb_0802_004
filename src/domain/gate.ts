import type {
  CompatibilityResult,
  EvidenceRecord,
  EvidenceSubmission,
  Proposal,
  ProposalStatus,
} from './types.js';

export interface GateEvaluation {
  gateReady: boolean;
  blockingReasons: string[];
  missingConsumerIds: string[];
  compatibleConsumers: string[];
  incompatibleConsumers: string[];
}

export function evaluateGate(
  proposal: Proposal,
  evidence: EvidenceRecord[],
  requiredConsumerIds: string[],
): GateEvaluation {
  const blockingReasons: string[] = [];
  const byConsumer = new Map<string, EvidenceRecord>();
  for (const e of evidence) {
    if (e.proposalId !== proposal.id) continue;
    byConsumer.set(e.consumerId, e);
  }

  const missingConsumerIds: string[] = [];
  const compatibleConsumers: string[] = [];
  const incompatibleConsumers: string[] = [];

  for (const cid of requiredConsumerIds) {
    const e = byConsumer.get(cid);
    if (!e) {
      missingConsumerIds.push(cid);
      blockingReasons.push(`missing evidence from consumer "${cid}"`);
    } else if (e.verdict === 'compatible') {
      compatibleConsumers.push(cid);
    } else if (e.verdict === 'incompatible') {
      incompatibleConsumers.push(cid);
      blockingReasons.push(`consumer "${cid}" reported incompatible: ${e.details}`);
    } else {
      incompatibleConsumers.push(cid);
      blockingReasons.push(`consumer "${cid}" reported error: ${e.details}`);
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

export function summarizeCompatibility(result: CompatibilityResult): string {
  if (result.compatible) return 'backward compatible';
  return result.issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
}
