import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import Ajv2020Class from 'ajv/dist/2020.js';
import type { Clock } from '../core/clock.js';
import { ManualClock } from '../core/clock.js';
import type { DecisionAction, DomainEvent, EvidenceInput } from '../core/types.js';
import { Store, StoreError } from './store.js';

// ajv 的 CJS 类型声明在 NodeNext 下不可直接构造，运行时尚是类本身。
const Ajv2020 = Ajv2020Class as unknown as new (opts?: Record<string, unknown>) => {
  validateSchema(schema: unknown): boolean;
  errors: unknown;
};

export interface AppOptions {
  dbPath: string;
  clock: Clock;
  defaultTtlMs: number;
  webRoot?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** HTTP 适配层：只做参数校验与协议转换，领域语义全部在 core/store。 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const store = new Store({ path: opts.dbPath, clock: opts.clock, defaultTtlMs: opts.defaultTtlMs });
  app.addHook('onClose', async () => store.close());

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const assertValidSchema = (schema: unknown, label: string): void => {
    if (!isObj(schema) && typeof schema !== 'boolean') {
      throw new StoreError('BAD_REQUEST', 400, `${label} 必须是 JSON Schema 对象`);
    }
    const ok = ajv.validateSchema(schema as object);
    if (!ok) {
      throw new StoreError('INVALID_SCHEMA', 422, `${label} 不是合法的 JSON Schema 2020-12`, {
        errors: ajv.errors,
      });
    }
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof StoreError) {
      void reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    void reply.status(500).send({ error: { code: 'INTERNAL', message: err.message } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/proposals', async (req, reply) => {
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    assertValidSchema(body.baseline, 'baseline');
    assertValidSchema(body.candidate, 'candidate');
    const detail = store.createProposal({
      title: String(body.title ?? ''),
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
      baseline: body.baseline,
      candidate: body.candidate,
      consumers: Array.isArray(body.consumers) ? body.consumers.map(String) : [],
      evidenceTtlMs: typeof body.evidenceTtlMs === 'number' ? body.evidenceTtlMs : undefined,
      environment: typeof body.environment === 'string' ? body.environment : undefined,
    });
    return reply.status(201).send(detail);
  });

  app.get('/api/proposals', async () => ({ proposals: store.listProposals() }));

  app.get('/api/proposals/:id', async (req) => {
    const { id } = req.params as { id: string };
    const detail = store.getProposal(id);
    if (!detail) throw new StoreError('NOT_FOUND', 404, `提案 ${id} 不存在`);
    return detail;
  });

  app.post('/api/proposals/:id/revisions', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    assertValidSchema(body.candidate, 'candidate');
    if (typeof body.expectedVersion !== 'number') {
      throw new StoreError('BAD_REQUEST', 400, 'expectedVersion 必须是数字');
    }
    return store.addRevision(id, body.candidate, body.expectedVersion);
  });

