import { describe, it, expect } from 'vitest';
import { decide, evaluateGate, validateEvidenceSubmission } from '../src/domain/gate.js';
import type { Proposal, EvidenceRecord, EvidenceSubmission } from '../src/domain/types.js';

const proposal: Proposal = {
  id: 'p1',
  candidateHash: 'hash1',
  candidateSchema: {},
  baselineSchema: {},
  systemCompatibility: { compatible: true, issues: [] },
  status: 'pending',
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

describe('gate state machine', () => {
  it('is not ready when evidence is missing', () => {
    const g = evaluateGate(proposal, [ev('c1')], ['c1', 'c2']);
    expect(g.gateReady).toBe(false);
    expect(g.missingConsumerIds).toEqual(['c2']);
  });

  it('is ready when all consumers report compatible', () => {
    const g = evaluateGate(proposal, [ev('c1'), ev('c2')], ['c1', 'c2']);
    expect(g.gateReady).toBe(true);
  });

  it('is not ready when a consumer reports incompatible', () => {
    const g = evaluateGate(proposal, [ev('c1'), ev('c2', 'incompatible')], ['c1', 'c2']);
    expect(g.gateReady).toBe(false);
    expect(g.incompatibleConsumers).toContain('c2');
  });

  it('is not ready when system compatibility fails', () => {
    const p = { ...proposal, systemCompatibility: { compatible: false, issues: [{ code: 'x', message: 'break', path: '$' }] } };
    const g = evaluateGate(p, [ev('c1')], ['c1']);
    expect(g.gateReady).toBe(false);
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
});
