import { describe, it, expect } from 'vitest';
import {
  decide,
  evaluateGate,
  isExemptionActive,
  validateEvidenceSubmission,
  validateExemptionClosure,
  validateExemptionConfirmation,
  validateExemptionRequest,
} from '../src/domain/gate.js';
import type {
  Proposal,
  EvidenceRecord,
  EvidenceSubmission,
  Exemption,
} from '../src/domain/types.js';

const proposal: Proposal = {
  id: 'p1',
  candidateHash: 'hash1',
  candidateSchema: {},
  baselineSchema: {},
  systemCompatibility: { compatible: true, issues: [] },
  status: 'pending',
  environment: 'production',
  createdAt: 0,
};

function ev(consumerId: string, verdict: 'compatible' | 'incompatible' = 'compatible'): EvidenceRecord {
  return {
    id: `${consumerId}-e`,
    proposalId: 'p1',
    consumerId,
    candidateHash: 'hash1',
    verdict,
    details: '',
    idempotencyKey: `k-${consumerId}`,
    recordedAt: 1,
  };
}

function exemption(over: Partial<Exemption> = {}): Exemption {
  return {
    id: 'ex1',
    candidateHash: 'hash1',
    consumerId: 'c2',
    environment: 'production',
    direction: 'compatible',
    reason: 'offline',
    requesterId: 'alice',
    confirmerId: 'bob',
    status: 'active',
    validFrom: 0,
    validUntil: 1000,
    createdAt: 0,
    confirmedAt: 1,
    closedAt: null,
    closedBy: null,
    closeNote: null,
    ...over,
  };
}

describe('gate state machine', () => {
  it('is not ready when evidence is missing', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [], 500);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('is ready when all consumers report compatible', () => {
    const g = evaluateGate(proposal, [ev('c1'), ev('c2')], ['c1', 'c2'], [], 500);
    expect(g.gateReady).toBe(true);
  });

  it('is not ready when a consumer reports incompatible', () => {
    const g = evaluateGate(proposal, [ev('c1'), ev('c2', 'incompatible')], ['c1', 'c2'], [], 500);
    expect(g.gateReady).toBe(false);
    expect(g.incompatibleConsumers).toContain('c2');
  });

  it('is not ready when system compatibility fails', () => {
    const p = { ...proposal, systemCompatibility: { compatible: false, issues: [{ code: 'x', message: 'break', path: '$' }] } };
    const g = evaluateGate(p, [ev('c1')], ['c1'], [], 500);
    expect(g.gateReady).toBe(false);
  });

  it('waives a missing consumer with a matching active exemption and becomes ready', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption()], 500);
    expect(g.missingConsumerIds).toEqual([]);
    expect(g.exemptedConsumerIds).toEqual(['c2']);
    expect(g.appliedExemptions).toHaveLength(1);
    expect(g.gateReady).toBe(true);
  });

  it('does not apply a pending exemption (needs second reviewer)', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption({ status: 'pending', confirmerId: null, confirmedAt: null })], 500);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('does not apply an expired exemption', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption({ validUntil: 400 })], 500);
    expect(g.gateReady).toBe(false);
    expect(g.appliedExemptions).toHaveLength(0);
    expect(isExemptionActive(exemption({ validUntil: 400 }), 500)).toBe(false);
    expect(isExemptionActive(exemption({ validFrom: 600 }), 500)).toBe(false);
  });

  it('does not apply an exemption for a different environment', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption({ environment: 'staging' })], 500);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('does not apply an incompatible-direction exemption to unblock approval', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption({ direction: 'incompatible' })], 500);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('does not let an exemption override actual incompatible evidence', () => {
    const g = evaluateGate(proposal, [ev('c1'), ev('c2', 'incompatible')], ['c1', 'c2'], [exemption()], 500);
    expect(g.gateReady).toBe(false);
    expect(g.incompatibleConsumers).toContain('c2');
    expect(g.exemptedConsumerIds).toEqual([]);
  });

  it('does not waive a revoked exemption', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2'], [exemption({ status: 'revoked' })], 500);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('refuses approval when not ready', () => {
    expect(decide('pending', false, 'approve').ok).toBe(false);
  });

  it('refuses any decision once decided', () => {
    expect(decide('approved', true, 'approve').ok).toBe(false);
    expect(decide('rejected', false, 'reject').ok).toBe(false);
  });

  it('allows approval when ready and rejection always when pending', () => {
    expect(decide('pending', true, 'approve')).toEqual({ ok: true, newStatus: 'approved' });
    expect(decide('pending', false, 'reject')).toEqual({ ok: true, newStatus: 'rejected' });
  });

  it('validates evidence submission against proposal and consumers', () => {
    const sub: EvidenceSubmission = {
      proposalId: 'p1',
      consumerId: 'c1',
      candidateHash: 'hash1',
      verdict: 'compatible',
      details: '',
      idempotencyKey: 'k',
    };
    expect(validateEvidenceSubmission(sub, proposal, new Set(['c1'])).ok).toBe(true);
    expect(validateEvidenceSubmission(sub, undefined, new Set(['c1'])).ok).toBe(false);
    expect(validateEvidenceSubmission(sub, proposal, new Set()).ok).toBe(false);
    expect(validateEvidenceSubmission({ ...sub, candidateHash: 'other' }, proposal, new Set(['c1'])).ok).toBe(false);
    const decided = { ...proposal, status: 'approved' as const };
    expect(validateEvidenceSubmission(sub, decided, new Set(['c1'])).ok).toBe(false);
  });

  it('enforces dual-reviewer: requester cannot confirm their own exemption', () => {
    const ex = exemption({ status: 'pending', confirmerId: null, confirmedAt: null });
    expect(validateExemptionConfirmation(ex, 'alice').ok).toBe(false);
    expect(validateExemptionConfirmation(ex, 'bob').ok).toBe(true);
    const already = exemption();
    expect(validateExemptionConfirmation(already, 'carol').ok).toBe(false);
  });

  it('validates exemption request fields and time window', () => {
    const base = {
      candidateHash: 'hash1',
      consumerId: 'c1',
      environment: 'production',
      direction: 'compatible' as const,
      reason: 'offline',
      requesterId: 'alice',
      validFrom: 100,
      validUntil: 200,
    };
    expect(validateExemptionRequest(base, new Set(['c1']), 50).ok).toBe(true);
    expect(validateExemptionRequest({ ...base, validUntil: 50 }, new Set(['c1']), 100).ok).toBe(false);
    expect(validateExemptionRequest({ ...base, validUntil: base.validFrom }, new Set(['c1']), 50).ok).toBe(false);
    expect(validateExemptionRequest({ ...base, consumerId: 'ghost' }, new Set(), 50).ok).toBe(false);
    expect(validateExemptionRequest({ ...base, requesterId: '' }, new Set(['c1']), 50).ok).toBe(false);
    expect(validateExemptionRequest({ ...base, reason: '' }, new Set(['c1']), 50).ok).toBe(false);
  });

  it('validates reject/revoke state transitions', () => {
    expect(validateExemptionClosure(exemption({ status: 'pending' }), 'bob', 'reject').ok).toBe(true);
    expect(validateExemptionClosure(exemption({ status: 'active' }), 'bob', 'revoke').ok).toBe(true);
    expect(validateExemptionClosure(exemption({ status: 'active' }), 'bob', 'reject').ok).toBe(false);
    expect(validateExemptionClosure(exemption({ status: 'revoked' }), 'bob', 'revoke').ok).toBe(false);
  });
});
