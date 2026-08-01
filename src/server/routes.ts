import type { FastifyInstance } from "fastify";
import type { GateService } from "../service/gate-service.js";
import type { EventHub } from "./event-hub.js";
import { DomainError } from "../core/errors.js";
import type { EvidenceInput } from "../storage/repository.js";
import type { DecisionKind } from "../core/types.js";

interface RouteDeps {
  service: GateService;
  hub: EventHub;
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
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
    reply.status(500).send({ error: "INTERNAL", message: err.message });
  });

  app.get("/api/health", async () => ({ ok: true, time: Date.now() }));

  app.get("/api/proposals", async () => ({
    proposals: service.listProposals(),
  }));

  app.post<{ Body: Record<string, unknown> }>(
    "/api/proposals",
    async (req, reply) => {
      const body = req.body ?? {};
      const result = service.submitProposal({
        topic: String(body.topic ?? ""),
        baseline: body.baseline as Record<string, unknown>,
        candidate: body.candidate as Record<string, unknown>,
        consumers: body.consumers as {
          consumerId: string;
          schema: Record<string, unknown>;
        }[],
        author: String(body.author ?? "unknown"),
        ttlMs: Number(body.ttlMs ?? 60000),
      });
      reply.status(201).send(result.proposal);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { environment?: string } }>(
    "/api/proposals/:id",
    async (req) => {
      return service.getGateView(req.params.id, req.query.environment);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/proposals/:id/successor",
    async (req, reply) => {
      const body = req.body ?? {};
      const candidate = body.candidate;
      if (!candidate || typeof candidate !== "object") {
        reply.status(400).send({
          error: "INVALID_CANDIDATE",
          message: "a candidate JSON Schema object is required",
        });
        return;
      }
      const { predecessor, successor } = service.createSuccessor(
        req.params.id,
        {
          candidate: candidate as Record<string, unknown>,
          author: String(body.author ?? "unknown"),
          ttlMs: body.ttlMs ? Number(body.ttlMs) : undefined,
          note: body.note ? String(body.note) : undefined,
        },
      );
      reply.status(201).send({ predecessor, successor });
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/proposals/:id/required-consumers",
    async (req, reply) => {
      const body = req.body ?? {};
      const consumerId = String(body.consumerId ?? "");
      if (!consumerId) {
        reply.status(400).send({
          error: "INVALID_CONSUMER",
          message: "consumerId is required",
        });
        return;
      }
      const result = service.addRequiredConsumer({
        proposalId: req.params.id,
        consumerId,
        addedBy: String(body.addedBy ?? "operator"),
        reason: String(body.reason ?? "new required dependency"),
        schema:
          body.schema && typeof body.schema === "object"
            ? (body.schema as Record<string, unknown>)
            : { type: "object" },
      });
      reply.status(201).send(result);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/proposals/:id/evidence",
    async (req, reply) => {
      const body = req.body ?? {};
      const idempotencyKey = String(
        req.headers["idempotency-key"] ?? body.idempotencyKey ?? "",
      );
      if (!idempotencyKey) {
        reply.status(400).send({
          error: "IDEMPOTENCY_KEY_REQUIRED",
          message: "provide Idempotency-Key header",
        });
        return;
      }
      const input: EvidenceInput = {
        proposalId: req.params.id,
        candidateDigest: String(body.candidateDigest ?? ""),
        consumerId: String(body.consumerId ?? ""),
        status: body.status as EvidenceInput["status"],
        detail: String(body.detail ?? ""),
        reportedAt: Number(body.reportedAt ?? Date.now()),
        idempotencyKey,
        agentRunId: String(body.agentRunId ?? "unknown"),
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
    "/api/proposals/:id/decision",
    async (req, reply) => {
      const body = req.body ?? {};
      const kind = String(body.kind ?? "") as DecisionKind;
      if (kind !== "approve" && kind !== "reject") {
        reply.status(400).send({
          error: "INVALID_KIND",
          message: "kind must be approve or reject",
        });
        return;
      }
      const result = service.decide({
        proposalId: req.params.id,
        kind,
        decider: String(body.decider ?? "release-manager"),
        rationale: String(body.rationale ?? ""),
        expectedStatus: body.expectedStatus as string | undefined,
        environment: body.environment ? String(body.environment) : undefined,
      });
      reply.status(200).send(result.proposal);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/proposals/:id/exemptions",
    async (req, reply) => {
      const body = req.body ?? {};
      const ttlMs = Number(body.ttlMs ?? 3600000);
      const record = service.requestExemption({
        proposalId: req.params.id,
        consumerId: String(body.consumerId ?? ""),
        environment: String(body.environment ?? "prod"),
        direction: String(body.direction ?? "backward") as
          | "backward"
          | "forward"
          | "both",
        reason: String(body.reason ?? ""),
        requestedBy: String(body.requestedBy ?? "unknown"),
        ttlMs,
      });
      reply.status(201).send(record);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/proposals/:id/exemptions",
    async (req) => {
      return { exemptions: service.listExemptions(req.params.id) };
    },
  );

  app.post<{
    Params: { id: string; exemptionId: string };
    Body: Record<string, unknown>;
  }>(
    "/api/proposals/:id/exemptions/:exemptionId/review",
    async (req, reply) => {
      const body = req.body ?? {};
      const approved = Boolean(body.approved);
      const record = service.reviewExemption({
        exemptionId: req.params.exemptionId,
        reviewer: String(body.reviewer ?? "unknown"),
        approved,
        comment: String(body.comment ?? ""),
      });
      reply.status(200).send(record);
    },
  );

  app.post<{
    Params: { id: string; exemptionId: string };
    Body: Record<string, unknown>;
  }>(
    "/api/proposals/:id/exemptions/:exemptionId/revoke",
    async (req, reply) => {
      const body = req.body ?? {};
      const record = service.revokeExemption(
        req.params.exemptionId,
        String(body.revokedBy ?? "unknown"),
      );
      reply.status(200).send(record);
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/proposals/:id/rollouts",
    async (req, reply) => {
      const body = req.body ?? {};
      const waves = Array.isArray(body.waves) ? body.waves : [];
      const { rollout, proposal } = service.createRollout({
        proposalId: req.params.id,
        owner: String(body.owner ?? "release-manager"),
        waves: waves as { environment: string; adapter: string }[],
        previousVersion: body.previousVersion
          ? String(body.previousVersion)
          : undefined,
        note: body.note ? String(body.note) : undefined,
        autoStart: body.autoStart === false ? false : true,
      });
      reply.status(201).send({ rollout, proposal });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/proposals/:id/rollouts",
    async (req) => {
      return { rollouts: service.listRolloutsForProposal(req.params.id) };
    },
  );

  app.get<{ Params: { rolloutId: string } }>(
    "/api/rollouts/:rolloutId",
    async (req) => {
      return service.getRollout(req.params.rolloutId);
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: Record<string, unknown> }>(
    "/api/rollouts/:rolloutId/start",
    async (req) => {
      return service.startRollout(req.params.rolloutId);
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: Record<string, unknown> }>(
    "/api/rollouts/:rolloutId/pause",
    async (req, reply) => {
      const body = req.body ?? {};
      reply
        .status(200)
        .send(
          service.pauseRollout(
            req.params.rolloutId,
            String(body.pausedBy ?? "operator"),
          ),
        );
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: Record<string, unknown> }>(
    "/api/rollouts/:rolloutId/resume",
    async (req, reply) => {
      const body = req.body ?? {};
      reply
        .status(200)
        .send(
          service.resumeRollout(
            req.params.rolloutId,
            String(body.resumedBy ?? "operator"),
          ),
        );
    },
  );

  app.post<{
    Params: { rolloutId: string; waveSequence: string };
    Body: Record<string, unknown>;
  }>(
    "/api/rollouts/:rolloutId/waves/:waveSequence/retry",
    async (req, reply) => {
      const body = req.body ?? {};
      reply
        .status(200)
        .send(
          service.retryRolloutWave(
            req.params.rolloutId,
            Number(req.params.waveSequence),
            String(body.retriedBy ?? "operator"),
          ),
        );
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: Record<string, unknown> }>(
    "/api/rollouts/:rolloutId/rollback",
    async (req, reply) => {
      const body = req.body ?? {};
      reply
        .status(200)
        .send(
          service.rollbackRollout(
            req.params.rolloutId,
            String(body.rolledBackBy ?? "operator"),
            String(body.note ?? "rollback to previous known good version"),
          ),
        );
    },
  );

  app.post<{ Params: { rolloutId: string }; Body: Record<string, unknown> }>(
    "/api/rollouts/:rolloutId/receipts",
    async (req, reply) => {
      const body = req.body ?? {};
      const idempotencyKey = String(
        req.headers["idempotency-key"] ?? body.idempotencyKey ?? "",
      );
      if (!idempotencyKey) {
        reply.status(400).send({
          error: "IDEMPOTENCY_KEY_REQUIRED",
          message: "provide Idempotency-Key header",
        });
        return;
      }
      const result = service.reportReceipt({
        rolloutId: req.params.rolloutId,
        waveSequence: Number(body.waveSequence ?? 0),
        result: body.result as "success" | "failure" | "unknown",
        message: String(body.message ?? ""),
        reportedAt: Number(body.reportedAt ?? Date.now()),
        idempotencyKey,
        adapterRunId: String(body.adapterRunId ?? "unknown"),
      });
      reply.status(result.accepted ? 202 : 409).send(result);
    },
  );

  app.get<{ Querystring: { after?: string } }>("/api/events", (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
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
      reply.raw.write(": keepalive\n\n");
    }, 15000);

    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsub();
    });
  });
}

function writeSse(
  raw: import("node:http").ServerResponse,
  id: number,
  event: string,
  data: unknown,
): void {
  raw.write(`id: ${id}\n`);
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
