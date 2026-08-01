import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 端到端入口：启动编译后的真实服务与代理模拟器，覆盖
 * 重复报送、丢响应重试、未知消费方、旧候选迟到、并发审批、
 * 证据过期、破坏性变更确认、决策快照不可变、重启恢复与 SSE 重放。
 * 全程使用手动时钟，不等待真实时间。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(here, '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const TTL_MS = 1000;

let failures = 0;
function check(cond: boolean, name: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${extra === undefined ? '' : ' -> ' + JSON.stringify(extra)}`);
  }
}

async function req(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function startServer(dbPath: string): ChildProcess {
  const child = spawn(process.execPath, [path.join(distRoot, 'server', 'main.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: dbPath,
      EVIDENCE_TTL_MS: String(TTL_MS),
      CONTRACT_CLOCK: 'manual',
      CLOCK_START: '1700000000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (err) => console.error(`[server] 启动失败: ${err.message}`));
  child.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务启动超时');
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

async function runSimulator(scenarioPath: string): Promise<number> {
  const child = spawn(process.execPath, [path.join(distRoot, 'agent', 'simulator.js'), scenarioPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => process.stdout.write(`[agent] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[agent] ${d}`));
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
}

const BASELINE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['orderId', 'amount', 'currency'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['CNY', 'USD', 'EUR'] },
    note: { type: 'string' },
  },
  additionalProperties: false,
};

const COMPATIBLE_CANDIDATE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['orderId', 'amount', 'currency', 'note'], // 收窄：保证更多字段
  properties: {
    orderId: { type: 'string', minLength: 3 }, // 收窄
    amount: { type: 'number', minimum: 0, maximum: 1000000 }, // 收窄
    currency: { type: 'string', enum: ['CNY', 'USD'] }, // 收窄
    note: { type: 'string' },
  },
  additionalProperties: false,
};

const BREAKING_CANDIDATE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['orderId'], // 破坏：不再保证 amount / currency
  properties: {
    orderId: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' },
  },
  additionalProperties: true, // 破坏：允许额外字段
};

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccc-e2e-'));
  const dbPath = path.join(dir, 'control.db');
  console.log(`[e2e] 临时目录 ${dir}`);

  console.log('[e2e] 第一次启动服务（手动时钟）');
  let server = startServer(dbPath);
  await waitHealthy();
  check(true, '服务健康检查通过');

  try {
    // ---- 阶段 A：代理模拟器制造真实链路噪声 ----
    console.log('[e2e] 阶段 A：重复报送 / 丢响应重试 / 未知消费方 / 旧候选 / 并发审批');
    const scenarioA = {
      server: BASE,
      steps: [
        {
          do: 'createProposal',
          as: 'p1',
          title: 'order-events v2',
          baseline: BASELINE,
          candidate: COMPATIBLE_CANDIDATE,
          consumers: ['billing', 'search', 'risk'],
          evidenceTtlMs: TTL_MS,
        },
        { do: 'evidence', proposal: 'p1', consumer: 'billing', verdict: 'pass', key: 'k-billing', repeat: 2, expectStatus: 200 },
        { do: 'evidence', proposal: 'p1', consumer: 'ghost-svc', verdict: 'pass', key: 'k-ghost', expectStatus: 422 },
        { do: 'evidence', proposal: 'p1', consumer: 'search', verdict: 'pass', key: 'k-search', loseResponse: true, repeat: 2, expectStatus: 200 },
        { do: 'evidence', proposal: 'p1', consumer: 'risk', verdict: 'pass', key: 'k-risk-stale', digest: 'stale', expectOutcome: 'stale_candidate' },
        { do: 'evidence', proposal: 'p1', consumer: 'risk', verdict: 'pass', key: 'k-risk', expectOutcome: 'recorded' },
        { do: 'concurrentDecisions', proposal: 'p1', decisions: [{ by: 'lead-a' }, { by: 'lead-b' }] },
      ],
    };
    const scenarioPath = path.join(dir, 'scenarioA.json');
    writeFileSync(scenarioPath, JSON.stringify(scenarioA, null, 2));
    const agentCode = await runSimulator(scenarioPath);
    check(agentCode === 0, '代理模拟器全部断言通过');

    let snap = (await req('GET', `${BASE}/api/snapshot`)).body;
    check(snap.proposals.length === 1, '快照包含 1 个提案');
    const p1 = snap.proposals[0];
    check(p1.status === 'approved', 'P1 已批准', p1.status);
    const billingRows = p1.evidence.filter((e: any) => e.consumerId === 'billing');
    const searchRows = p1.evidence.filter((e: any) => e.consumerId === 'search');
    const riskRows = p1.evidence.filter((e: any) => e.consumerId === 'risk');
    check(billingRows.length === 1, 'billing 重复报送只生效一次', billingRows.length);
    check(searchRows.length === 1, 'search 丢响应重试只生效一次', searchRows.length);
    check(riskRows.length === 2 && riskRows.some((e: any) => !e.appliesToCurrent), 'risk 旧候选证据被隔离', riskRows);
    check(!p1.evidence.some((e: any) => e.consumerId === 'ghost-svc'), '未知消费方未写入证据');
    check(p1.decision !== null, 'P1 存在决策快照');
    const snapshotP1 = JSON.stringify(p1.decision.snapshot);

    // ---- 阶段 B：决策后的迟到证据不能改变结论 ----
    console.log('[e2e] 阶段 B：决策不可变');
    const late = await req('POST', `${BASE}/api/proposals/${p1.id}/evidence`, {
      consumerId: 'billing',
      candidateDigest: p1.candidateDigest,
      verdict: 'fail',
      runId: 'late-run',
      idempotencyKey: 'k-late-after-decision',
    });
    check(late.status === 200 && late.body.outcome === 'closed', '决策后的迟到证据被标记为 closed', late.body);
    const p1After = (await req('GET', `${BASE}/api/proposals/${p1.id}`)).body;
    check(p1After.status === 'approved', '迟到 fail 证据不影响已批准状态');
    check(JSON.stringify(p1After.decision.snapshot) === snapshotP1, '决策快照保持不可变');
    const dupDecide = await req('POST', `${BASE}/api/proposals/${p1.id}/decisions`, {
      action: 'reject',
      decidedBy: 'lead-c',
      expectedVersion: p1After.version,
    });
    check(dupDecide.status === 409, '重复决策被拒绝（409）', dupDecide.status);

    // ---- 阶段 C：破坏性候选 + 证据过期（手动时钟推进） ----
    console.log('[e2e] 阶段 C：破坏性变更门禁与证据新鲜度');
    const created2 = await req('POST', `${BASE}/api/proposals`, {
      title: 'order-events v3（破坏性）',
      baseline: BASELINE,
      candidate: BREAKING_CANDIDATE,
      consumers: ['billing', 'search'],
      evidenceTtlMs: TTL_MS,
    });
    check(created2.status === 201 && created2.body.compat.status === 'breaking', 'P2 被判定为破坏性', created2.body.compat);
    const p2 = created2.body;
    for (const c of ['billing', 'search']) {
      const ev = await req('POST', `${BASE}/api/proposals/${p2.id}/evidence`, {
        consumerId: c,
        candidateDigest: p2.candidateDigest,
        verdict: 'pass',
        runId: `run-${c}-1`,
        idempotencyKey: `k2-${c}-1`,
      });
      check(ev.status === 200 && ev.body.outcome === 'recorded', `P2 ${c} 证据已记录`);
    }
    const approveNoAck = await req('POST', `${BASE}/api/proposals/${p2.id}/decisions`, {
      action: 'approve',
      decidedBy: 'lead-a',
      expectedVersion: p2.version,
    });
    check(
      approveNoAck.status === 422 && approveNoAck.body.error.details.blockers.some((b: any) => b.code === 'breaking_compat'),
      '未确认破坏性变更时批准被门禁拦截',
      approveNoAck.body,
    );
    await req('POST', `${BASE}/api/clock/advance`, { ms: TTL_MS + 500 });
    const p2Stale = (await req('GET', `${BASE}/api/proposals/${p2.id}`)).body;
    check(
      p2Stale.gate.blockers.filter((b: any) => b.code === 'stale_evidence').length === 2,
      '时钟推进后证据过期',
      p2Stale.gate.blockers,
    );
    const approveStale = await req('POST', `${BASE}/api/proposals/${p2.id}/decisions`, {
      action: 'approve',
      decidedBy: 'lead-a',
      expectedVersion: p2.version,
      acknowledgeBreaking: true,
    });
    check(approveStale.status === 422, '过期证据即使确认破坏性也不能批准');
    for (const c of ['billing', 'search']) {
      await req('POST', `${BASE}/api/proposals/${p2.id}/evidence`, {
        consumerId: c,
        candidateDigest: p2.candidateDigest,
        verdict: 'pass',
        runId: `run-${c}-2`,
        idempotencyKey: `k2-${c}-2`,
      });
    }
    const p2Fresh = (await req('GET', `${BASE}/api/proposals/${p2.id}`)).body;
    check(
      p2Fresh.gate.blockers.length === 1 && p2Fresh.gate.blockers[0].code === 'breaking_compat',
      '新鲜证据齐备，仅剩破坏性阻塞项',
      p2Fresh.gate.blockers,
    );
    const [d1, d2] = await Promise.all([
      req('POST', `${BASE}/api/proposals/${p2.id}/decisions`, {
        action: 'approve', decidedBy: 'lead-a', expectedVersion: p2Fresh.version, acknowledgeBreaking: true, rationale: '已通知全部消费方升级窗口',
      }),
      req('POST', `${BASE}/api/proposals/${p2.id}/decisions`, {
        action: 'approve', decidedBy: 'lead-b', expectedVersion: p2Fresh.version, acknowledgeBreaking: true,
      }),
    ]);
    const wins = [d1, d2].filter((d) => d.status === 201).length;
    const conflicts = [d1, d2].filter((d) => d.status === 409).length;
    check(wins === 1 && conflicts === 1, '并发批准恰好一个生效，另一个 409', [d1.status, d2.status]);
    const p2Final = (await req('GET', `${BASE}/api/proposals/${p2.id}`)).body;
    const snapshotP2 = JSON.stringify(p2Final.decision.snapshot);

    // ---- 阶段 E：限时豁免（双审确认 / 撤销 / 到期 / 历史快照不变） ----
    console.log('[e2e] 阶段 E：限时豁免全生命周期');
    const created3 = await req('POST', `${BASE}/api/proposals`, {
      title: 'order-events v4（消费方离线）',
      baseline: BASELINE,
      candidate: COMPATIBLE_CANDIDATE,
      consumers: ['billing', 'search', 'offline-svc'],
      evidenceTtlMs: TTL_MS,
      environment: 'prod',
    });
    const p3 = created3.body;
    for (const c of ['billing', 'search']) {
      await req('POST', `${BASE}/api/proposals/${p3.id}/evidence`, {
        consumerId: c, candidateDigest: p3.candidateDigest, verdict: 'pass', runId: `run-${c}-p3`, idempotencyKey: `k3-${c}`,
      });
    }
    const p3Blocked = (await req('GET', `${BASE}/api/proposals/${p3.id}`)).body;
    check(p3Blocked.gate.blockers.some((b: any) => b.code === 'missing_evidence' && b.consumer === 'offline-svc'), 'P3 因 offline-svc 离线被阻塞');
    const exmReq = await req('POST', `${BASE}/api/proposals/${p3.id}/exemptions`, {
      consumerId: 'offline-svc', direction: 'backward', reason: '发布窗口内暂时离线', requestedBy: 'release-mgr', ttlMs: 60000,
    });
    check(exmReq.status === 201 && exmReq.body.status === 'pending', '豁免申请已创建（待复核）');
    const exmId = exmReq.body.id;
    const selfConfirm = await req('POST', `${BASE}/api/exemptions/${exmId}/confirm`, { by: 'release-mgr' });
    check(selfConfirm.status === 422, '申请人不能复核自己的豁免', selfConfirm.status);
    const c1 = await req('POST', `${BASE}/api/exemptions/${exmId}/confirm`, { by: 'reviewer-a' });
    check(c1.status === 200 && c1.body.status === 'pending', '第一名审核人确认后仍待复核');
    const cDup = await req('POST', `${BASE}/api/exemptions/${exmId}/confirm`, { by: 'reviewer-a' });
    check(cDup.status === 409, '同一审核人不能重复确认', cDup.status);
    const c2 = await req('POST', `${BASE}/api/exemptions/${exmId}/confirm`, { by: 'reviewer-b' });
    check(c2.status === 200 && c2.body.status === 'active', '第二名审核人确认后豁免生效');
    const p3Ready = (await req('GET', `${BASE}/api/proposals/${p3.id}`)).body;
    check(p3Ready.gate.status === 'ready' && p3Ready.gate.waived.length === 1, '生效豁免抵消缺失证据，门禁就绪', p3Ready.gate);
    const dec3 = await req('POST', `${BASE}/api/proposals/${p3.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p3Ready.version, rationale: '豁免覆盖离线消费方',
    });
    check(dec3.status === 201 && dec3.body.decision.snapshot.exemptionsUsed.length === 1, '决策快照逐条拷贝生效豁免');
    const snapshotP3 = JSON.stringify(dec3.body.decision.snapshot);
    const revoke = await req('POST', `${BASE}/api/exemptions/${exmId}/revoke`, { by: 'ops', reason: '离线窗口提前结束' });
    check(revoke.status === 200 && revoke.body.effectiveStatus === 'revoked', '豁免已撤销');
    const p3After = (await req('GET', `${BASE}/api/proposals/${p3.id}`)).body;
    check(JSON.stringify(p3After.decision.snapshot) === snapshotP3, '撤销豁免后历史决策快照保持原样');
    check(p3After.status === 'approved', '撤销豁免不改变既有批准结论');

    // 到期路径：豁免到期后退出新决策，到期原因进入审计链
    const created4 = await req('POST', `${BASE}/api/proposals`, {
      title: 'order-events v5（豁免到期）',
      baseline: BASELINE,
      candidate: COMPATIBLE_CANDIDATE,
      consumers: ['billing', 'offline-2'],
      evidenceTtlMs: TTL_MS,
    });
    const p4 = created4.body;
    await req('POST', `${BASE}/api/proposals/${p4.id}/evidence`, {
      consumerId: 'billing', candidateDigest: p4.candidateDigest, verdict: 'pass', runId: 'run-b-p4', idempotencyKey: 'k4-billing',
    });
    const exmReject = await req('POST', `${BASE}/api/proposals/${p4.id}/exemptions`, {
      consumerId: 'offline-2', direction: 'backward', reason: '窗口外申请', requestedBy: 'release-mgr', ttlMs: 60000,
    });
    const rejected = await req('POST', `${BASE}/api/exemptions/${exmReject.body.id}/reject`, { by: 'reviewer-c', reason: '不符合豁免政策' });
    check(rejected.status === 200 && rejected.body.effectiveStatus === 'rejected' && rejected.body.rejectReason === '不符合豁免政策', '豁免可被拒绝并注明原因');
    const exmShort = await req('POST', `${BASE}/api/proposals/${p4.id}/exemptions`, {
      consumerId: 'offline-2', direction: 'backward', reason: '短时离线', requestedBy: 'release-mgr', ttlMs: 500,
    });
    await req('POST', `${BASE}/api/exemptions/${exmShort.body.id}/confirm`, { by: 'reviewer-a' });
    await req('POST', `${BASE}/api/exemptions/${exmShort.body.id}/confirm`, { by: 'reviewer-b' });
    const p4Waived = (await req('GET', `${BASE}/api/proposals/${p4.id}`)).body;
    check(p4Waived.gate.status === 'ready' && p4Waived.gate.waived.length === 1, 'P4 短时豁免生效，门禁就绪');
    await req('POST', `${BASE}/api/clock/advance`, { ms: 600 });
    const p4Expired = (await req('GET', `${BASE}/api/proposals/${p4.id}`)).body;
    const exmExpiredView = p4Expired.exemptions.find((x: any) => x.id === exmShort.body.id);
    check(exmExpiredView?.effectiveStatus === 'expired', '时钟推进后豁免到期');
    check(p4Expired.gate.blockers.some((b: any) => b.code === 'missing_evidence' && b.consumer === 'offline-2'), '到期豁免不再参与新决策');
    check(p4Expired.events.some((e: any) => e.type === 'EXEMPTION_EXPIRED' && String(e.payload.reason).includes('到期')), '到期原因已进入审计链');
    const approveExpired = await req('POST', `${BASE}/api/proposals/${p4.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p4Expired.version,
    });
    check(approveExpired.status === 422, '到期豁免下批准被门禁拦截');
    await req('POST', `${BASE}/api/proposals/${p4.id}/evidence`, {
      consumerId: 'offline-2', candidateDigest: p4.candidateDigest, verdict: 'pass', runId: 'run-o2-late', idempotencyKey: 'k4-offline2',
    });
    const p4Final = (await req('GET', `${BASE}/api/proposals/${p4.id}`)).body;
    const dec4 = await req('POST', `${BASE}/api/proposals/${p4.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p4Final.version,
    });
    check(dec4.status === 201, '离线消费方恢复报送后正常批准');

    // ---- 阶段 F：提案谱系（后继提案 / 证据与豁免不继承 / 迟到归入原提案） ----
    console.log('[e2e] 阶段 F：提案谱系');
    const created5 = await req('POST', `${BASE}/api/proposals`, {
      title: 'order-events v6（将被替代）',
      baseline: BASELINE,
      candidate: COMPATIBLE_CANDIDATE,
      consumers: ['billing', 'offline-x'],
      evidenceTtlMs: TTL_MS,
    });
    const p5 = created5.body;
    await req('POST', `${BASE}/api/proposals/${p5.id}/evidence`, {
      consumerId: 'billing', candidateDigest: p5.candidateDigest, verdict: 'pass', runId: 'run-b-p5', idempotencyKey: 'k5-billing',
    });
    const exm5 = await req('POST', `${BASE}/api/proposals/${p5.id}/exemptions`, {
      consumerId: 'offline-x', direction: 'backward', reason: '离线', requestedBy: 'release-mgr', ttlMs: 60000,
    });
    await req('POST', `${BASE}/api/exemptions/${exm5.body.id}/confirm`, { by: 'reviewer-a' });
    await req('POST', `${BASE}/api/exemptions/${exm5.body.id}/confirm`, { by: 'reviewer-b' });
    check((await req('GET', `${BASE}/api/proposals/${p5.id}`)).body.gate.status === 'ready', 'P5 凭豁免就绪');
    const succ6 = await req('POST', `${BASE}/api/proposals/${p5.id}/successors`, {
      candidate: { ...COMPATIBLE_CANDIDATE, properties: { ...COMPATIBLE_CANDIDATE.properties, orderId: { type: 'string', minLength: 6 } } },
      reason: '上游修正候选', createdBy: 'dev',
    });
    check(succ6.status === 201, '后继提案 P6 创建成功');
    const p6 = succ6.body;
    check(p6.predecessorId === p5.id && p6.candidateDigest !== p5.candidateDigest, 'P6 谱系链接与新候选摘要');
    const p5After = (await req('GET', `${BASE}/api/proposals/${p5.id}`)).body;
    check(p5After.status === 'superseded' && p5After.supersededById === p6.id, 'P5 被替代关闭');
    check(p5After.events.some((e: any) => e.type === 'PROPOSAL_SUPERSEDED'), '替代已写入 P5 因果记录');
    check(p6.evidence.length === 0 && p6.gate.blockers.filter((b: any) => b.code === 'missing_evidence').length === 2, '旧提案证据不沿用到 P6');
    check(p6.exemptions.length === 0 && p6.gate.waived.length === 0, '同名消费方的豁免不继承到 P6');
    const lateP5 = await req('POST', `${BASE}/api/proposals/${p5.id}/evidence`, {
      consumerId: 'offline-x', candidateDigest: p5.candidateDigest, verdict: 'pass', runId: 'late-p5', idempotencyKey: 'k5-late',
    });
    check(lateP5.status === 200 && lateP5.body.outcome === 'closed', '旧候选迟到结果归入原提案并隔离', lateP5.body);
    const p5Late = (await req('GET', `${BASE}/api/proposals/${p5.id}`)).body;
    check(p5Late.events.some((e: any) => e.type === 'EVIDENCE_LATE' && e.payload.outcome === 'closed'), '迟到报送已写入因果记录');
    const wrongTarget = await req('POST', `${BASE}/api/proposals/${p6.id}/evidence`, {
      consumerId: 'offline-x', candidateDigest: p5.candidateDigest, verdict: 'pass', runId: 'late-p6', idempotencyKey: 'k6-wrong-digest',
    });
    check(wrongTarget.body.outcome === 'stale_candidate', '旧摘要发往后继按 stale_candidate 隔离');
    const p6Gate = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body;
    check(p6Gate.gate.status === 'blocked' && p6Gate.gate.blockers.filter((b: any) => b.code === 'missing_evidence').length === 2, '迟到结果不得放行后继提案');
    const decideOld = await req('POST', `${BASE}/api/proposals/${p5.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p5.version,
    });
    check(decideOld.status === 409 && decideOld.body.error.code === 'PROPOSAL_SUPERSEDED', '被替代提案不能决策');
    const fork = await req('POST', `${BASE}/api/proposals/${p5.id}/successors`, { candidate: COMPATIBLE_CANDIDATE });
    check(fork.status === 409 && fork.body.error.code === 'ALREADY_SUPERSEDED', '谱系保持线性（禁止重复派生）');
    // 已批准提案也可派生下一轮：P1 保持原结论
    const succ7 = await req('POST', `${BASE}/api/proposals/${p1.id}/successors`, {
      candidate: COMPATIBLE_CANDIDATE, title: 'order-events v2 下一轮', reason: '下一轮迭代',
    });
    check(succ7.status === 201 && succ7.body.predecessorId === p1.id, '已批准提案派生 P7');
    const p1Keep = (await req('GET', `${BASE}/api/proposals/${p1.id}`)).body;
    check(p1Keep.status === 'approved' && JSON.stringify(p1Keep.decision.snapshot) === snapshotP1, 'P1 原结论与快照不变');
    // P6 补齐证据后正常批准
    for (const c of ['billing', 'offline-x']) {
      await req('POST', `${BASE}/api/proposals/${p6.id}/evidence`, {
        consumerId: c, candidateDigest: p6.candidateDigest, verdict: 'pass', runId: `run-${c}-p6`, idempotencyKey: `k6-${c}`,
      });
    }
    const p6Final = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body;
    const dec6 = await req('POST', `${BASE}/api/proposals/${p6.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p6Final.version,
    });
    check(dec6.status === 201, 'P6 补齐证据后正常批准');
    const snapshotP6 = JSON.stringify(dec6.body.decision.snapshot);

    // ---- 阶段 G：分阶段发布（适配器模拟器：回执丢失 / 乱序 / 中途重启 / 回退） ----
    console.log('[e2e] 阶段 G：分阶段发布');
    const scenarioB = {
      server: BASE,
      steps: [
        { do: 'rollout', proposalId: p6.id, as: 'ro6', by: 'release-lead', waves: [
          { name: 'w1-预发', environment: 'staging' },
          { name: 'w2-灰度', environment: 'prod' },
          { name: 'w3-全量', environment: 'prod' },
        ] },
        { do: 'receipt', rollout: 'ro6', wave: 1, result: 'success', key: 'rc6-w1', loseResponse: true, repeat: 2 },
        { do: 'receipt', rollout: 'ro6', wave: 2, result: 'success', key: 'rc6-bad-dec', decision: 'stale', expectOutcome: 'stale_decision' },
        { do: 'receipt', rollout: 'ro6', wave: 3, result: 'success', key: 'rc6-ooo', expectOutcome: 'stale_wave' },
        { do: 'receipt', rollout: 'ro6', wave: 2, result: 'success', key: 'rc6-w2', expectOutcome: 'applied' },
        { do: 'receipt', rollout: 'ro6', wave: 3, result: 'failure', key: 'rc6-w3', expectOutcome: 'applied' },
      ],
    };
    const scenarioBPath = path.join(dir, 'scenarioB.json');
    writeFileSync(scenarioBPath, JSON.stringify(scenarioB, null, 2));
    check((await runSimulator(scenarioBPath)) === 0, '适配器模拟器（回执丢失/乱序）断言通过');
    let ro6 = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body.rollout;
    check(ro6.status === 'paused' && ro6.waves[2].status === 'failed', '波次 3 失败后发布自动暂停');
    check(ro6.receipts.find((r: any) => r.receiptKey === 'rc6-w1') !== undefined && ro6.receipts.filter((r: any) => r.receiptKey === 'rc6-w1').length === 1, '丢失回执重发只生效一次');
    check(ro6.receipts.some((r: any) => r.outcome === 'stale_decision') && ro6.receipts.some((r: any) => r.outcome === 'stale_wave'), '决策不匹配与乱序回执被隔离记录');
    // 中途重启：发布状态从 SQLite 恢复，波次 3 保持失败
    await stopServer(server);
    server = startServer(dbPath);
    await waitHealthy();
    ro6 = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body.rollout;
    check(ro6.status === 'paused' && ro6.currentOrdinal === 3, '重启后发布状态完整恢复');
    const retryW3 = await req('POST', `${BASE}/api/rollouts/${ro6.id}/waves/${ro6.waves[2].id}/retry`, { by: 'release-lead' });
    check(retryW3.status === 200 && retryW3.body.status === 'active' && retryW3.body.waves[2].retryCount === 1, '重试失败波次');
    await req('POST', `${BASE}/api/rollouts/${ro6.id}/receipts`, {
      waveId: ro6.waves[2].id, decisionId: ro6.decisionId, result: 'success', receiptKey: 'rc6-w3-retry',
    });
    ro6 = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body.rollout;
    check(ro6.status === 'completed' && ro6.waves.every((w: any) => w.status === 'succeeded'), 'P6 发布完成');
    const p6Keep = (await req('GET', `${BASE}/api/proposals/${p6.id}`)).body;
    check(JSON.stringify(p6Keep.decision.snapshot) === snapshotP6, '发布推进不改写原契约决策快照');

    // 回退：P7 批准后创建发布，完成后回退到已知版本
    for (const c of ['billing', 'search', 'risk']) {
      await req('POST', `${BASE}/api/proposals/${succ7.body.id}/evidence`, {
        consumerId: c, candidateDigest: succ7.body.candidateDigest, verdict: 'pass', runId: `run-${c}-p7`, idempotencyKey: `k7-${c}`,
      });
    }
    const p7Fresh = (await req('GET', `${BASE}/api/proposals/${succ7.body.id}`)).body;
    const dec7 = await req('POST', `${BASE}/api/proposals/${succ7.body.id}/decisions`, {
      action: 'approve', decidedBy: 'lead-a', expectedVersion: p7Fresh.version,
    });
    check(dec7.status === 201, 'P7 批准');
    const snapshotP7 = JSON.stringify(dec7.body.decision.snapshot);
    const ro7created = await req('POST', `${BASE}/api/proposals/${succ7.body.id}/rollouts`, {
      waves: [{ name: 'w1-预发', environment: 'staging' }, { name: 'w2-全量', environment: 'prod' }],
      createdBy: 'release-lead',
    });
    check(ro7created.status === 201 && ro7created.body.status === 'active', 'P7 发布创建');
    const ro7 = ro7created.body;
    // 暂停期间回执被隔离
    await req('POST', `${BASE}/api/rollouts/${ro7.id}/pause`, { by: 'ops' });
    const pausedReceipt = await req('POST', `${BASE}/api/rollouts/${ro7.id}/receipts`, {
      waveId: ro7.waves[0].id, decisionId: ro7.decisionId, result: 'success', receiptKey: 'rc7-paused',
    });
    check(pausedReceipt.body.outcome === 'paused', '暂停期间回执不推进波次');
    await req('POST', `${BASE}/api/rollouts/${ro7.id}/resume`, { by: 'ops' });
    for (const [i, w] of ro7.waves.entries()) {
      await req('POST', `${BASE}/api/rollouts/${ro7.id}/receipts`, {
        waveId: w.id, decisionId: ro7.decisionId, result: 'success', receiptKey: `rc7-w${i + 1}`,
      });
    }
    const ro7Done = (await req('GET', `${BASE}/api/rollouts/${ro7.id}`)).body;
    check(ro7Done.status === 'completed', 'P7 发布完成');
    const rollback = await req('POST', `${BASE}/api/rollouts/${ro7.id}/rollback`, {
      toWaveOrdinal: 1, by: 'ops', reason: '全量后指标异常，回到预发版本',
    });
    check(rollback.status === 200 && rollback.body.status === 'rolled_back' && rollback.body.rolledBackTo === 1, '回退到已知版本（波次 1）');
    check(rollback.body.waves.map((w: any) => w.status).join(',') === 'succeeded,rolled_back', '后续波次标记已回退');
    const p7After = (await req('GET', `${BASE}/api/proposals/${succ7.body.id}`)).body;
    check(JSON.stringify(p7After.decision.snapshot) === snapshotP7, '回退不改写原契约决策快照');
    const p3Check = (await req('GET', `${BASE}/api/proposals/${p3.id}`)).body;
    check(p3Check.exemptions[0]?.effectiveStatus === 'revoked', '回退不复活已失效豁免');
    const badRollback = await req('POST', `${BASE}/api/rollouts/${ro7.id}/rollback`, { toWaveOrdinal: 0, by: 'ops' });
    check(badRollback.status === 409, '不能重复回退');

    // ---- 阶段 D：重启恢复与 SSE 重放 ----
    console.log('[e2e] 阶段 D：重启恢复');
    const before = (await req('GET', `${BASE}/api/snapshot`)).body;
    await stopServer(server);
    console.log('[e2e] 服务已停止，使用同一 SQLite 文件重启');
    server = startServer(dbPath);
    await waitHealthy();
    const after = (await req('GET', `${BASE}/api/snapshot`)).body;
    check(after.proposals.length === 7, '重启后提案数量完整');
    const p1r = after.proposals.find((p: any) => p.id === p1.id);
    const p2r = after.proposals.find((p: any) => p.id === p2.id);
    const p3r = after.proposals.find((p: any) => p.id === p3.id);
    const p4r = after.proposals.find((p: any) => p.id === p4.id);
    const p5r = after.proposals.find((p: any) => p.id === p5.id);
    const p6r = after.proposals.find((p: any) => p.id === p6.id);
    const p7r = after.proposals.find((p: any) => p.id === succ7.body.id);
    check(p1r?.status === 'approved' && JSON.stringify(p1r.decision.snapshot) === snapshotP1, 'P1 决策快照在重启后一致');
    check(p2r?.status === 'approved' && JSON.stringify(p2r.decision.snapshot) === snapshotP2, 'P2 决策快照在重启后一致');
    check(p3r?.status === 'approved' && JSON.stringify(p3r.decision.snapshot) === snapshotP3, 'P3（含豁免）决策快照在重启后一致');
    check(p3r?.exemptions[0]?.effectiveStatus === 'revoked', 'P3 豁免撤销状态在重启后保留');
    check(p4r?.status === 'approved', 'P4 在重启后保持已批准');
    check(p4r?.exemptions.some((x: any) => x.effectiveStatus === 'expired') && p4r?.exemptions.some((x: any) => x.effectiveStatus === 'rejected'), 'P4 豁免到期/拒绝状态在重启后保留');
    check(p5r?.status === 'superseded' && p5r?.supersededById === p6.id && p6r?.predecessorId === p5.id, '谱系与替代状态在重启后保留');
    check(p5r?.events.some((e: any) => e.type === 'EVIDENCE_LATE'), '迟到因果记录在重启后保留');
    check(p6r?.status === 'approved', 'P6 在重启后保持已批准');
    check(p6r?.rollout?.status === 'completed' && p6r?.rollout?.receipts?.length === 6, 'P6 发布完成状态与回执在重启后保留');
    check(p7r?.rollout?.status === 'rolled_back' && p7r?.rollout?.rolledBackTo === 1, 'P7 回退状态在重启后保留');
    check(p7r?.rollout?.receipts?.some((r: any) => r.outcome === 'paused'), '暂停期回执隔离记录在重启后保留');
    check(after.eventCursor >= before.eventCursor, '事件游标连续（重启不丢事件）', { before: before.eventCursor, after: after.eventCursor });
    check(p1r.events.length === p1.events.length + 3, '因果事件记录完整（迟到证据 + 迟到隔离 + 替代事件）');

    const sseOk = await new Promise<boolean>((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { ctrl.abort(); resolve(false); }, 3000);
      fetch(`${BASE}/api/events?since=0`, { signal: ctrl.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          let buf = '';
          while (!buf.includes('DECISION_MADE')) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
          }
          clearTimeout(timer);
          ctrl.abort();
          resolve(buf.includes('DECISION_MADE'));
        })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
    check(sseOk, 'SSE 从 SQLite 重放历史事件（重启后可恢复订阅）');
  } finally {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`[e2e] 失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('[e2e] 全部通过');
}

await main();
