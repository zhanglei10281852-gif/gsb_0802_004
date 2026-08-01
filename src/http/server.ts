import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { Repository } from '../storage/repository.js';
import { EventHub, type SSEMessage } from './event-hub.js';
import type {
  EvidenceSubmission,
  EvidenceVerdict,
  ExemptionDirection,
  ExemptionRequest,
} from '../domain/types.js';

export interface ServerOptions {
  repository: Repository;
  eventHub: EventHub;
  webRoot?: string;
  port?: number;
  host?: string;
  logger?: boolean;
  testMode?: boolean;
  onAdvanceClock?: (ms: number) => number;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const repo = opts.repository;
  const hub = opts.eventHub;

  app.get('/api/health', async () => ({ ok: true, time: Date.now(), testMode: !!opts.testMode }));

  app.get('/api/consumers', async () => ({ consumers: repo.listConsumers() }));

  app.post('/api/consumers', async (req: FastifyRequest<{ Body: { id?: string; name?: string } }>, reply: FastifyReply) => {
    const { id, name } = req.body ?? {};
    if (!id || !name) {
      return reply.code(400).send({ error: 'id and name are required' });
    }
    const consumer = repo.registerConsumer(id, name);
    return reply.code(201).send({ consumer });
  });

  app.get('/api/proposals', async () => ({ proposals: repo.listProposals() }));

  app.post(
    '/api/proposals',
    async (
      req: FastifyRequest<{ Body: { candidateSchema?: unknown; baselineSchema?: unknown; environment?: string } }>,
      reply: FastifyReply,
    ) => {
      const { candidateSchema, baselineSchema, environment } = req.body ?? {};
      if (!candidateSchema || !baselineSchema || typeof candidateSchema !== 'object' || typeof baselineSchema !== 'object') {
        return reply.code(400).send({ error: 'candidateSchema and baselineSchema objects are required' });
      }
      const result = repo.createProposal(
        candidateSchema as Record<string, unknown>,
        baselineSchema as Record<string, unknown>,
        environment ?? 'production',
      );
      return reply.code(result.duplicate ? 200 : 201).send(result);
    },
  );

