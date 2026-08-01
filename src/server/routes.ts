import type { FastifyInstance } from 'fastify';
import type { GateService } from '../service/gate-service.js';
import type { EventHub } from './event-hub.js';
import { DomainError } from '../core/errors.js';
import type { EvidenceInput } from '../storage/repository.js';
import type { DecisionKind } from '../core/types.js';

interface RouteDeps {
  service: GateService;
  hub: EventHub;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { service, hub } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      reply.status(err.httpStatus).send({
        error: err.code,
        message: err.message,
        blockers: (err as unknown as { blockers?: unknown }).blockers,
      });
      return;
    }
    app.log.error(err);
    reply.status(500).send({ error: 'INTERNAL', message: err.message });
  });

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  app.get('/api/proposals', async () => ({ proposals: service.listProposals() }));

  app.post<{ Body: Record<string, unknown> }>('/api/proposals', async (req, reply) => {
    const body = req.body ?? {};
    const result = service.submitProposal({
      topic: String(body.topic ?? ''),
      baseline: body.baseline as Record<string, unknown>,
      candidate: body.candidate as Record<string, unknown>,
      consumers: body.consumers as { consumerId: string; schema: Record<string, unknown> }[],
      author: String(body.author ?? 'unknown'),
      ttlMs: Number(body.ttlMs ?? 60000),
    });
    reply.status(201).send(result.proposal);
  });

  app.get<{ Params: { id: string } }>('/api/proposals/:id', async (req) => {
    return service.getGateView(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/proposals/:id/evidence',
    async (req, reply) => {
      const body = req.body ?? {};
      const idempotencyKey = String(
        req.headers['idempotency-key'] ?? body.idempotencyKey ?? '',
      );
      if (!idempotencyKey) {
        reply.status(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'provide Idempotency-Key header' });
        return;
      }
      const input: EvidenceInput = {
        proposalId: req.params.id,
        candidateDigest: String(body.candidateDigest ?? ''),
        consumerId: String(body.consumerId ?? ''),
        status: body.status as EvidenceInput['status'],
        detail: String(body.detail ?? ''),
        reportedAt: Number(body.reportedAt ?? Date.now()),
        idempotencyKey,
        agentRunId: String(body.agentRunId ?? 'unknown'),
      };
      const result = service.reportEvidence(input);
      reply.status(result.accepted ? 202 : 409).send({
        accepted: result.accepted,
        deduped: result.deduped,
        reason: result.reason,
        proposal: result.proposal,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/proposals/:id/decision',
    async (req, reply) => {
      const body = req.body ?? {};
      const kind = String(body.kind ?? '') as DecisionKind;
      if (kind !== 'approve' && kind !== 'reject') {
        reply.status(400).send({ error: 'INVALID_KIND', message: 'kind must be approve or reject' });
        return;
      }
      const result = service.decide({
        proposalId: req.params.id,
        kind,
        decider: String(body.decider ?? 'release-manager'),
        rationale: String(body.rationale ?? ''),
        expectedStatus: body.expectedStatus as string | undefined,
      });
      reply.status(200).send(result.proposal);
    },
  );

  app.get<{ Querystring: { after?: string } }>('/api/events', (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const after = Number(req.query.after ?? 0);
    const replay = service.repo.events.readAfter(after);
    for (const ev of replay) {
      writeSse(reply.raw, ev.eventId, ev.eventType, ev);
    }

    const unsub = hub.subscribe((ev) => {
      writeSse(reply.raw, ev.eventId, ev.eventType, ev);
    });

    const keepAlive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsub();
    });
  });
}

function writeSse(
  raw: import('node:http').ServerResponse,
  id: number,
  event: string,
  data: unknown,
): void {
  raw.write(`id: ${id}\n`);
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
