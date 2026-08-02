import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { stableDigest } from '../src/core/canonical.js';
import { Store, StoreError } from '../src/server/store.js';

const BASELINE = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const CANDIDATE = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 2 } } };

let dir: string;
let dbPath: string;
let clock: ManualClock;
let store: Store;

function open(): Store {
  return new Store({ path: dbPath, clock, defaultTtlMs: 1000 });
}

function createProposal() {
  return store.createProposal({
    title: 't',
    baseline: BASELINE,
    candidate: CANDIDATE,
    consumers: ['a', 'b'],
    evidenceTtlMs: 1000,
  });
}

function ev(consumer: string, digest: string, key: string, verdict: 'pass' | 'fail' = 'pass') {
  return { consumerId: consumer, candidateDigest: digest, verdict, runId: `r-${key}`, idempotencyKey: key };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccc-store-'));
  dbPath = path.join(dir, 'test.db');
  clock = new ManualClock(1000);
  store = open();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('创建提案：计算稳定摘要与兼容性，状态 open，版本 1', () => {
    const p = createProposal();
    expect(p.status).toBe('open');
    expect(p.version).toBe(1);
    expect(p.candidateDigest).toBe(stableDigest(CANDIDATE));
    expect(p.compat.status).toBe('compatible');
    expect(p.gate.status).toBe('blocked');
  });

  it('相同幂等键重试只生效一次并返回 duplicate', () => {
    const p = createProposal();
    const first = store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k1'));
    clock.advance(10);
    const second = store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k1'));
    expect(first.outcome).toBe('recorded');
    expect(second.outcome).toBe('duplicate');
    expect(second.evidence.id).toBe(first.evidence.id);
    expect(second.evidence.recordedAt).toBe(first.evidence.recordedAt);
    expect(store.getProposal(p.id)!.evidence).toHaveLength(1);
  });

  it('相同幂等键不同内容被拒绝', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k1'));
    expect(() => store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k1', 'fail'))).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
  });

  it('未知消费方的报送被拒绝且不写入', () => {
    const p = createProposal();
    expect(() => store.recordEvidence(p.id, ev('ghost', p.candidateDigest, 'k9'))).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_CONSUMER', httpStatus: 422 }),
    );
    expect(store.getProposal(p.id)!.evidence).toHaveLength(0);
  });

  it('旧候选的迟到证据被隔离，不污染当前门禁', () => {
    const p = createProposal();
    const stale = store.recordEvidence(p.id, ev('a', 'sha256:old', 'k-old'));
    expect(stale.outcome).toBe('stale_candidate');
    const d = store.getProposal(p.id)!;
    expect(d.evidence[0].appliesToCurrent).toBe(false);
    expect(d.gate.blockers.filter((b) => b.code === 'missing_evidence')).toHaveLength(2);
  });

  it('修订后旧候选证据失效，版本推进', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    store.recordEvidence(p.id, ev('b', p.candidateDigest, 'k-b'));
    expect(store.getProposal(p.id)!.gate.status).toBe('ready');
    const v2 = store.addRevision(p.id, { ...CANDIDATE, additionalProperties: false }, p.version);
    expect(v2.version).toBe(2);
    expect(v2.gate.status).toBe('blocked');
    // 针对第一版候选的迟到报送现在被标记为旧候选
    const late = store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-late'));
    expect(late.outcome).toBe('stale_candidate');
  });

  it('证据过期后门禁阻塞', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    store.recordEvidence(p.id, ev('b', p.candidateDigest, 'k-b'));
    clock.advance(1001);
    const d = store.getProposal(p.id)!;
    expect(d.gate.blockers.filter((b) => b.code === 'stale_evidence')).toHaveLength(2);
  });

  it('证据不齐时不能决策（GATE_BLOCKED 422）', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    expect(() =>
      store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version }),
    ).toThrowError(expect.objectContaining({ code: 'GATE_BLOCKED', httpStatus: 422 }));
  });

  it('并发决策：同版本只有一个生效，另一个 VERSION_CONFLICT', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    store.recordEvidence(p.id, ev('b', p.candidateDigest, 'k-b'));
    const first = store.decide(p.id, { action: 'approve', decidedBy: 'lead-1', expectedVersion: p.version });
    expect(first.action).toBe('approve');
    expect(() =>
      store.decide(p.id, { action: 'reject', decidedBy: 'lead-2', expectedVersion: p.version }),
    ).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() =>
      store.decide(p.id, { action: 'reject', decidedBy: 'lead-2', expectedVersion: p.version + 1 }),
    ).toThrowError(expect.objectContaining({ code: 'DECISION_ALREADY_MADE' }));
  });

  it('决策快照不可变：后到的证据不改变当时的结论', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    store.recordEvidence(p.id, ev('b', p.candidateDigest, 'k-b'));
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    const frozen = JSON.stringify(dec.snapshot);
    clock.advance(5000);
    const late = store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-after', 'fail'));
    expect(late.outcome).toBe('closed');
    const d = store.getProposal(p.id)!;
    expect(d.status).toBe('approved');
    expect(JSON.stringify(d.decision!.snapshot)).toBe(frozen);
    expect(d.evidence).toHaveLength(3); // 迟到证据被记录但被隔离
  });

  it('重启后从 SQLite 恢复完整状态与因果事件', () => {
    const p = createProposal();
    store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    store.recordEvidence(p.id, ev('b', p.candidateDigest, 'k-b'));
    const dec = store.decide(p.id, { action: 'approve', decidedBy: 'lead', expectedVersion: p.version });
    const eventCount = store.getProposal(p.id)!.events.length;
    store.close();

    store = open(); // 同一文件重新打开，模拟进程重启
    const d = store.getProposal(p.id)!;
    expect(d.status).toBe('approved');
    expect(d.decision!.id).toBe(dec.id);
    expect(d.decision!.snapshot.candidateDigest).toBe(p.candidateDigest);
    expect(d.evidence).toHaveLength(2);
    expect(d.events).toHaveLength(eventCount);
    // 幂等键在重启后仍然有效
    const dup = store.recordEvidence(p.id, ev('a', p.candidateDigest, 'k-a'));
    expect(dup.outcome).toBe('duplicate');
  });

  it('一致快照包含事件游标与全部提案', () => {
    const p1 = createProposal();
    const p2 = store.createProposal({ title: 't2', baseline: BASELINE, candidate: BASELINE, consumers: ['x'] });
    const snap = store.snapshot();
    expect(snap.proposals.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(snap.eventCursor).toBeGreaterThan(0);
    expect(snap.serverTime).toBe(clock.now());
  });
});
