import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { Store } from '../src/server/store.js';

const BASELINE = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const CANDIDATE = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 2 } } };

let dir: string;
let clock: ManualClock;
let store: Store;

function open(): Store {
  return new Store({ path: path.join(dir, 'test.db'), clock, defaultTtlMs: 1000 });
}

function ev(consumer: string, digest: string, key: string) {
  return { consumerId: consumer, candidateDigest: digest, verdict: 'pass' as const, runId: `r-${key}`, idempotencyKey: key };
}

function approvedProposal(consumers = ['a', 'b']) {
  const p = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers, evidenceTtlMs: 1000 });
  for (const c of consumers) store.recordEvidence(p.id, ev(c, p.candidateDigest, `k-${c}`));
  store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
  return store.getProposal(p.id)!;
}

function createRollout(proposalId: string) {
  return store.createRollout(proposalId, {
    waves: [
      { name: 'w1-预发', environment: 'staging' },
      { name: 'w2-灰度', environment: 'prod' },
      { name: 'w3-全量', environment: 'prod' },
    ],
    createdBy: 'release-lead',
  });
}

function receipt(ro: { id: string; decisionId: string }, waveId: string, key: string, result: 'success' | 'failure' | 'unknown' = 'success') {
  return store.recordReceipt(ro.id, { waveId, decisionId: ro.decisionId, result, receiptKey: key });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccc-topo-'));
  clock = new ManualClock(10_000);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('发布期间的依赖拓扑变化', () => {
  it('新必需消费方：未开始波次因覆盖缺口自动暂停，决策快照不变，生成待验证记录', () => {
    const p = approvedProposal();
    const frozen = JSON.stringify(p.decision!.snapshot);
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'rc-1'); // w1 成功，w2 开始部署，w3 未开始
    const detail = store.addDependency(p.id, { consumerId: 'fraud', by: 'arch', reason: '风控接入成为必需' });
    expect(detail.consumers).toContain('fraud');
    expect(detail.revalidations).toHaveLength(1);
    expect(detail.revalidations[0]).toMatchObject({ consumerId: 'fraud', status: 'pending', candidateDigest: p.candidateDigest });
    expect(detail.rollout!.status).toBe('paused');
    expect(detail.rollout!.pausedReason).toBe('coverage_gap');
    // 历史决策快照不可修改
    expect(JSON.stringify(detail.decision!.snapshot)).toBe(frozen);
    // 因果事件齐全
    const types = detail.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['DEPENDENCY_ADDED', 'REVALIDATION_REQUIRED', 'ROLLOUT_PAUSED']));
    // 候选摘要不受拓扑变化影响
    expect(detail.candidateDigest).toBe(p.candidateDigest);
  });

  it('覆盖缺口下：在途波次可完成，但未开始波次不启动；缺口关闭恢复后继续', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'rc-1');
    store.addDependency(p.id, { consumerId: 'fraud', by: 'arch' });
    // 在途 w2 的成功回执仍然生效
    const applied = receipt(ro, ro.waves[1].id, 'rc-2');
    expect(applied.outcome).toBe('applied');
    let cur = store.getRollout(ro.id)!;
    expect(cur.waves[1].status).toBe('succeeded');
    expect(cur.waves[2].status).toBe('pending'); // w3 未启动
    expect(cur.status).toBe('paused');
    expect(cur.pausedReason).toBe('coverage_gap');
    expect(store.getProposal(p.id)!.events.some((e) => e.type === 'WAVE_START_BLOCKED')).toBe(true);
    // 缺口未关闭时恢复被拒
    expect(() => store.resumeRollout(ro.id, 'ops')).toThrowError(
      expect.objectContaining({ code: 'COVERAGE_GAP', httpStatus: 422 }),
    );
    // 再验证通过后恢复：w3 启动
    const rv = store.getProposal(p.id)!.revalidations[0];
    const concluded = store.concludeRevalidation(rv.id, { verdict: 'pass', runId: 'run-fraud', idempotencyKey: 'rk-fraud', by: 'ci' });
    expect(concluded.outcome).toBe('concluded');
    expect(concluded.revalidation.status).toBe('passed');
    const resumed = store.resumeRollout(ro.id, 'ops');
    expect(resumed.status).toBe('active');
    expect(resumed.waves[2].status).toBe('deploying');
    expect(receipt(ro, ro.waves[2].id, 'rc-3').outcome).toBe('applied');
    expect(store.getRollout(ro.id)!.status).toBe('completed');
  });

  it('落盘回执与拓扑变更的并发到达有确定结果（提交顺序决定，且无竞态损坏）', () => {
    // 顺序 A：回执先落盘（w1 成功、w2 已启动），拓扑变更后到达
    const pA = approvedProposal();
    const roA = createRollout(pA.id);
    receipt(roA, roA.waves[0].id, 'rc-1');
    store.addDependency(pA.id, { consumerId: 'fraud', by: 'arch' });
    const rc2A = receipt(roA, roA.waves[1].id, 'rc-2');
    const stateA = store.getRollout(roA.id)!;

    // 顺序 B：拓扑变更先落盘，相同回执随后到达（全新库避免幂等键碰撞）
    store.close();
    dir = mkdtempSync(path.join(tmpdir(), 'ccc-topo-b-'));
    clock = new ManualClock(10_000);
    store = open();
    const pB = approvedProposal();
    const roB = createRollout(pB.id);
    store.addDependency(pB.id, { consumerId: 'fraud', by: 'arch' });
    receipt(roB, roB.waves[0].id, 'rc-1');
    const rc2B = receipt(roB, roB.waves[1].id, 'rc-2');
    const stateB = store.getRollout(roB.id)!;

    // 两种顺序共有的确定内核：已落盘回执的效果成立，未开始波次都被覆盖缺口挡住
    for (const s of [stateA, stateB]) {
      expect(s.status).toBe('paused');
      expect(s.pausedReason).toBe('coverage_gap');
      expect(s.waves[0].status).toBe('succeeded');
      expect(s.waves[2].status).toBe('pending');
      expect(s.receipts.find((r) => r.receiptKey === 'rc-1')!.outcome).toBe('applied');
    }
    // 顺序 A：w2 已启动（在途），回执确定性推进；顺序 B：w2 未启动，回执确定性隔离（不损坏状态）
    expect(rc2A.outcome).toBe('applied');
    expect(stateA.waves[1].status).toBe('succeeded');
    expect(rc2B.outcome).toBe('paused');
    expect(stateB.waves[1].status).toBe('pending');
    expect(stateB.receipts.find((r) => r.receiptKey === 'rc-2')!.applied).toBe(false);
    // 两条世界线经合法重放后收敛到同一终态
    const rvB = store.getProposal(pB.id)!.revalidations[0];
    store.concludeRevalidation(rvB.id, { verdict: 'pass', runId: 'run-f', idempotencyKey: 'rk-f' });
    store.resumeRollout(roB.id, 'ops');
    expect(store.getRollout(roB.id)!.waves[1].status).toBe('deploying');
    expect(receipt(roB, roB.waves[1].id, 'rc-2b').outcome).toBe('applied');
    receipt(roB, roB.waves[2].id, 'rc-3');
    expect(store.getRollout(roB.id)!.status).toBe('completed');
  });

  it('再验证结论幂等且不可改：重复去重、迟到隔离、未通过阻断恢复', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    store.addDependency(p.id, { consumerId: 'fraud', by: 'arch' });
    const rv = store.getProposal(p.id)!.revalidations[0];
    const c1 = store.concludeRevalidation(rv.id, { verdict: 'fail', runId: 'run-1', idempotencyKey: 'rk-1' });
    expect(c1.outcome).toBe('concluded');
    expect(c1.revalidation.status).toBe('failed');
    const dup = store.concludeRevalidation(rv.id, { verdict: 'fail', runId: 'run-1', idempotencyKey: 'rk-1' });
    expect(dup.outcome).toBe('duplicate');
    // 迟到且结论不同的报送被隔离，原结论不变
    const late = store.concludeRevalidation(rv.id, { verdict: 'pass', runId: 'run-2', idempotencyKey: 'rk-2' });
    expect(late.outcome).toBe('closed');
    expect(store.getProposal(p.id)!.revalidations[0].status).toBe('failed');
    expect(store.getProposal(p.id)!.events.some((e) => e.type === 'REVALIDATION_LATE')).toBe(true);
    expect(() => store.resumeRollout(ro.id, 'ops')).toThrowError(expect.objectContaining({ code: 'COVERAGE_GAP' }));
    void ro;
  });

  it('没有未开始波次时不自动暂停，但仍生成再验证记录', () => {
    const p = approvedProposal(['a']);
    const ro = store.createRollout(p.id, { waves: [{ name: 'w1', environment: 'prod' }], createdBy: 'lead' });
    receipt(ro, ro.waves[0].id, 'rc-1');
    expect(store.getRollout(ro.id)!.status).toBe('completed');
    const detail = store.addDependency(p.id, { consumerId: 'fraud', by: 'arch' });
    expect(detail.rollout!.status).toBe('completed');
    expect(detail.revalidations[0].status).toBe('pending');
  });

  it('开放提案添加依赖只扩展门禁，不产生再验证；被替代提案拒绝修改拓扑', () => {
    const open1 = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers: ['a'] });
    const d1 = store.addDependency(open1.id, { consumerId: 'fraud', by: 'arch' });
    expect(d1.revalidations).toHaveLength(0);
    expect(d1.gate.blockers.some((b) => b.code === 'missing_evidence' && b.consumer === 'fraud')).toBe(true);
    expect(() => store.addDependency(open1.id, { consumerId: 'fraud', by: 'arch' })).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_CONSUMER' }),
    );
    const succ = store.createSuccessor(open1.id, { candidate: { ...CANDIDATE, additionalProperties: false } });
    expect(() => store.addDependency(open1.id, { consumerId: 'x', by: 'arch' })).toThrowError(
      expect.objectContaining({ code: 'PROPOSAL_SUPERSEDED', httpStatus: 409 }),
    );
    void succ;
  });

  it('前四轮边界保持一致：摘要/豁免/谱系/波次状态不受拓扑变化影响', () => {
    // 谱系 + 豁免 + 决策
    const p = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers: ['a', 'offline'], evidenceTtlMs: 1000 });
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    const exmReq = store.requestExemption(p.id, { consumerId: 'offline', direction: 'backward', reason: '离线', requestedBy: 'req', ttlMs: 60_000 });
    store.confirmExemption(exmReq.id, 'r1');
    store.confirmExemption(exmReq.id, 'r2');
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    const frozen = JSON.stringify(dec.snapshot);
    store.revokeExemption(exmReq.id, 'ops', '结束');
    const succ = store.createSuccessor(p.id, { candidate: { ...CANDIDATE, additionalProperties: false } });
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'rc-1');
    // 拓扑变化
    const detail = store.addDependency(p.id, { consumerId: 'fraud', by: 'arch' });
    // 摘要不变
    expect(detail.candidateDigest).toBe(p.candidateDigest);
    expect(detail.baselineDigest).toBe(p.baselineDigest);
    // 豁免状态不变（不复活、不新增）
    expect(detail.exemptions).toHaveLength(1);
    expect(detail.exemptions[0].effectiveStatus).toBe('revoked');
    // 谱系不变
    expect(detail.supersededById).toBe(succ.id);
    expect(store.getProposal(succ.id)!.predecessorId).toBe(p.id);
    // 波次边界不变：w1 已成功、w2 部署中、w3 待启动
    expect(detail.rollout!.waves.map((w) => w.status)).toEqual(['succeeded', 'deploying', 'pending']);
    // 决策快照不变
    expect(JSON.stringify(detail.decision!.snapshot)).toBe(frozen);
  });

  it('重启后再验证、暂停原因与缺口语义完整恢复', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'rc-1');
    store.addDependency(p.id, { consumerId: 'fraud', by: 'arch' });
    const rvId = store.getProposal(p.id)!.revalidations[0].id;
    const eventCount = store.getProposal(p.id)!.events.length;
    store.close();
    store = open();
    const cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('paused');
    expect(cur.pausedReason).toBe('coverage_gap');
    const detail = store.getProposal(p.id)!;
    expect(detail.revalidations[0].status).toBe('pending');
    expect(detail.events).toHaveLength(eventCount);
    // 恢复后行为一致：缺口阻断恢复，结论后放行
    expect(() => store.resumeRollout(ro.id, 'ops')).toThrowError(expect.objectContaining({ code: 'COVERAGE_GAP' }));
    store.concludeRevalidation(rvId, { verdict: 'pass', runId: 'run-1', idempotencyKey: 'rk-1' });
    expect(store.resumeRollout(ro.id, 'ops').status).toBe('active');
    // 结论幂等键在重启后仍有效
    expect(store.concludeRevalidation(rvId, { verdict: 'pass', runId: 'run-1', idempotencyKey: 'rk-1' }).outcome).toBe('duplicate');
  });
});