  app.post('/api/proposals/:id/evidence', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    for (const f of ['consumerId', 'candidateDigest', 'verdict', 'runId', 'idempotencyKey'] as const) {
      if (typeof body[f] !== 'string' || body[f] === '') {
        throw new StoreError('BAD_REQUEST', 400, `${f} 必须是非空字符串`);
      }
    }
    const input: EvidenceInput = {
      consumerId: body.consumerId as string,
      candidateDigest: body.candidateDigest as string,
      verdict: body.verdict as EvidenceInput['verdict'],
      runId: body.runId as string,
      idempotencyKey: body.idempotencyKey as string,
      details: body.details,
    };
    return store.recordEvidence(id, input);
  });

  app.post('/api/proposals/:id/decisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    if (body.action !== 'approve' && body.action !== 'reject') {
      throw new StoreError('BAD_REQUEST', 400, 'action 必须是 approve 或 reject');
    }
    if (typeof body.expectedVersion !== 'number') {
      throw new StoreError('BAD_REQUEST', 400, 'expectedVersion 必须是数字');
    }
    const decision = store.decide(id, {
      action: body.action as DecisionAction,
      decidedBy: String(body.decidedBy ?? ''),
      expectedVersion: body.expectedVersion,
      rationale: typeof body.rationale === 'string' ? body.rationale : undefined,
      acknowledgeBreaking: body.acknowledgeBreaking === true,
    });
    return reply.status(201).send({ decision });
  });

  /** 从当前提案派生后继提案（谱系）：新候选新摘要，原提案开放则替代关闭。 */
  app.post('/api/proposals/:id/successors', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    assertValidSchema(body.candidate, 'candidate');
    const successor = store.createSuccessor(id, {
      candidate: body.candidate,
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      consumers: Array.isArray(body.consumers) ? body.consumers.map(String) : undefined,
      environment: typeof body.environment === 'string' ? body.environment : undefined,
      evidenceTtlMs: typeof body.evidenceTtlMs === 'number' ? body.evidenceTtlMs : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    return reply.status(201).send(successor);
  });

  /** 申请限时豁免：仅覆盖当前候选摘要 + 指定消费方/环境/兼容方向。 */
  app.post('/api/proposals/:id/exemptions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    if (typeof body.consumerId !== 'string' || !body.consumerId) {
      throw new StoreError('BAD_REQUEST', 400, 'consumerId 必须是非空字符串');
    }
    if (typeof body.ttlMs !== 'number') {
      throw new StoreError('BAD_REQUEST', 400, 'ttlMs 必须是数字（豁免必须限时）');
    }
    const view = store.requestExemption(id, {
      consumerId: body.consumerId,
      direction: body.direction as 'backward' | 'forward',
      reason: String(body.reason ?? ''),
      requestedBy: String(body.requestedBy ?? ''),
      ttlMs: body.ttlMs,
      environment: typeof body.environment === 'string' ? body.environment : undefined,
    });
    return reply.status(201).send(view);
  });

  const exemptionAction = (
    handler: (id: string, by: string, reason?: string) => unknown,
  ) => async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (!isObj(body)) throw new StoreError('BAD_REQUEST', 400, '请求体必须是 JSON 对象');
    return handler(id, String(body.by ?? ''), typeof body.reason === 'string' ? body.reason : undefined);
  };

  app.post('/api/exemptions/:id/confirm', exemptionAction((id, by) => store.confirmExemption(id, by)));
  app.post('/api/exemptions/:id/reject', exemptionAction((id, by, reason) => store.rejectExemption(id, by, reason)));
  app.post('/api/exemptions/:id/revoke', exemptionAction((id, by, reason) => store.revokeExemption(id, by, reason)));

  /** 一致快照：网页重连后以此为准，而不是依赖进程内事件。 */
  app.get('/api/snapshot', async () => store.snapshot());

  /** SSE：先从 SQLite 重放 since 之后的事件（重启/重连不丢），再推送实时事件。 */
  app.get('/api/events', (req, reply) => {
    const q = req.query as { since?: string };
    const lastEventId = req.headers['last-event-id'];
    const since = Number(q.since ?? lastEventId ?? 0) || 0;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: DomainEvent): void => {
      reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of store.eventsSince(since)) send(e);
    const off = store.onEvent(send);
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      off();
    });
  });

  // 手动时钟端点：仅在 CONTRACT_CLOCK=manual 时暴露，用于无真实等待的时序复现。
  if (opts.clock instanceof ManualClock) {
    const clock = opts.clock;
    app.get('/api/clock', async () => ({ now: clock.now(), mode: 'manual' }));
    app.post('/api/clock/advance', async (req) => {
      const body = req.body;
      if (!isObj(body) || typeof body.ms !== 'number') {
        throw new StoreError('BAD_REQUEST', 400, 'body.ms 必须是数字');
      }
      return { now: clock.advance(body.ms), mode: 'manual' };
    });
  }

  if (opts.webRoot && existsSync(path.join(opts.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(opts.webRoot) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        void reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  }

  return app;
}
