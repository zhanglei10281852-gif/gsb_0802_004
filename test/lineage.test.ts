import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { Store } from '../src/server/store.js';

const BASELINE = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const CANDIDATE_V1 = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 2 } } };
const CANDIDATE_V2 = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 4 } } };

let dir: string;
let clock: ManualClock;
let store: Store;

function open(): Store {
  return new Store({ path: path.join(dir, 'test.db'), clock, defaultTtlMs: 1000 });
}

function createProposal() {
  return store.createProposal({
    title: 'order-events',
    baseline: BASELINE,
    candidate: CANDIDATE_V1,
    consumers: ['billing', 'offline-svc'],
    evidenceTtlMs: 1000,
    environment: 'prod',
  });
}

function ev(consumer: string, digest: string, key: string) {
  return { consumerId: consumer, candidateDigest: digest, verdict: 'pass' as const, runId: `r-${key}`, idempotencyKey: key };
}

function activateExemption(proposalId: string, consumer: string) {
  const req = store.requestExemption(proposalId, {
    consumerId: consumer,
    direction: 'backward',
    reason: '离线',
    requestedBy: 'requester',
    ttlMs: 60_000,
  });
  store.confirmExemption(req.id, 'reviewer-1');
  store.confirmExemption(req.id, 'reviewer-2');
  return req.id;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccc-lineage-'));
  clock = new ManualClock(10_000);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('提案谱系（后继提案）', () => {
  it('开放提案派生后继：原提案被替代关闭，谱系双向链接，继承基线/标题/消费方/环境，新候选新摘要', () => {
    const p1 = createProposal();
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2, reason: '上游修正候选', createdBy: 'dev' });
    expect(p2.predecessorId).toBe(p1.id);
    expect(p2.candidateDigest).not.toBe(p1.candidateDigest);
    expect(p2.baselineDigest).toBe(p1.baselineDigest);
    expect(p2.title).toBe(p1.title);
    expect(p2.consumers).toEqual(p1.consumers);
    expect(p2.environment).toBe('prod');
    expect(p2.compat.status).toBe('compatible');
    const old = store.getProposal(p1.id)!;
    expect(old.status).toBe('superseded');
    expect(old.supersededById).toBe(p2.id);
    // 因果记录：替代（原提案）+ 创建（后继，含 predecessorId）
    const superseded = old.events.find((e) => e.type === 'PROPOSAL_SUPERSEDED');
    expect(superseded).toBeDefined();
    expect((superseded!.payload as { closedByReplacement: boolean }).closedByReplacement).toBe(true);
    expect(p2.events[0].type).toBe('PROPOSAL_CREATED');
    expect((p2.events[0].payload as { predecessorId: string }).predecessorId).toBe(p1.id);
  });

  it('旧提案的构建证据不能自动沿用到后继', () => {
    const p1 = createProposal();
    store.recordEvidence(p1.id, ev('billing', p1.candidateDigest, 'k-b1'));
    store.recordEvidence(p1.id, ev('offline-svc', p1.candidateDigest, 'k-o1'));
    expect(store.getProposal(p1.id)!.gate.status).toBe('ready');
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    expect(p2.evidence).toHaveLength(0);
    expect(p2.gate.status).toBe('blocked');
    expect(p2.gate.blockers.filter((b) => b.code === 'missing_evidence')).toHaveLength(2);
  });

  it('上一轮的豁免按原精确作用域失效，不因消费方名称相同而继承', () => {
    const p1 = createProposal();
    store.recordEvidence(p1.id, ev('billing', p1.candidateDigest, 'k-b1'));
    activateExemption(p1.id, 'offline-svc');
    expect(store.getProposal(p1.id)!.gate.status).toBe('ready'); // 豁免生效
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    // 后继消费方清单同名，但豁免绑定原提案与原候选摘要
    expect(p2.exemptions).toHaveLength(0);
    expect(p2.gate.status).toBe('blocked');
    expect(p2.gate.waived).toHaveLength(0);
    expect(p2.gate.blockers.some((b) => b.code === 'missing_evidence' && b.consumer === 'offline-svc')).toBe(true);
  });

  it('并发到达的旧结果归入原提案且不得放行后继', () => {
    const p1 = createProposal();
    store.recordEvidence(p1.id, ev('billing', p1.candidateDigest, 'k-b1'));
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    // 旧候选的迟到结果发到原提案：归档但隔离
    const late = store.recordEvidence(p1.id, ev('offline-svc', p1.candidateDigest, 'k-late'));
    expect(late.outcome).toBe('closed');
    expect(late.evidence.appliesToCurrent).toBe(false);
    const old = store.getProposal(p1.id)!;
    const lateEvent = old.events.find((e) => e.type === 'EVIDENCE_LATE');
    expect(lateEvent).toBeDefined();
    expect((lateEvent!.payload as { outcome: string }).outcome).toBe('closed');
    // 迟到结果发到后继提案（旧摘要）：按旧候选隔离
    const wrongTarget = store.recordEvidence(p2.id, ev('offline-svc', p1.candidateDigest, 'k-late-2'));
    expect(wrongTarget.outcome).toBe('stale_candidate');
    // 后继门禁不受影响
    const succ = store.getProposal(p2.id)!;
    expect(succ.gate.status).toBe('blocked');
    expect(succ.gate.blockers.filter((b) => b.code === 'missing_evidence')).toHaveLength(2);
    expect(succ.evidence.every((e) => !e.appliesToCurrent)).toBe(true);
  });

  it('被替代的提案不能修订、不能决策', () => {
    const p1 = createProposal();
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    expect(() => store.addRevision(p1.id, CANDIDATE_V2, p1.version)).toThrowError(
      expect.objectContaining({ code: 'PROPOSAL_SUPERSEDED', httpStatus: 409 }),
    );
    expect(() => store.decide(p1.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p1.version })).toThrowError(
      expect.objectContaining({ code: 'PROPOSAL_SUPERSEDED', httpStatus: 409 }),
    );
    expect(p2.status).toBe('open');
  });

  it('谱系保持线性：同一提案只能有一个后继（并发派生 CAS）', () => {
    const p1 = createProposal();
    store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    expect(() => store.createSuccessor(p1.id, { candidate: CANDIDATE_V1 })).toThrowError(
      expect.objectContaining({ code: 'ALREADY_SUPERSEDED', httpStatus: 409 }),
    );
  });

  it('已批准提案派生后继：原结论与快照不变，谱系链接记录', () => {
    const p1 = createProposal();
    store.recordEvidence(p1.id, ev('billing', p1.candidateDigest, 'k-b1'));
    store.recordEvidence(p1.id, ev('offline-svc', p1.candidateDigest, 'k-o1'));
    const dec = store.decide(p1.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p1.version });
    const frozen = JSON.stringify(dec.snapshot);
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2, reason: '下一轮迭代' });
    const old = store.getProposal(p1.id)!;
    expect(old.status).toBe('approved'); // 已决策提案保持原状态
    expect(old.supersededById).toBe(p2.id);
    expect(JSON.stringify(old.decision!.snapshot)).toBe(frozen);
    const ev2 = old.events.find((e) => e.type === 'PROPOSAL_SUPERSEDED');
    expect((ev2!.payload as { closedByReplacement: boolean }).closedByReplacement).toBe(false);
  });

  it('多级谱系与覆盖字段', () => {
    const p1 = createProposal();
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2 });
    const p3 = store.createSuccessor(p2.id, {
      candidate: { ...CANDIDATE_V2, additionalProperties: false },
      title: 'order-events v3',
      consumers: ['billing'],
      environment: 'staging',
    });
    expect(p3.predecessorId).toBe(p2.id);
    expect(p3.title).toBe('order-events v3');
    expect(p3.consumers).toEqual(['billing']);
    expect(p3.environment).toBe('staging');
    expect(store.getProposal(p2.id)!.status).toBe('superseded');
    expect(store.listProposals().map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
  });

  it('重启后谱系、替代状态与因果事件完整恢复', () => {
    const p1 = createProposal();
    store.recordEvidence(p1.id, ev('billing', p1.candidateDigest, 'k-b1'));
    const p2 = store.createSuccessor(p1.id, { candidate: CANDIDATE_V2, reason: '修正' });
    store.recordEvidence(p1.id, ev('offline-svc', p1.candidateDigest, 'k-late')); // 迟到，归入原提案
    const oldEvents = store.getProposal(p1.id)!.events.length;
    store.close();
    store = open();
    const old = store.getProposal(p1.id)!;
    const succ = store.getProposal(p2.id)!;
    expect(old.status).toBe('superseded');
    expect(old.supersededById).toBe(p2.id);
    expect(succ.predecessorId).toBe(p1.id);
    expect(old.events).toHaveLength(oldEvents);
    expect(old.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['PROPOSAL_SUPERSEDED', 'EVIDENCE_RECORDED', 'EVIDENCE_LATE']),
    );
    expect(succ.gate.status).toBe('blocked'); // 迟到证据没有污染后继
    // 幂等键在重启后仍然有效
    expect(store.recordEvidence(p1.id, ev('offline-svc', p1.candidateDigest, 'k-late')).outcome).toBe('duplicate');
  });
});
