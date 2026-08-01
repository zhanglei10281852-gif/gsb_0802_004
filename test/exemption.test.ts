import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { evaluateGate } from '../src/core/gate.js';
import type { Exemption } from '../src/core/types.js';
import { Store } from '../src/server/store.js';

const BASELINE = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const CANDIDATE = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 2 } } };

let dir: string;
let clock: ManualClock;
let store: Store;

function open(): Store {
  return new Store({ path: path.join(dir, 'test.db'), clock, defaultTtlMs: 1000 });
}

function createProposal(consumers = ['a', 'offline-svc'], environment?: string) {
  return store.createProposal({
    title: 't',
    baseline: BASELINE,
    candidate: CANDIDATE,
    consumers,
    evidenceTtlMs: 1000,
    environment,
  });
}

function ev(consumer: string, digest: string, key: string) {
  return { consumerId: consumer, candidateDigest: digest, verdict: 'pass' as const, runId: `r-${key}`, idempotencyKey: key };
}

function requestAndActivate(proposalId: string, consumer: string, ttlMs = 60_000, extra: Partial<{ environment: string; direction: 'backward' | 'forward'; requestedBy: string }> = {}) {
  const req = store.requestExemption(proposalId, {
    consumerId: consumer,
    direction: extra.direction ?? 'backward',
    reason: '发布窗口内消费方暂时离线',
    requestedBy: extra.requestedBy ?? 'requester',
    ttlMs,
    environment: extra.environment,
  });
  store.confirmExemption(req.id, 'reviewer-1');
  store.confirmExemption(req.id, 'reviewer-2');
  return store.getExemption(req.id)!;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccc-exm-'));
  clock = new ManualClock(10_000);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('豁免生命周期（确定性时序）', () => {
  it('两名不同审核人确认后才生效：申请人不能复核、同一审核人不能重复确认', () => {
    const p = createProposal();
    const req = store.requestExemption(p.id, {
      consumerId: 'offline-svc',
      direction: 'backward',
      reason: '离线',
      requestedBy: 'requester',
      ttlMs: 60_000,
    });
    expect(req.status).toBe('pending');
    expect(() => store.confirmExemption(req.id, 'requester')).toThrowError(
      expect.objectContaining({ code: 'REQUESTER_CANNOT_CONFIRM', httpStatus: 422 }),
    );
    const after1 = store.confirmExemption(req.id, 'reviewer-1');
    expect(after1.status).toBe('pending');
    expect(after1.confirmations).toHaveLength(1);
    expect(() => store.confirmExemption(req.id, 'reviewer-1')).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_CONFIRMER', httpStatus: 409 }),
    );
    const after2 = store.confirmExemption(req.id, 'reviewer-2');
    expect(after2.status).toBe('active');
    expect(after2.confirmations.map((c) => c.by)).toEqual(['reviewer-1', 'reviewer-2']);
  });

  it('生效豁免覆盖缺失证据使门禁就绪，决策快照逐条拷贝豁免', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    expect(store.getProposal(p.id)!.gate.status).toBe('blocked');
    const exm = requestAndActivate(p.id, 'offline-svc');
    const ready = store.getProposal(p.id)!;
    expect(ready.gate.status).toBe('ready');
    expect(ready.gate.waived).toHaveLength(1);
    expect(ready.gate.waived[0]).toMatchObject({ code: 'missing_evidence', consumer: 'offline-svc', exemptionId: exm.id, confirmedBy: ['reviewer-1', 'reviewer-2'] });
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    expect(dec.snapshot.exemptionsUsed).toHaveLength(1);
    expect(dec.snapshot.exemptionsUsed[0].id).toBe(exm.id);
    expect(dec.snapshot.environment).toBe('prod');
  });

  it('撤销后不再参与新决策，已形成的历史快照保持原样', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    const exm = requestAndActivate(p.id, 'offline-svc');
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    const frozen = JSON.stringify(dec.snapshot);
    store.revokeExemption(exm.id, 'ops', '窗口提前结束');
    const d = store.getProposal(p.id)!;
    expect(d.exemptions[0].effectiveStatus).toBe('revoked');
    expect(d.exemptions[0].revokeReason).toBe('窗口提前结束');
    expect(JSON.stringify(d.decision!.snapshot)).toBe(frozen); // 历史快照原样
    // 提案已批准，豁免撤销不影响既有结论
    expect(d.status).toBe('approved');
  });

  it('到期后自动失效并写入审计链（EXEMPTION_EXPIRED 含原因），新决策被阻塞', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    requestAndActivate(p.id, 'offline-svc', 500);
    expect(store.getProposal(p.id)!.gate.status).toBe('ready');
    clock.advance(501); // 确定性时序：推进手动时钟使豁免到期
    const d = store.getProposal(p.id)!;
    expect(d.exemptions[0].effectiveStatus).toBe('expired');
    expect(d.gate.status).toBe('blocked');
    expect(d.gate.blockers.some((b) => b.code === 'missing_evidence' && b.consumer === 'offline-svc')).toBe(true);
    expect(d.gate.waived).toHaveLength(0);
    const expiredEvent = d.events.find((e) => e.type === 'EXEMPTION_EXPIRED');
    expect(expiredEvent).toBeDefined();
    expect(String((expiredEvent!.payload as { reason: string }).reason)).toContain('到期');
    expect(() =>
      store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version }),
    ).toThrowError(expect.objectContaining({ code: 'GATE_BLOCKED' }));
    // 到期的豁免也不能再复核
    expect(() => store.confirmExemption(d.exemptions[0].id, 'reviewer-3')).toThrowError(
      expect.objectContaining({ code: 'EXEMPTION_STATE' }),
    );
  });

  it('环境不匹配时豁免不生效', () => {
    const p = createProposal(['a', 'offline-svc'], 'prod');
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    requestAndActivate(p.id, 'offline-svc', 60_000, { environment: 'staging' });
    const d = store.getProposal(p.id)!;
    expect(d.gate.blockers.some((b) => b.code === 'missing_evidence')).toBe(true);
    expect(d.gate.waived).toHaveLength(0);
  });

  it('forward 方向豁免不抵消消费方证据阻塞', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    requestAndActivate(p.id, 'offline-svc', 60_000, { direction: 'forward' });
    expect(store.getProposal(p.id)!.gate.status).toBe('blocked');
  });

  it('豁免只能针对当前候选摘要：修订后旧豁免不再参与', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    requestAndActivate(p.id, 'offline-svc');
    const v2 = store.addRevision(p.id, { ...CANDIDATE, additionalProperties: false }, p.version);
    expect(v2.gate.blockers.some((b) => b.code === 'missing_evidence' && b.consumer === 'offline-svc')).toBe(true);
    expect(v2.gate.waived).toHaveLength(0);
  });

  it('失败证据与破坏性变更永远不可豁免', () => {
    const p = store.createProposal({
      title: 'breaking',
      baseline: BASELINE,
      candidate: { type: 'object', properties: { id: { type: 'string' } } }, // 破坏：required 被丢弃
      consumers: ['a', 'offline-svc'],
      evidenceTtlMs: 1000,
    });
    store.recordEvidence(p.id, { consumerId: 'a', candidateDigest: p.candidateDigest, verdict: 'fail', runId: 'r1', idempotencyKey: 'k-fail' });
    requestAndActivate(p.id, 'offline-svc');
    const d = store.getProposal(p.id)!;
    expect(d.gate.blockers.map((b) => b.code).sort()).toEqual(['breaking_compat', 'failed_evidence']);
    expect(d.gate.waived).toHaveLength(1); // 仅缺失证据被豁免
  });

  it('拒绝流程：待复核豁免可被拒绝并注明原因', () => {
    const p = createProposal();
    const req = store.requestExemption(p.id, {
      consumerId: 'offline-svc',
      direction: 'backward',
      reason: '离线',
      requestedBy: 'requester',
      ttlMs: 60_000,
    });
    const rejected = store.rejectExemption(req.id, 'reviewer-1', '窗口外申请');
    expect(rejected.effectiveStatus).toBe('rejected');
    expect(rejected.rejectReason).toBe('窗口外申请');
    expect(() => store.confirmExemption(req.id, 'reviewer-2')).toThrowError(
      expect.objectContaining({ code: 'EXEMPTION_STATE' }),
    );
  });

  it('未知消费方不能申请豁免', () => {
    const p = createProposal();
    expect(() =>
      store.requestExemption(p.id, { consumerId: 'ghost', direction: 'backward', reason: 'x', requestedBy: 'r', ttlMs: 1000 }),
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_CONSUMER' }));
  });

  it('重启后豁免状态与审计事件完整恢复', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    const exm = requestAndActivate(p.id, 'offline-svc');
    store.revokeExemption(exm.id, 'ops', '提前结束');
    const eventCount = store.getProposal(p.id)!.events.length;
    store.close();
    store = open();
    const d = store.getProposal(p.id)!;
    expect(d.exemptions).toHaveLength(1);
    expect(d.exemptions[0].effectiveStatus).toBe('revoked');
    expect(d.exemptions[0].confirmations.map((c) => c.by)).toEqual(['reviewer-1', 'reviewer-2']);
    expect(d.events).toHaveLength(eventCount);
    expect(d.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['EXEMPTION_REQUESTED', 'EXEMPTION_CONFIRMED', 'EXEMPTION_REVOKED']),
    );
  });
});

