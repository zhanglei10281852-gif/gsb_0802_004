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

    // ---- 阶段 D：重启恢复与 SSE 重放 ----
    console.log('[e2e] 阶段 D：重启恢复');
    const before = (await req('GET', `${BASE}/api/snapshot`)).body;
    await stopServer(server);
    console.log('[e2e] 服务已停止，使用同一 SQLite 文件重启');
    server = startServer(dbPath);
    await waitHealthy();
    const after = (await req('GET', `${BASE}/api/snapshot`)).body;
    check(after.proposals.length === 2, '重启后提案数量完整');
    const p1r = after.proposals.find((p: any) => p.id === p1.id);
    const p2r = after.proposals.find((p: any) => p.id === p2.id);
    check(p1r?.status === 'approved' && JSON.stringify(p1r.decision.snapshot) === snapshotP1, 'P1 决策快照在重启后一致');
    check(p2r?.status === 'approved' && JSON.stringify(p2r.decision.snapshot) === snapshotP2, 'P2 决策快照在重启后一致');
    check(after.eventCursor >= before.eventCursor, '事件游标连续（重启不丢事件）', { before: before.eventCursor, after: after.eventCursor });
    check(p1r.events.length === p1.events.length + 1, '因果事件记录完整（含迟到证据事件）');

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
