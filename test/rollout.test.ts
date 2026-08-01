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

/** 创建并批准提案，返回提案详情。 */
function approvedProposal(consumers = ['a']) {
  const p = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers, evidenceTtlMs: 1000 });
  for (const c of consumers) store.recordEvidence(p.id, ev(c, p.candidateDigest, `k-${c}`));
  store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
  return store.getProposal(p.id)!;
}

function createRollout(proposalId: string, waves = [{ name: 'w1-预发', environment: 'staging' }, { name: 'w2-灰度', environment: 'prod' }, { name: 'w3-全量', environment: 'prod' }]) {
  return store.createRollout(proposalId, { waves, createdBy: 'release-lead' });
}

function receipt(ro: { id: string; decisionId: string }, waveId: string, result: 'success' | 'failure' | 'unknown', key: string, decisionId?: string) {
  return store.recordReceipt(ro.id, { waveId, decisionId: decisionId ?? ro.decisionId, result, receiptKey: key });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccc-rollout-'));
  clock = new ManualClock(10_000);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('分阶段发布', () => {
  it('只有已批准提案才能创建发布；每个提案至多一个', () => {
    const open1 = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers: ['a'] });
    expect(() => createRollout(open1.id)).toThrowError(expect.objectContaining({ code: 'PROPOSAL_NOT_APPROVED', httpStatus: 422 }));
    const p = approvedProposal();
    const ro = createRollout(p.id);
    expect(ro.status).toBe('active');
    expect(ro.currentOrdinal).toBe(1);
    expect(ro.decisionId).toBe(p.decision!.id);
    expect(ro.waves.map((w) => w.status)).toEqual(['deploying', 'pending', 'pending']);
    expect(() => createRollout(p.id)).toThrowError(expect.objectContaining({ code: 'ROLLOUT_EXISTS', httpStatus: 409 }));
  });

  it('成功回执按顺序推进波次直至完成', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    const r1 = receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    expect(r1.outcome).toBe('applied');
    let cur = store.getRollout(ro.id)!;
    expect(cur.waves.map((w) => w.status)).toEqual(['succeeded', 'deploying', 'pending']);
    expect(cur.currentOrdinal).toBe(2);
    receipt(ro, ro.waves[1].id, 'success', 'rc-2');
    receipt(ro, ro.waves[2].id, 'success', 'rc-3');
    cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('completed');
    expect(cur.waves.every((w) => w.status === 'succeeded')).toBe(true);
    // 完成后的迟到回执归档为 closed
    const late = receipt(ro, ro.waves[2].id, 'success', 'rc-late');
    expect(late.outcome).toBe('closed');
    expect(late.receipt.applied).toBe(false);
  });

  it('重复回执幂等去重（模拟回执丢失后重发）', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    const first = receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    const second = receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('duplicate');
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(store.getRollout(ro.id)!.receipts).toHaveLength(1);
    expect(store.getRollout(ro.id)!.currentOrdinal).toBe(2);
  });

  it('决策快照不匹配与乱序回执被隔离并写入因果记录', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    const wrongDec = receipt(ro, ro.waves[0].id, 'success', 'rc-x', 'dec_stale');
    expect(wrongDec.outcome).toBe('stale_decision');
    expect(wrongDec.receipt.applied).toBe(false);
    // 乱序：当前波次是 1，却收到波次 2 的回执
    const ooo = receipt(ro, ro.waves[1].id, 'success', 'rc-ooo');
    expect(ooo.outcome).toBe('stale_wave');
    const cur = store.getRollout(ro.id)!;
    expect(cur.waves[0].status).toBe('deploying');
    expect(cur.currentOrdinal).toBe(1);
    const detail = store.getProposal(p.id)!;
    const lateEvents = detail.events.filter((e) => e.type === 'RECEIPT_LATE');
    expect(lateEvents).toHaveLength(2);
    expect(lateEvents.map((e) => (e.payload as { outcome: string }).outcome).sort()).toEqual(['stale_decision', 'stale_wave']);
  });

  it('失败自动暂停；暂停期间回执被隔离；重试后恢复推进', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'failure', 'rc-1');
    let cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('paused');
    expect(cur.waves[0].status).toBe('failed');
    // 暂停期间到达的回执不推进
    const duringPause = receipt(ro, ro.waves[0].id, 'success', 'rc-2');
    expect(duringPause.outcome).toBe('paused');
    // 重试当前波次
    const retried = store.retryWave(ro.id, ro.waves[0].id, 'release-lead');
    expect(retried.status).toBe('active');
    expect(retried.waves[0].status).toBe('deploying');
    expect(retried.waves[0].retryCount).toBe(1);
    // 适配器重发成功回执（新幂等键）
    const ok = receipt(ro, ro.waves[0].id, 'success', 'rc-3');
    expect(ok.outcome).toBe('applied');
    expect(store.getRollout(ro.id)!.currentOrdinal).toBe(2);
  });

  it('未知结果自动暂停，恢复后波次仍需重试', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'unknown', 'rc-1');
    let cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('paused');
    expect(cur.waves[0].status).toBe('unknown');
    store.resumeRollout(ro.id, 'ops');
    cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('active');
    // 波次仍是 unknown，直接回执不会推进（stale_wave），必须先重试
    const direct = receipt(ro, ro.waves[0].id, 'success', 'rc-2');
    expect(direct.outcome).toBe('stale_wave');
    store.retryWave(ro.id, ro.waves[0].id, 'ops');
    expect(receipt(ro, ro.waves[0].id, 'success', 'rc-3').outcome).toBe('applied');
  });

  it('人工暂停/恢复；重复暂停被拒绝', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    store.pauseRollout(ro.id, 'ops');
    expect(store.getRollout(ro.id)!.status).toBe('paused');
    expect(() => store.pauseRollout(ro.id, 'ops')).toThrowError(expect.objectContaining({ code: 'ROLLOUT_STATE' }));
    store.resumeRollout(ro.id, 'ops');
    expect(store.getRollout(ro.id)!.status).toBe('active');
    expect(receipt(ro, ro.waves[0].id, 'success', 'rc-1').outcome).toBe('applied');
  });

  it('回退到已知版本：后续波次标记已回退，决策与豁免不受影响', () => {
    // 带豁免的批准提案
    const p = store.createProposal({ title: 't', baseline: BASELINE, candidate: CANDIDATE, consumers: ['a', 'offline'], evidenceTtlMs: 1000 });
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    const exmReq = store.requestExemption(p.id, { consumerId: 'offline', direction: 'backward', reason: '离线', requestedBy: 'req', ttlMs: 60_000 });
    store.confirmExemption(exmReq.id, 'r1');
    store.confirmExemption(exmReq.id, 'r2');
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    const frozenDecision = JSON.stringify(dec.snapshot);
    store.revokeExemption(exmReq.id, 'ops', '提前结束');

    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    receipt(ro, ro.waves[1].id, 'failure', 'rc-2');
    // 非已知版本不能作为回退目标（波次 2 失败、波次 3 未部署）
    expect(() => store.rollbackRollout(ro.id, { toWaveOrdinal: 2, by: 'ops' })).toThrowError(
      expect.objectContaining({ code: 'NOT_A_KNOWN_VERSION', httpStatus: 422 }),
    );
    const rolled = store.rollbackRollout(ro.id, { toWaveOrdinal: 1, by: 'ops', reason: '灰度异常，回到预发版本' });
    expect(rolled.status).toBe('rolled_back');
    expect(rolled.rolledBackTo).toBe(1);
    expect(rolled.waves.map((w) => w.status)).toEqual(['succeeded', 'rolled_back', 'rolled_back']);
    // 原契约决策快照不变
    const after = store.getProposal(p.id)!;
    expect(JSON.stringify(after.decision!.snapshot)).toBe(frozenDecision);
    // 已撤销的豁免不被复活
    expect(after.exemptions[0].effectiveStatus).toBe('revoked');
    // 已回退后回执归档 closed；不能重复回退
    expect(receipt(ro, ro.waves[0].id, 'success', 'rc-3').outcome).toBe('closed');
    expect(() => store.rollbackRollout(ro.id, { toWaveOrdinal: 0, by: 'ops' })).toThrowError(
      expect.objectContaining({ code: 'ROLLOUT_STATE' }),
    );
    // 因果记录
    expect(after.events.some((e) => e.type === 'ROLLOUT_ROLLED_BACK')).toBe(true);
  });

  it('回退到 0（发布前）：全部波次标记已回退', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    const rolled = store.rollbackRollout(ro.id, { toWaveOrdinal: 0, by: 'ops' });
    expect(rolled.waves.every((w) => w.status === 'rolled_back')).toBe(true);
    expect(rolled.currentOrdinal).toBe(0);
  });

  it('重启后发布/波次/回执与幂等键完整恢复', () => {
    const p = approvedProposal();
    const ro = createRollout(p.id);
    receipt(ro, ro.waves[0].id, 'success', 'rc-1');
    receipt(ro, ro.waves[1].id, 'failure', 'rc-2');
    const eventCount = store.getProposal(p.id)!.events.length;
    store.close();
    store = open();
    const cur = store.getRollout(ro.id)!;
    expect(cur.status).toBe('paused');
    expect(cur.currentOrdinal).toBe(2);
    expect(cur.waves.map((w) => w.status)).toEqual(['succeeded', 'failed', 'pending']);
    expect(cur.receipts).toHaveLength(2);
    expect(store.getProposal(p.id)!.events).toHaveLength(eventCount);
    // 回执幂等键在重启后仍然有效
    expect(receipt(ro, ro.waves[0].id, 'success', 'rc-1').outcome).toBe('duplicate');
    // 恢复运行：重试并推进
    store.retryWave(ro.id, ro.waves[1].id, 'ops');
    expect(receipt(ro, ro.waves[1].id, 'success', 'rc-3').outcome).toBe('applied');
  });
});
