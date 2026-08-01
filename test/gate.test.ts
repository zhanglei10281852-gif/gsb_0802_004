import { describe, expect, it } from 'vitest';
import { decisionBlockers, evaluateGate } from '../src/core/gate.js';
import type { EvidenceRecord } from '../src/core/types.js';

const DIGEST = 'sha256:abc';

function ev(consumer: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 1,
    proposalId: 'p',
    consumerId: consumer,
    candidateDigest: DIGEST,
    verdict: 'pass',
    runId: 'r1',
    idempotencyKey: `k-${consumer}`,
    recordedAt: 1000,
    appliesToCurrent: true,
    ...overrides,
  };
}

const compat = { status: 'compatible' as const, findings: [] };

describe('evaluateGate', () => {
  it('证据齐备且新鲜时就绪', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a', 'b'],
      evidence: [ev('a'), ev('b', { id: 2 })],
      compat,
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.status).toBe('ready');
  });

  it('缺失证据给出可解释阻塞原因', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a', 'b'],
      evidence: [ev('a')],
      compat,
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.status).toBe('blocked');
    expect(g.blockers).toEqual([
      expect.objectContaining({ code: 'missing_evidence', consumer: 'b' }),
    ]);
  });

  it('过期证据被识别', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a'],
      evidence: [ev('a')],
      compat,
      now: 2001,
      ttlMs: 1000,
    });
    expect(g.blockers.some((b) => b.code === 'stale_evidence')).toBe(true);
  });

  it('失败证据阻塞批准', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a'],
      evidence: [ev('a', { verdict: 'fail' })],
      compat,
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.blockers.some((b) => b.code === 'failed_evidence')).toBe(true);
  });

  it('旧候选或不适用证据不参与门禁', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a'],
      evidence: [
        ev('a', { candidateDigest: 'sha256:old' }),
        ev('a', { id: 2, appliesToCurrent: false }),
      ],
      compat,
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.blockers.some((b) => b.code === 'missing_evidence')).toBe(true);
  });

  it('同一消费方取最新证据（乱序到达按记录时间+序号判定）', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a'],
      evidence: [
        ev('a', { id: 5, verdict: 'pass', recordedAt: 1200 }),
        ev('a', { id: 3, verdict: 'fail', recordedAt: 900 }),
      ],
      compat,
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.status).toBe('ready');
  });

  it('破坏性候选产生 breaking_compat 阻塞', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a'],
      evidence: [ev('a')],
      compat: { status: 'breaking', findings: [{ path: '#', rule: 'required.dropped', message: 'x', breaking: true }] },
      now: 1500,
      ttlMs: 1000,
    });
    expect(g.blockers.some((b) => b.code === 'breaking_compat')).toBe(true);
  });
});

describe('decisionBlockers', () => {
  const gate = evaluateGate({
    candidateDigest: DIGEST,
    consumers: ['a', 'b'],
    evidence: [ev('a', { verdict: 'fail' })],
    compat: { status: 'breaking', findings: [{ path: '#', rule: 'r', message: 'm', breaking: true }] },
    now: 1500,
    ttlMs: 1000,
  });

  it('批准：缺失/失败/破坏性全部阻塞', () => {
    const bs = decisionBlockers(gate, 'approve', false);
    expect(bs.map((b) => b.code).sort()).toEqual(['breaking_compat', 'failed_evidence', 'missing_evidence']);
  });

  it('批准：显式确认可豁免破坏性，但不能豁免证据问题', () => {
    const bs = decisionBlockers(gate, 'approve', true);
    expect(bs.some((b) => b.code === 'breaking_compat')).toBe(false);
    expect(bs.some((b) => b.code === 'failed_evidence')).toBe(true);
    expect(bs.some((b) => b.code === 'missing_evidence')).toBe(true);
  });

  it('驳回：失败与破坏性是理由而非阻塞，缺失仍然阻塞', () => {
    const bs = decisionBlockers(gate, 'reject', false);
    expect(bs.map((b) => b.code)).toEqual(['missing_evidence']);
  });
});