  app.get('/api/proposals/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const detail = repo.getProposalDetail(req.params.id);
    if (!detail) return reply.code(404).send({ error: 'proposal not found' });
    return detail;
  });

  app.post(
    '/api/proposals/:id/evidence',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: {
          consumerId?: string;
          candidateHash?: string;
          verdict?: string;
          details?: string;
          idempotencyKey?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const b = req.body ?? {};
      if (!b.consumerId || !b.candidateHash || !b.verdict || !b.idempotencyKey) {
        return reply.code(400).send({ error: 'consumerId, candidateHash, verdict and idempotencyKey are required' });
      }
      const submission: EvidenceSubmission = {
        proposalId: req.params.id,
        consumerId: b.consumerId,
        candidateHash: b.candidateHash,
        verdict: b.verdict as EvidenceVerdict,
        details: b.details ?? '',
        idempotencyKey: b.idempotencyKey,
      };
      const result = repo.submitEvidence(submission);
      return reply.code(result.accepted ? 200 : 409).send(result);
    },
  );

  app.post(
    '/api/proposals/:id/decision',
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { action?: string; reason?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { action, reason } = req.body ?? {};
      if (action !== 'approve' && action !== 'reject') {
        return reply.code(400).send({ error: 'action must be "approve" or "reject"' });
      }
      const result = repo.decide(req.params.id, action, reason ?? '');
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.code(200).send({ decision: result.decision });
    },
  );

  app.get('/api/exemptions', async (req: FastifyRequest<{ Querystring: { candidateHash?: string } }>) => {
    repo.sweepExpiredExemptions();
    return { exemptions: repo.listExemptions(req.query.candidateHash) };
  });

  app.post(
    '/api/exemptions',
    async (
      req: FastifyRequest<{
        Body: {
          candidateHash?: string;
          consumerId?: string;
          environment?: string;
          direction?: string;
          reason?: string;
          requesterId?: string;
          validFrom?: number;
          validUntil?: number;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const b = req.body ?? {};
      if (
        !b.candidateHash ||
        !b.consumerId ||
        !b.environment ||
        !b.direction ||
        !b.requesterId ||
        b.validFrom === undefined ||
        b.validUntil === undefined
      ) {
        return reply.code(400).send({
          error: 'candidateHash, consumerId, environment, direction, requesterId, validFrom and validUntil are required',
        });
      }
      if (b.direction !== 'compatible' && b.direction !== 'incompatible') {
        return reply.code(400).send({ error: 'direction must be "compatible" or "incompatible"' });
      }
      const request: ExemptionRequest = {
        candidateHash: b.candidateHash,
        consumerId: b.consumerId,
        environment: b.environment,
        direction: b.direction as ExemptionDirection,
        reason: b.reason ?? '',
        requesterId: b.requesterId,
        validFrom: Number(b.validFrom),
        validUntil: Number(b.validUntil),
      };
      const result = repo.requestExemption(request);
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.code(201).send({ exemption: result.exemption });
    },
  );

  app.post(
    '/api/exemptions/:id/confirm',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { confirmerId?: string } }>,
      reply: FastifyReply,
    ) => {
      const { confirmerId } = req.body ?? {};
      if (!confirmerId) return reply.code(400).send({ error: 'confirmerId is required' });
      const result = repo.confirmExemption(req.params.id, confirmerId);
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.code(200).send({ exemption: result.exemption });
    },
  );

  app.post(
    '/api/exemptions/:id/reject',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { reviewerId?: string; note?: string } }>,
      reply: FastifyReply,
    ) => {
      const { reviewerId, note } = req.body ?? {};
      if (!reviewerId) return reply.code(400).send({ error: 'reviewerId is required' });
      const result = repo.closeExemption(req.params.id, reviewerId, 'reject', note ?? '');
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.code(200).send({ exemption: result.exemption });
    },
  );

  app.post(
    '/api/exemptions/:id/revoke',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { reviewerId?: string; note?: string } }>,
      reply: FastifyReply,
    ) => {
      const { reviewerId, note } = req.body ?? {};
      if (!reviewerId) return reply.code(400).send({ error: 'reviewerId is required' });
      const result = repo.closeExemption(req.params.id, reviewerId, 'revoke', note ?? '');
      if (!result.ok) return reply.code(409).send({ error: result.reason });
      return reply.code(200).send({ exemption: result.exemption });
    },
  );

  app.get('/api/causal-events', async () => ({ events: repo.listEvents() }));

  app.get('/api/snapshot', async () => {
    repo.sweepExpiredExemptions();
    const proposals = repo.listProposals().map((p) => repo.getProposalDetail(p.id)!);
    return {
      consumers: repo.listConsumers(),
      exemptions: repo.listExemptions(),
      proposals,
      events: repo.listEvents(),
    };
  });

  app.get('/api/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (message: SSEMessage) => {
      raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    repo.sweepExpiredExemptions();
    const snapshot = {
      consumers: repo.listConsumers(),
      exemptions: repo.listExemptions(),
      proposals: repo.listProposals().map((p) => repo.getProposalDetail(p.id)!),
    };
    send({ type: 'snapshot', data: snapshot });

    const unsubscribe = hub.subscribe((event) => {
      if (event.type === 'event') {
        send({ type: 'event', event: event.event });
      }
    });

    const ping = setInterval(() => {
      raw.write(`: ping ${Date.now()}\n\n`);
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      raw.end();
    });

    return reply;
  });

  if (opts.testMode && opts.onAdvanceClock) {
    app.post(
      '/api/test/clock/advance',
      async (req: FastifyRequest<{ Body: { ms?: number } }>, reply: FastifyReply) => {
        const ms = Number(req.body?.ms ?? 0);
        if (!Number.isFinite(ms) || ms < 0) {
          return reply.code(400).send({ error: 'ms must be a non-negative number' });
        }
        const now = opts.onAdvanceClock!(ms);
        return reply.code(200).send({ now, advanced: ms });
      },
    );
  }

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, {
      root: opts.webRoot,
      prefix: '/',
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
