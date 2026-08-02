import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { ControlCenterService, ServiceError } from '../../app/control-center-service.js';
import { candidateDigest } from '../../domain/digest.js';
import { analyzeCompatibility } from '../../domain/compatibility.js';
import { ArmableFaults, InjectedCrash, type FaultPoint } from '../../ports/faults.js';
import { LogicalClock } from '../../domain/clock.js';

/**
 * Fastify HTTP adapter.
 *
 * Thin translation layer: parse/validate the request, call the application
 * service, map the result to a status code. No domain logic lives here. When
 * the server is created in "controllable" mode (a LogicalClock + ArmableFaults)
 * it also exposes test-only control routes so the e2e harness and simulator
 * can drive logical time and arm fault points without real waiting. Those
 * routes are absent in production wiring.
 */

export interface BuildServerOptions {
  service: ControlCenterService;
  /** Present only when time is controllable (tests/e2e). */
  logicalClock?: LogicalClock;
  /** Present only when faults are armable (tests/e2e). */
  faults?: ArmableFaults;
  /** Serve the built web workbench from this dir if it exists. */
  webDir?: string;
  logger?: boolean;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const { service } = opts;

  // Injected crashes must surface as a clear 5xx so a client knows to retry.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InjectedCrash) {
      return reply.status(503).send({ error: 'injected_crash', point: err.point });
    }
    if (err instanceof ServiceError) {
      const code = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400;
      return reply.status(code).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // --- subjects ---
  app.post('/api/subjects', async (req, reply) => {
    const body = req.body as any;
    service.registerSubject({
      subjectId: String(body.subjectId),
      requiredConsumers: Array.isArray(body.requiredConsumers) ? body.requiredConsumers.map(String) : [],
      freshnessWindowMs: Number(body.freshnessWindowMs)
    });
    return reply.status(201).send({ ok: true });
  });

  // --- stateless helpers: digest + compatibility preview ---
  app.post('/api/analyze', async (req) => {
    const body = req.body as any;
    const compat = analyzeCompatibility(body.baselineSchema ?? {}, body.candidateSchema ?? {});
    return {
      candidateDigest: candidateDigest(body.candidateSchema ?? {}),
      compat
    };
  });

  // --- candidate submission ---
  app.post('/api/subjects/:subjectId/candidates', async (req, reply) => {
    const { subjectId } = req.params as { subjectId: string };
    const body = req.body as any;
    const result = service.submitCandidate({
      subjectId,
      baselineSchema: body.baselineSchema ?? {},
      candidateSchema: body.candidateSchema ?? {},
      submittedBy: String(body.submittedBy ?? 'unknown'),
      expectedPredecessorId: body.expectedPredecessorId ? String(body.expectedPredecessorId) : undefined
    });
    return reply.status(result.deduplicated ? 200 : 201).send({
      proposalId: result.proposal.proposalId,
      candidateDigest: result.proposal.candidateDigest,
      state: result.proposal.state,
      compat: result.proposal.compat,
      deduplicated: result.deduplicated,
      predecessorId: result.predecessorId
    });
  });

  // --- evidence ingestion ---
  app.post('/api/evidence', async (req, reply) => {
    const body = req.body as any;
    const outcome = service.reportEvidence({
      reportId: String(body.reportId),
      subjectId: String(body.subjectId),
      targetDigest: String(body.targetDigest),
      consumerId: String(body.consumerId),
      verdict: body.verdict === 'FAIL' ? 'FAIL' : 'PASS',
      producedAt: Number(body.producedAt),
      detail: body.detail ? String(body.detail) : undefined
    });
    const code = outcome.status === 'APPLIED' ? 201 : 200;
    return reply.status(code).send(outcome);
  });

  // --- decisions ---
  app.post('/api/proposals/:proposalId/decision', async (req, reply) => {
    const { proposalId } = req.params as { proposalId: string };
    const body = req.body as any;
    const outcome = service.decide({
      proposalId,
      expectedDigest: String(body.expectedDigest),
      expectedFingerprint: body.expectedFingerprint ? String(body.expectedFingerprint) : undefined,
      environment: body.environment ? String(body.environment) : undefined,
      type: body.type === 'REJECT' ? 'REJECT' : 'APPROVE',
      decidedBy: String(body.decidedBy ?? 'unknown'),
      note: body.note ? String(body.note) : undefined
    });
    const code =
      outcome.status === 'DECIDED' ? 201 : outcome.status === 'CONFLICT' ? 409 : 422;
    return reply.status(code).send(outcome);
  });

  // --- waivers ---
  app.post('/api/waivers', async (req, reply) => {
    const body = req.body as any;
    const outcome = service.requestWaiver({
      subjectId: String(body.subjectId),
      candidateDigest: String(body.candidateDigest),
      consumerId: String(body.consumerId),
      environment: body.environment ? String(body.environment) : undefined,
      compatDirection: body.compatDirection,
      reason: String(body.reason ?? ''),
      requestedBy: String(body.requestedBy ?? 'unknown'),
      ttlMs: Number(body.ttlMs)
    });
    return reply.status(outcome.status === 'REQUESTED' ? 201 : 422).send(outcome);
  });

  app.post('/api/waivers/:waiverId/confirm', async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = req.body as any;
    const outcome = service.confirmWaiver(waiverId, String(body.confirmedBy ?? 'unknown'));
    return reply.status(outcome.status === 'CONFIRMED' ? 201 : 422).send(outcome);
  });

  app.post('/api/waivers/:waiverId/reject', async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = req.body as any;
    const outcome = service.rejectWaiver(waiverId, String(body.rejectedBy ?? 'unknown'), String(body.reason ?? ''));
    return reply.status(outcome.status === 'REJECTED' ? 201 : 422).send(outcome);
  });

  app.post('/api/waivers/:waiverId/revoke', async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const body = req.body as any;
    const outcome = service.revokeWaiver(waiverId, String(body.revokedBy ?? 'unknown'), String(body.reason ?? ''));
    return reply.status(outcome.status === 'REVOKED' ? 201 : 422).send(outcome);
  });

  app.get('/api/waivers/:waiverId', async (req, reply) => {
    const { waiverId } = req.params as { waiverId: string };
    const waiver = service.getWaiver(waiverId);
    if (!waiver) return reply.status(404).send({ error: 'NOT_FOUND' });
    return waiver;
  });

  // --- staged rollouts ---
  app.post('/api/rollouts', async (req, reply) => {
    const body = req.body as any;
    const outcome = service.createRollout({
      decisionId: String(body.decisionId),
      waves: Array.isArray(body.waves) ? body.waves.map(String) : [],
      createdBy: String(body.createdBy ?? 'unknown'),
      note: body.note ? String(body.note) : undefined
    });
    return reply.status(outcome.status === 'CREATED' ? 201 : 422).send(outcome);
  });

  app.post('/api/rollouts/:rolloutId/start-wave', async (req, reply) => {
    const { rolloutId } = req.params as { rolloutId: string };
    const outcome = service.startNextWave(rolloutId);
    return reply.status(outcome.status === 'STARTED' ? 201 : 422).send(outcome);
  });

  app.post('/api/rollouts/:rolloutId/pause', async (req, reply) => {
    const { rolloutId } = req.params as { rolloutId: string };
    const outcome = service.pauseRollout(rolloutId);
    return reply.status(outcome.status === 'PAUSED' ? 200 : 422).send(outcome);
  });

  app.post('/api/rollouts/:rolloutId/resume', async (req, reply) => {
    const { rolloutId } = req.params as { rolloutId: string };
    const outcome = service.resumeRollout(rolloutId);
    return reply.status(outcome.status === 'RESUMED' ? 200 : 422).send(outcome);
  });

  app.post('/api/rollouts/:rolloutId/waves/:waveId/retry', async (req, reply) => {
    const { rolloutId, waveId } = req.params as { rolloutId: string; waveId: string };
    const outcome = service.retryWave(rolloutId, waveId);
    return reply.status(outcome.status === 'RETRIED' ? 201 : 422).send(outcome);
  });

  app.post('/api/rollbacks', async (req, reply) => {
    const body = req.body as any;
    const outcome = service.rollback({
      subjectId: String(body.subjectId),
      environment: body.environment ? String(body.environment) : undefined,
      targetDigest: String(body.targetDigest),
      waves: Array.isArray(body.waves) ? body.waves.map(String) : [],
      createdBy: String(body.createdBy ?? 'unknown'),
      note: body.note ? String(body.note) : undefined
    });
    return reply.status(outcome.status === 'CREATED' ? 201 : 422).send(outcome);
  });

  // --- deployment adapter receipts ---
  app.post('/api/receipts', async (req, reply) => {
    const body = req.body as any;
    const result = body.result === 'FAILURE' ? 'FAILURE' : body.result === 'UNKNOWN' ? 'UNKNOWN' : 'SUCCESS';
    const outcome = service.reportReceipt({
      receiptId: String(body.receiptId),
      rolloutId: String(body.rolloutId),
      waveId: String(body.waveId),
      attempt: Number(body.attempt),
      result,
      evidenceFingerprint: String(body.evidenceFingerprint),
      detail: body.detail ? String(body.detail) : undefined
    });
    const code =
      outcome.status === 'ADVANCED' ? 201 : outcome.status === 'DENIED' ? 422 : 200;
    return reply.status(code).send(outcome);
  });

  app.get('/api/rollouts/:rolloutId', async (req, reply) => {
    const { rolloutId } = req.params as { rolloutId: string };
    const detail = service.getRolloutDetail(rolloutId);
    if (!detail) return reply.status(404).send({ error: 'NOT_FOUND' });
    return detail;
  });

  app.get('/api/subjects/:subjectId/rollouts', async (req) => {
    const { subjectId } = req.params as { subjectId: string };
    return { rollouts: service.listRollouts(subjectId) };
  });

  // --- read models ---
  app.get('/api/proposals/:proposalId', async (req, reply) => {
    const { proposalId } = req.params as { proposalId: string };
    const q = req.query as { environment?: string };
    const view = service.getProposalView(proposalId, q.environment);
    if (!view) return reply.status(404).send({ error: 'NOT_FOUND' });
    return view;
  });

  app.get('/api/snapshot', async (req) => {
    const q = req.query as { environment?: string };
    return service.snapshot(q.environment);
  });

  app.get('/api/events', async (req) => {
    const q = req.query as { since?: string };
    const since = q.since ? Number(q.since) : 0;
    return { events: service.listEvents(since) };
  });

  // --- test-only control plane (present only when controllable) ---
  if (opts.logicalClock || opts.faults) {
    registerControlRoutes(app, opts.logicalClock, opts.faults);
  }

  // --- static web workbench ---
  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for non-API routes.
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'NOT_FOUND' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function registerControlRoutes(app: FastifyInstance, clock?: LogicalClock, faults?: ArmableFaults): void {
  // Advancing/setting logical time lets scenarios expire freshness windows and
  // order events precisely, with no dependence on wall-clock timing.
  app.get('/api/control/clock', async () => ({ now: clock?.now() ?? null }));

  app.post('/api/control/clock/advance', async (req, reply) => {
    if (!clock) return reply.status(400).send({ error: 'clock not controllable' });
    const body = req.body as any;
    const now = clock.advance(Number(body.deltaMs ?? 0));
    return { now };
  });

  app.post('/api/control/clock/set', async (req, reply) => {
    if (!clock) return reply.status(400).send({ error: 'clock not controllable' });
    const body = req.body as any;
    clock.set(Number(body.ms));
    return { now: clock.now() };
  });

  app.post('/api/control/faults/arm', async (req, reply) => {
    if (!faults) return reply.status(400).send({ error: 'faults not armable' });
    const body = req.body as any;
    faults.arm(body.point as FaultPoint, Number(body.times ?? 1));
    return { armed: body.point, times: Number(body.times ?? 1) };
  });

  app.post('/api/control/faults/disarm', async (req, reply) => {
    if (!faults) return reply.status(400).send({ error: 'faults not armable' });
    const body = req.body as any;
    faults.disarm(body.point as FaultPoint);
    return { disarmed: body.point };
  });
}

export function defaultWebDir(): string {
  // Compiled location is dist/src/adapters/http/server.js; the built web
  // assets live at the project root under web/dist.
  return fileURLToPath(new URL('../../../../web/dist', import.meta.url));
}
