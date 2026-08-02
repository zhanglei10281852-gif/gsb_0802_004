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
  rollouts: Record<string, { id: string; decisionId: string; waves: { id: string; ordinal: number }[] }>;
  revalidations: Record<string, string>;
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
    case 'rollout': {
      const p = step.proposalId
        ? { id: String(step.proposalId), candidateDigest: '', version: 0 }
        : await getProposal(ctx, String(step.proposal));
      const res = await req('POST', `${ctx.base}/api/proposals/${p.id}/rollouts`, {
        waves: step.waves,
        createdBy: String(step.by ?? 'simulator'),
      });
      const body = res.body as { id?: string; decisionId?: string; waves?: { id: string; ordinal: number }[] };
      log({ step: 'rollout', status: res.status, id: body.id });
      expect(res.status === 201, `创建发布失败: ${JSON.stringify(res.body)}`, ctx);
      if (body.id) {
        ctx.rollouts[String(step.as ?? 'default')] = {
          id: body.id,
          decisionId: body.decisionId ?? '',
          waves: (body.waves ?? []).map((w) => ({ id: w.id, ordinal: w.ordinal })),
        };
      }
      return;
    }
    case 'receipt': {
      const ro = ctx.rollouts[String(step.rollout)];
      if (!ro) throw new Error(`未知发布别名 ${String(step.rollout)}`);
      // 刷新发布状态（适配器重启后从服务端恢复上下文）
      const fresh = await req('GET', `${ctx.base}/api/rollouts/${ro.id}`);
      const fb = fresh.body as { decisionId: string; waves: { id: string; ordinal: number }[] };
      ro.decisionId = fb.decisionId;
      ro.waves = fb.waves.map((w) => ({ id: w.id, ordinal: w.ordinal }));
      const wave = ro.waves.find((w) => w.ordinal === Number(step.wave));
      if (!wave) throw new Error(`发布 ${String(step.rollout)} 没有序号 ${String(step.wave)} 的波次`);
      const decisionSpec = String(step.decision ?? 'current');
      const decisionId = decisionSpec === 'current' ? ro.decisionId : decisionSpec === 'stale' ? 'dec_stale_unknown' : decisionSpec;
      const payload = {
        waveId: wave.id,
        decisionId,
        result: (step.result as string) ?? 'success',
        receiptKey: String(step.key ?? randomUUID()),
        detail: (step.detail as unknown) ?? { simulator: true },
      };
      const repeat = Number(step.repeat ?? 1);
      for (let i = 0; i < repeat; i++) {
        const url = `${ctx.base}/api/rollouts/${ro.id}/receipts`;
        if (step.loseResponse === true && i === 0) {
          // 回执丢失：适配器发出回执后进程崩溃/响应丢失，随后用相同幂等键重发。
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => undefined);
          log({ step: 'receipt', wave: wave.ordinal, key: payload.receiptKey, note: '回执丢失（模拟崩溃），将重发' });
          continue;
        }
        const res = await req('POST', url, payload);
        const body = res.body as { outcome?: string; error?: { code?: string } };
        log({ step: 'receipt', wave: wave.ordinal, key: payload.receiptKey, attempt: i + 1, status: res.status, outcome: body.outcome ?? body.error?.code });
        if (step.expectOutcome !== undefined) expect(body.outcome === step.expectOutcome, `期望 outcome ${String(step.expectOutcome)}，实际 ${String(body.outcome)}`, ctx);
        if (step.expectStatus !== undefined) expect(res.status === Number(step.expectStatus), `期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
      }
      return;
    }
    case 'dependency': {
      const p = step.proposalId
        ? { id: String(step.proposalId) }
        : await getProposal(ctx, String(step.proposal));
      const res = await req('POST', `${ctx.base}/api/proposals/${p.id}/dependencies`, {
        consumerId: String(step.consumer),
        by: String(step.by ?? 'simulator'),
        reason: step.reason,
      });
      const body = res.body as { revalidations?: { id: string; consumerId: string }[] };
      log({ step: 'dependency', consumer: step.consumer, status: res.status });
      if (step.expectStatus !== undefined) expect(res.status === Number(step.expectStatus), `期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
      else expect(res.status === 201, `添加依赖失败: ${JSON.stringify(res.body)}`, ctx);
      const rv = (body.revalidations ?? []).find((r) => r.consumerId === step.consumer);
      if (rv) ctx.revalidations[String(step.consumer)] = rv.id;
      return;
    }
    case 'revalidate': {
      const rvId = step.revalidationId ? String(step.revalidationId) : ctx.revalidations[String(step.consumer)];
      if (!rvId) throw new Error(`未知再验证（consumer=${String(step.consumer)}）`);
      const payload = {
        verdict: step.verdict === 'fail' ? 'fail' : 'pass',
        runId: String(step.runId ?? `run_${randomUUID()}`),
        idempotencyKey: String(step.key ?? randomUUID()),
        by: step.by,
      };
      const repeat = Number(step.repeat ?? 1);
      for (let i = 0; i < repeat; i++) {
        const url = `${ctx.base}/api/revalidations/${rvId}/conclude`;
        if (step.loseResponse === true && i === 0) {
          await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => undefined);
          log({ step: 'revalidate', consumer: step.consumer, key: payload.idempotencyKey, note: '响应丢失（模拟崩溃），将重发' });
          continue;
        }
        const res = await req('POST', url, payload);
        const body = res.body as { outcome?: string };
        log({ step: 'revalidate', consumer: step.consumer, key: payload.idempotencyKey, attempt: i + 1, status: res.status, outcome: body.outcome });
        if (step.expectOutcome !== undefined) expect(body.outcome === step.expectOutcome, `期望 outcome ${String(step.expectOutcome)}，实际 ${String(body.outcome)}`, ctx);
      }
      return;
    }
    case 'rolloutControl': {
      const ro = ctx.rollouts[String(step.rollout)];
      if (!ro) throw new Error(`未知发布别名 ${String(step.rollout)}`);
      const action = String(step.action);
      let url = `${ctx.base}/api/rollouts/${ro.id}`;
      let body: Record<string, unknown> = { by: String(step.by ?? 'simulator') };
      if (action === 'retry') {
        const wave = ro.waves.find((w) => w.ordinal === Number(step.wave));
        if (!wave) throw new Error(`没有序号 ${String(step.wave)} 的波次`);
        url += `/waves/${wave.id}/retry`;
      } else if (action === 'rollback') {
        url += '/rollback';
        body = { ...body, toWaveOrdinal: Number(step.toWaveOrdinal ?? 0), reason: step.reason };
      } else {
        url += `/${action}`;
      }
      const res = await req('POST', url, body);
      log({ step: 'rolloutControl', action, status: res.status });
      if (step.expectStatus !== undefined) expect(res.status === Number(step.expectStatus), `期望状态 ${String(step.expectStatus)}，实际 ${res.status}`, ctx);
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
    rollouts: {},
    revalidations: {},
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
