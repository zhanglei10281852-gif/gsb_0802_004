import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * 构建代理模拟器：按场景 JSON 逐步执行，可脚本化复现真实链路的
 * 重复报送、乱序/迟到、写后丢响应（崩溃重试）、旧候选与未知消费方。
 * 步骤默认立即执行；只有传 --real-time 时 waitMs 才会真实睡眠。
 */

interface Step {
  do: string;
  [k: string]: unknown;
}

interface Scenario {
  server: string;
  steps: Step[];
}

interface Ctx {
  base: string;
  realTime: boolean;
  proposals: Record<string, { id: string; candidateDigest: string; version: number }>;
  failed: number;
}

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

async function req(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function expect(cond: boolean, message: string, ctx: Ctx): void {
  if (!cond) {
    ctx.failed++;
    log({ level: 'error', check: 'FAILED', message });
  }
}

async function getProposal(ctx: Ctx, alias: string): Promise<{ id: string; candidateDigest: string; version: number }> {
  const p = ctx.proposals[alias];
  if (!p) throw new Error(`未知提案别名 ${alias}`);
  const res = await req('GET', `${ctx.base}/api/proposals/${p.id}`);
  const body = res.body as { candidateDigest: string; version: number };
  p.candidateDigest = body.candidateDigest;
  p.version = body.version;
  return p;
}

async function stepEvidence(step: Step, ctx: Ctx): Promise<void> {
  const p = await getProposal(ctx, String(step.proposal));
  const repeat = Number(step.repeat ?? 1);
  const key = String(step.key ?? randomUUID());
  const runId = String(step.runId ?? `run_${randomUUID()}`);
  const digestSpec = String(step.digest ?? 'current');
  const candidateDigest =
    digestSpec === 'current'
      ? p.candidateDigest
      : digestSpec === 'stale'
        ? 'sha256:' + '00'.repeat(32)
        : digestSpec;
  const payload = {
    consumerId: String(step.consumer),
    candidateDigest,
    verdict: step.verdict === 'fail' ? 'fail' : 'pass',
    runId,
    idempotencyKey: key,
    details: (step.details as unknown) ?? { simulator: true },
  };
  for (let i = 0; i < repeat; i++) {
    const url = `${ctx.base}/api/proposals/${p.id}/evidence`;
    if (step.loseResponse === true && i === 0) {
      // 模拟“写入后、回复前崩溃”：请求已发出且服务端已处理，代理不等响应即放弃，
      // 之后用相同幂等键重试，期望服务端返回 duplicate 而不是重复生效。
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
      log({ step: 'evidence', consumer: payload.consumerId, key, note: '响应被丢弃（模拟崩溃），将重试' });
      continue;
    }
    const res = await req('POST', url, payload);
    const body = res.body as { outcome?: string; error?: { code?: string; message?: string } };
    log({ step: 'evidence', consumer: payload.consumerId, key, attempt: i + 1, status: res.status, outcome: body.outcome ?? body.error?.code });
    if (step.expectStatus !== undefined) expect(res.status === Number(step.expectStatus), `期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
    if (step.expectOutcome !== undefined) expect(body.outcome === step.expectOutcome, `期望 outcome ${String(step.expectOutcome)}，实际 ${String(body.outcome)}`, ctx);
  }
}

async function runStep(step: Step, ctx: Ctx): Promise<void> {
  switch (step.do) {
    case 'waitMs': {
      if (ctx.realTime) await new Promise((r) => setTimeout(r, Number(step.ms)));
      else log({ step: 'waitMs', skipped: true, ms: step.ms });
      return;
    }
    case 'createProposal': {
      const res = await req('POST', `${ctx.base}/api/proposals`, {
        title: step.title,
        createdBy: step.createdBy ?? 'simulator',
        baseline: step.baseline,
        candidate: step.candidate,
        consumers: step.consumers,
        evidenceTtlMs: step.evidenceTtlMs,
      });
      const body = res.body as { id?: string; candidateDigest?: string; version?: number; error?: unknown };
      log({ step: 'createProposal', status: res.status, id: body.id });
      expect(res.status === 201, `创建提案失败: ${JSON.stringify(body)}`, ctx);
      if (body.id) {
        ctx.proposals[String(step.as ?? 'default')] = {
          id: body.id,
          candidateDigest: body.candidateDigest ?? '',
          version: body.version ?? 1,
        };
      }
      return;
    }
    case 'revision': {
      const p = await getProposal(ctx, String(step.proposal));
      const res = await req('POST', `${ctx.base}/api/proposals/${p.id}/revisions`, {
        candidate: step.candidate,
        expectedVersion: p.version,
      });
      const body = res.body as { candidateDigest?: string; version?: number };
      log({ step: 'revision', status: res.status, digest: body.candidateDigest, version: body.version });
      expect(res.status === 200, `修订失败: ${JSON.stringify(res.body)}`, ctx);
      if (body.candidateDigest) {
        p.candidateDigest = body.candidateDigest;
        p.version = body.version ?? p.version;
      }
      return;
    }
    case 'successor': {
      const p = await getProposal(ctx, String(step.proposal));
      const res = await req('POST', `${ctx.base}/api/proposals/${p.id}/successors`, {
        candidate: step.candidate,
        title: step.title,
        consumers: step.consumers,
        environment: step.environment,
        reason: step.reason,
        createdBy: step.createdBy ?? 'simulator',
      });
      const body = res.body as { id?: string; candidateDigest?: string; version?: number; error?: { code?: string } };
      log({ step: 'successor', from: p.id, status: res.status, id: body.id });
      if (step.expectStatus !== undefined) {
        expect(res.status === Number(step.expectStatus), `后继期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
      } else {
        expect(res.status === 201, `创建后继失败: ${JSON.stringify(res.body)}`, ctx);
      }
      if (body.id) {
        ctx.proposals[String(step.as ?? 'default')] = {
          id: body.id,
          candidateDigest: body.candidateDigest ?? '',
          version: body.version ?? 1,
        };
      }
      return;
    }
    case 'evidence':
      await stepEvidence(step, ctx);
      return;
    case 'decide': {
      const p = await getProposal(ctx, String(step.proposal));
      const res = await req('POST', `${ctx.base}/api/proposals/${p.id}/decisions`, {
        action: step.action === 'reject' ? 'reject' : 'approve',
        decidedBy: String(step.by ?? 'simulator'),
        expectedVersion: p.version,
        rationale: step.rationale,
        acknowledgeBreaking: step.acknowledgeBreaking === true,
      });
      log({ step: 'decide', by: step.by, status: res.status });
      if (step.expectStatus !== undefined) expect(res.status === Number(step.expectStatus), `决策期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
      return;
    }
    case 'concurrentDecisions': {
      const p = await getProposal(ctx, String(step.proposal));
      const list = (step.decisions as { by: string; action?: string }[]) ?? [];
      const results = await Promise.all(
        list.map((d) =>
          req('POST', `${ctx.base}/api/proposals/${p.id}/decisions`, {
            action: d.action === 'reject' ? 'reject' : 'approve',
            decidedBy: d.by,
            expectedVersion: p.version,
            acknowledgeBreaking: step.acknowledgeBreaking === true,
          }),
        ),
      );
      const statuses = results.map((r) => r.status);
      const wins = statuses.filter((s) => s === 201).length;
      log({ step: 'concurrentDecisions', statuses, wins });
      expect(wins === 1, `并发决策必须恰好一个生效，实际生效 ${wins} 个`, ctx);
      return;
    }
    case 'advanceClock': {
      const res = await req('POST', `${ctx.base}/api/clock/advance`, { ms: Number(step.ms) });
      log({ step: 'advanceClock', status: res.status, body: res.body });
      return;
    }
    case 'snapshot': {
      const res = await req('GET', `${ctx.base}/api/snapshot`);
      const body = res.body as { serverTime: number; eventCursor: number; proposals: unknown[] };
      log({ step: 'snapshot', serverTime: body.serverTime, eventCursor: body.eventCursor, proposals: body.proposals?.length });
      return;
    }
    default:
      throw new Error(`未知步骤类型 ${step.do}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法: node dist/agent/simulator.js <scenario.json> [--real-time]');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  const ctx: Ctx = {
    base: scenario.server.replace(/\/$/, ''),
    realTime: args.includes('--real-time'),
    proposals: {},
    failed: 0,
  };
  log({ step: 'start', server: ctx.base, steps: scenario.steps.length, realTime: ctx.realTime });
  for (const [i, step] of scenario.steps.entries()) {
    try {
      await runStep(step, ctx);
    } catch (err) {
      ctx.failed++;
      log({ level: 'error', stepIndex: i, do: step.do, message: (err as Error).message });
    }
  }
  log({ step: 'done', failed: ctx.failed });
  process.exit(ctx.failed === 0 ? 0 : 1);
}

await main();