describe('门禁纯函数：waived 语义', () => {
  const DIGEST = 'sha256:x';
  function exemption(overrides: Partial<Exemption> = {}): Exemption {
    return {
      id: 'exm_1',
      proposalId: 'p',
      candidateDigest: DIGEST,
      consumerId: 'b',
      environment: 'prod',
      direction: 'backward',
      reason: '离线',
      requestedBy: 'req',
      requestedAt: 0,
      ttlMs: 1000,
      expiresAt: 2000,
      status: 'active',
      confirmations: [{ by: 'r1', at: 1 }, { by: 'r2', at: 2 }],
      rejectedBy: null, rejectedAt: null, rejectReason: null,
      revokedBy: null, revokedAt: null, revokeReason: null,
      ...overrides,
    };
  }

  it('生效豁免把 missing/stale 移入 waived，其余阻塞保留', () => {
    const g = evaluateGate({
      candidateDigest: DIGEST,
      consumers: ['a', 'b'],
      evidence: [],
      compat: { status: 'breaking', findings: [] },
      now: 1000,
      ttlMs: 100,
      environment: 'prod',
      exemptions: [exemption()],
    });
    expect(g.waived).toHaveLength(1);
    expect(g.waived[0]).toMatchObject({ code: 'missing_evidence', consumer: 'b', exemptionId: 'exm_1' });
    expect(g.blockers.map((b) => b.code).sort()).toEqual(['breaking_compat', 'missing_evidence']);
    expect(g.status).toBe('blocked');
  });

  it('pending/到期/撤销/环境或方向不匹配的豁免均不生效', () => {
    const base = {
      candidateDigest: DIGEST,
      consumers: ['b'],
      evidence: [],
      compat: { status: 'compatible' as const, findings: [] },
      now: 1000,
      ttlMs: 100,
      environment: 'prod',
    };
    for (const e of [
      exemption({ status: 'pending' }),
      exemption({ status: 'revoked' }),
      exemption({ expiresAt: 999 }),
      exemption({ environment: 'staging' }),
      exemption({ direction: 'forward' }),
      exemption({ candidateDigest: 'sha256:other' }),
      exemption({ consumerId: 'other' }),
    ]) {
      const g = evaluateGate({ ...base, exemptions: [e] });
      expect(g.status).toBe('blocked');
      expect(g.waived).toHaveLength(0);
    }
  });
});
