import type { DB } from "./schema.js";
import { EventLog } from "./event-log.js";
import type { Clock } from "../core/clock.js";
import {
  ConflictError,
  GateBlockedError,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  ValidationError,
} from "../core/errors.js";
import { digest, digestString, shortDigest } from "../core/digest.js";
import { hashEvent } from "./event-log.js";
import type {
  CausalEvent,
  ConsumerId,
  ConsumerRef,
  DecisionKind,
  DecisionSnapshot,
  EvidenceRecord,
  EvidenceStatus,
  ProposalId,
  ProposalInput,
  StoredProposal,
  SuccessorInput,
} from "../core/types.js";
import { checkCompatibility } from "../core/compatibility.js";
import {
  DEFAULT_ENVIRONMENT,
  computeBlockers,
  evaluateGate,
  isReady,
  latestEvidencePerConsumer,
  summarizeEvidence,
} from "../core/gate.js";
import {
  appliedExemptionsDigest,
  toAppliedExemption,
} from "../core/exemption.js";
import type { ExemptionRecord } from "../core/types.js";
import type { ExemptionRepository } from "./exemption-repository.js";

function randomNonce(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export interface EvidenceInput {
  proposalId: ProposalId;
  candidateDigest: string;
  consumerId: ConsumerId;
  status: EvidenceStatus;
  detail: string;
  reportedAt: number;
  idempotencyKey: string;
  agentRunId: string;
}

export type EvidenceResult =
  | {
      accepted: true;
      evidence: EvidenceRecord;
      deduped: boolean;
      proposal: StoredProposal;
    }
  | { accepted: false; reason: string; existing?: EvidenceRecord };

export interface DecisionInput {
  proposalId: ProposalId;
  kind: DecisionKind;
  decider: string;
  rationale: string;
  expectedStatus?: string;
  environment?: string;
}

interface ProposalRow {
  proposal_id: string;
  topic: string;
  baseline_json: string;
  candidate_json: string;
  candidate_digest: string;
  baseline_digest: string;
  compatibility_json: string;
  consumers_json: string;
  author: string;
  status: string;
  created_at: number;
  ttl_ms: number;
  decided_at: number | null;
  decision_json: string | null;
  expected_version: number;
  predecessor_id: string | null;
  successor_id: string | null;
  superseded_at: number | null;
  superseded_by: string | null;
  lineage_note: string | null;
  additions_json: string;
}

interface EvidenceRow {
  evidence_id: string;
  proposal_id: string;
  candidate_digest: string;
  consumer_id: string;
  status: EvidenceStatus;
  detail: string;
  reported_at: number;
  received_at: number;
  idempotency_key: string;
  agent_run_id: string;
}

function rowToProposal(row: ProposalRow): StoredProposal {
  const decision = row.decision_json
    ? (JSON.parse(row.decision_json) as DecisionSnapshot)
    : null;
  const additions = JSON.parse(
    row.additions_json ?? "[]",
  ) as import("../core/types.js").RequiredConsumerAddition[];
  const requiredMap = new Map<string, ConsumerRef>();
  const baseConsumers = JSON.parse(row.consumers_json) as ConsumerRef[];
  for (const c of baseConsumers) requiredMap.set(c.consumerId, c);
  for (const a of additions) {
    if (!requiredMap.has(a.consumerId)) {
      requiredMap.set(a.consumerId, {
        consumerId: a.consumerId,
        schema: a.schema,
      });
    }
  }
  return {
    proposalId: row.proposal_id,
    topic: row.topic,
    baseline: JSON.parse(row.baseline_json),
    candidate: JSON.parse(row.candidate_json),
    candidateDigest: row.candidate_digest,
    baselineDigest: row.baseline_digest,
    compatibility: JSON.parse(row.compatibility_json),
    consumers: baseConsumers,
    requiredConsumers: [...requiredMap.values()],
    author: row.author,
    status: row.status as StoredProposal["status"],
    createdAt: row.created_at,
    ttlMs: row.ttl_ms,
    decidedAt: row.decided_at,
    decision,
    lineage: {
      predecessorId: row.predecessor_id,
      successorId: row.successor_id,
      supersededAt: row.superseded_at,
      supersededBy: row.superseded_by,
      note: row.lineage_note,
    },
    additions,
  };
}

function rowToEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    proposalId: row.proposal_id,
    candidateDigest: row.candidate_digest,
    consumerId: row.consumer_id,
    status: row.status,
    detail: row.detail,
    reportedAt: row.reported_at,
    receivedAt: row.received_at,
    idempotencyKey: row.idempotency_key,
    agentRunId: row.agent_run_id,
  };
}

export class ProposalRepository {
  readonly events: EventLog;
  private pending: CausalEvent[] = [];
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private exemptions: ExemptionRepository | null = null,
  ) {
    this.events = new EventLog(db);
  }

  drainEvents(): CausalEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private record(event: CausalEvent): void {
    this.pending.push(event);
  }

  private append(
    proposalId: string,
    occurredAt: number,
    eventType: CausalEvent["eventType"],
    payload: unknown,
  ): CausalEvent {
    const event = this.events.append(
      proposalId,
      occurredAt,
      eventType,
      payload,
    );
    this.record(event);
    return event;
  }

  setExemptionRepository(repo: ExemptionRepository): void {
    this.exemptions = repo;
  }

  private getExemptions(proposalId: string): ExemptionRecord[] {
    return this.exemptions?.listEffectiveForProposal(proposalId) ?? [];
  }

  create(input: ProposalInput): {
    proposal: StoredProposal;
    event: CausalEvent;
  } {
    if (!input.topic || typeof input.topic !== "string") {
      throw new ValidationError("topic is required");
    }
    if (!input.consumers || input.consumers.length === 0) {
      throw new ValidationError("at least one consumer is required");
    }
    for (const c of input.consumers) {
      if (!c.consumerId || typeof c.consumerId !== "string") {
        throw new ValidationError("each consumer needs a consumerId");
      }
      if (!c.schema || typeof c.schema !== "object") {
        throw new ValidationError(`consumer ${c.consumerId} has no schema`);
      }
    }
    if (!input.ttlMs || input.ttlMs <= 0) {
      throw new ValidationError("ttlMs must be positive");
    }

    const compatibility = checkCompatibility(
      input.baseline,
      input.candidate,
      this.clock,
    );
    const now = this.clock.now();
    const proposalId = `${input.topic}-${shortDigest(input.candidate)}-${shortDigest(
      {
        t: now,
        a: input.author,
        n: randomNonce(),
      },
    )}`;

    const tx = this.db.transaction(
      (): { proposal: StoredProposal; event: CausalEvent } => {
        this.db
          .prepare(
            `INSERT INTO proposals
            (proposal_id, topic, baseline_json, candidate_json, candidate_digest, baseline_digest,
             compatibility_json, consumers_json, author, status, created_at, ttl_ms, decided_at, decision_json, additions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, '[]')`,
          )
          .run(
            proposalId,
            input.topic,
            JSON.stringify(input.baseline),
            JSON.stringify(input.candidate),
            compatibility.candidateDigest,
            compatibility.baselineDigest,
            JSON.stringify(compatibility),
            JSON.stringify(input.consumers),
            input.author,
            now,
            input.ttlMs,
          );
        const event = this.append(proposalId, now, "proposal-created", {
          topic: input.topic,
          candidateDigest: compatibility.candidateDigest,
          baselineDigest: compatibility.baselineDigest,
          author: input.author,
        });
        return { proposal: this.getById(proposalId)!, event };
      },
    );
    return tx();
  }

  createSuccessor(
    predecessorId: ProposalId,
    input: SuccessorInput,
  ): {
    predecessor: StoredProposal;
    successor: StoredProposal;
    events: CausalEvent[];
  } {
    const predecessor = this.requireById(predecessorId);
    if (
      predecessor.status === "approved" ||
      predecessor.status === "rejected"
    ) {
      throw new ProposalAlreadyDecidedError(predecessorId);
    }
    if (predecessor.status === "superseded") {
      throw new ConflictError(
        `proposal ${predecessorId} is already superseded by ${predecessor.lineage.successorId}`,
      );
    }

    const compatibility = checkCompatibility(
      predecessor.baseline,
      input.candidate,
      this.clock,
    );
    const now = this.clock.now();
    const ttlMs = input.ttlMs ?? predecessor.ttlMs;
    const successorId = `${predecessor.topic}-${shortDigest(input.candidate)}-${shortDigest(
      { t: now, a: input.author, p: predecessorId, n: randomNonce() },
    )}`;

    const events: CausalEvent[] = [];
    const tx = this.db.transaction((): StoredProposal => {
      this.db
        .prepare(
          `INSERT INTO proposals
            (proposal_id, topic, baseline_json, candidate_json, candidate_digest, baseline_digest,
             compatibility_json, consumers_json, author, status, created_at, ttl_ms,
             decided_at, decision_json, predecessor_id, successor_id, superseded_at, superseded_by, lineage_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        )
        .run(
          successorId,
          predecessor.topic,
          JSON.stringify(predecessor.baseline),
          JSON.stringify(input.candidate),
          compatibility.candidateDigest,
          compatibility.baselineDigest,
          JSON.stringify(compatibility),
          JSON.stringify(predecessor.consumers),
          input.author,
          now,
          ttlMs,
          predecessorId,
          input.note ?? null,
        );

      const updated = this.db
        .prepare(
          `UPDATE proposals
             SET status = 'superseded', successor_id = ?, superseded_at = ?, superseded_by = ?
           WHERE proposal_id = ? AND status NOT IN ('approved','rejected','superseded')`,
        )
        .run(successorId, now, input.author, predecessorId);
      if (updated.changes === 0) {
        throw new ConflictError(
          "concurrent lineage change: predecessor was already decided or superseded",
        );
      }

      this.exemptions?.revokeAllForProposal(
        predecessorId,
        input.author,
        "proposal-superseded",
        now,
      );

      const createdEvent = this.append(successorId, now, "proposal-created", {
        topic: predecessor.topic,
        candidateDigest: compatibility.candidateDigest,
        baselineDigest: compatibility.baselineDigest,
        author: input.author,
      });
      events.push(createdEvent);

      const supersededEvent = this.append(
        predecessorId,
        now,
        "proposal-superseded",
        {
          predecessorId,
          successorId,
          candidateDigest: compatibility.candidateDigest,
          supersededBy: input.author,
          note: input.note ?? null,
        },
      );
      events.push(supersededEvent);

      return this.getById(successorId)!;
    });

    const successor = tx();
    return { predecessor: this.requireById(predecessorId), successor, events };
  }

  getById(proposalId: ProposalId): StoredProposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE proposal_id = ?")
      .get(proposalId) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  requireById(proposalId: ProposalId): StoredProposal {
    const p = this.getById(proposalId);
    if (!p) throw new ProposalNotFoundError(proposalId);
    return p;
  }

  list(): StoredProposal[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals ORDER BY created_at DESC")
      .all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  getEvidence(proposalId: ProposalId): EvidenceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM evidence WHERE proposal_id = ? ORDER BY received_at ASC, evidence_id ASC",
      )
      .all(proposalId) as EvidenceRow[];
    return rows.map(rowToEvidence);
  }

  ingestEvidence(input: EvidenceInput): EvidenceResult {
    const proposal = this.requireById(input.proposalId);
    const now = this.clock.now();

    if (proposal.status === "approved" || proposal.status === "rejected") {
      const addition = (proposal.additions ?? []).find(
        (a) => a.consumerId === input.consumerId && a.reverifiedAt === null,
      );
      if (
        proposal.status === "approved" &&
        addition &&
        input.candidateDigest === proposal.candidateDigest &&
        input.status === "pass"
      ) {
        return this.ingestReverification(proposal, addition, input, now);
      }
      this.append(input.proposalId, now, "evidence-rejected", {
        reason: "proposal-decided",
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
      });
      return { accepted: false, reason: "proposal-decided" };
    }

    if (proposal.status === "superseded") {
      this.append(input.proposalId, now, "evidence-rejected", {
        reason: "proposal-superseded",
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
        successorId: proposal.lineage.successorId,
      });
      return { accepted: false, reason: "proposal-superseded" };
    }

    if (input.candidateDigest !== proposal.candidateDigest) {
      this.append(input.proposalId, now, "evidence-rejected", {
        reason: "candidate-mismatch",
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
      });
      return { accepted: false, reason: "candidate-mismatch" };
    }

    const known = proposal.consumers.some(
      (c) => c.consumerId === input.consumerId,
    );
    if (!known) {
      this.append(input.proposalId, now, "evidence-rejected", {
        reason: "unknown-consumer",
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
      });
      return { accepted: false, reason: "unknown-consumer" };
    }

    if (!["pass", "fail", "error"].includes(input.status)) {
      return { accepted: false, reason: "invalid-payload" };
    }

    const existing = this.db
      .prepare(
        "SELECT * FROM evidence WHERE proposal_id = ? AND idempotency_key = ?",
      )
      .get(input.proposalId, input.idempotencyKey) as EvidenceRow | undefined;

    if (existing) {
      return {
        accepted: true,
        deduped: true,
        evidence: rowToEvidence(existing),
        proposal,
      };
    }

    const evidenceId = `ev_${digestString(
      `${input.proposalId}:${input.idempotencyKey}:${input.consumerId}`,
    ).slice(0, 24)}`;

    try {
      const row = this.db.transaction((): EvidenceRow => {
        this.db
          .prepare(
            `INSERT INTO evidence
              (evidence_id, proposal_id, candidate_digest, consumer_id, status, detail,
               reported_at, received_at, idempotency_key, agent_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidenceId,
            input.proposalId,
            input.candidateDigest,
            input.consumerId,
            input.status,
            input.detail,
            input.reportedAt,
            now,
            input.idempotencyKey,
            input.agentRunId,
          );
        this.append(input.proposalId, now, "evidence-accepted", {
          evidenceId,
          candidateDigest: input.candidateDigest,
          consumerId: input.consumerId,
          status: input.status,
          idempotencyKey: input.idempotencyKey,
        });
        return this.db
          .prepare("SELECT * FROM evidence WHERE evidence_id = ?")
          .get(evidenceId) as EvidenceRow;
      })();
      return {
        accepted: true,
        deduped: false,
        evidence: rowToEvidence(row),
        proposal,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE") && message.includes("idempotency_key")) {
        const row = this.db
          .prepare(
            "SELECT * FROM evidence WHERE proposal_id = ? AND idempotency_key = ?",
          )
          .get(input.proposalId, input.idempotencyKey) as EvidenceRow;
        return {
          accepted: true,
          deduped: true,
          evidence: rowToEvidence(row),
          proposal,
        };
      }
      throw err;
    }
  }

  refreshGateStatus(
    proposalId: ProposalId,
    environment: string = DEFAULT_ENVIRONMENT,
  ): {
    proposal: StoredProposal;
    changed: boolean;
    blockers: ReturnType<typeof computeBlockers>;
  } {
    const proposal = this.requireById(proposalId);
    if (
      proposal.status === "approved" ||
      proposal.status === "rejected" ||
      proposal.status === "superseded"
    ) {
      return {
        proposal,
        changed: false,
        blockers: computeBlockers(
          proposal.compatibility,
          proposal.consumers,
          this.getEvidence(proposalId),
          proposal.ttlMs,
          this.clock,
          proposal.status,
          this.getExemptions(proposalId),
          environment,
        ),
      };
    }
    const evidence = this.getEvidence(proposalId);
    const exemptions = this.getExemptions(proposalId);
    const blockers = computeBlockers(
      proposal.compatibility,
      proposal.consumers,
      evidence,
      proposal.ttlMs,
      this.clock,
      proposal.status,
      exemptions,
      environment,
    );
    let nextStatus = proposal.status;
    if (blockers.length === 0) {
      nextStatus =
        proposal.status === "open" || proposal.status === "collecting"
          ? "ready"
          : proposal.status;
    } else if (evidence.length > 0) {
      nextStatus = proposal.status === "open" ? "collecting" : proposal.status;
    }
    if (nextStatus !== proposal.status) {
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE proposals SET status = ? WHERE proposal_id = ?")
          .run(nextStatus, proposalId);
        this.append(proposalId, this.clock.now(), "gate-advanced", {
          fromStatus: proposal.status,
          toStatus: nextStatus,
          blockers,
        });
      })();
      return {
        proposal: this.requireById(proposalId),
        changed: true,
        blockers,
      };
    }
    return { proposal, changed: false, blockers };
  }

  decide(input: DecisionInput): {
    proposal: StoredProposal;
    event: CausalEvent;
    blockers: ReturnType<typeof computeBlockers>;
  } {
    const now = this.clock.now();
    const proposal = this.requireById(input.proposalId);

    if (proposal.status === "approved" || proposal.status === "rejected") {
      throw new ProposalAlreadyDecidedError(input.proposalId);
    }
    if (proposal.status === "superseded") {
      throw new ConflictError(
        `proposal ${input.proposalId} was superseded by ${proposal.lineage.successorId} and can no longer be decided`,
      );
    }

    const environment = input.environment ?? DEFAULT_ENVIRONMENT;
    const evidence = this.getEvidence(input.proposalId);
    const exemptions = this.getExemptions(input.proposalId);
    const evaluation = evaluateGate({
      compatibility: proposal.compatibility,
      consumers: proposal.consumers,
      evidence,
      exemptions,
      ttlMs: proposal.ttlMs,
      environment,
      clock: this.clock,
      currentStatus: proposal.status,
    });
    const blockers = evaluation.blockers;

    if (input.kind === "approve" && !isReady(blockers)) {
      throw new GateBlockedError(
        `cannot approve: ${blockers.map((b) => b.message).join("; ")}`,
        blockers,
      );
    }

    const latest = latestEvidencePerConsumer(evidence);
    const evidenceSummary = summarizeEvidence(evidence);
    const evidenceDigest = digest(
      [...latest.values()]
        .sort((a, b) => a.consumerId.localeCompare(b.consumerId))
        .map((e) => ({
          consumerId: e.consumerId,
          status: e.status,
          receivedAt: e.receivedAt,
          evidenceId: e.evidenceId,
          idempotencyKey: e.idempotencyKey,
        })),
    );
    const appliedExemptions = evaluation.appliedExemptions;
    const exemptionsDigest = appliedExemptionsDigest(appliedExemptions);
    const compatibilityDigest = digest(proposal.compatibility);
    const lastEventId = this.events.getLastEventId();

    const snapshot: DecisionSnapshot = {
      proposalId: input.proposalId,
      candidateDigest: proposal.candidateDigest,
      kind: input.kind,
      decidedAt: now,
      decider: input.decider,
      rationale: input.rationale,
      evidenceDigest,
      evidenceCount: evidenceSummary.total,
      passCount: evidenceSummary.byStatus.pass,
      failCount: evidenceSummary.byStatus.fail,
      errorCount: evidenceSummary.byStatus.error,
      compatibilityDigest,
      appliedExemptions,
      exemptionsDigest,
      proposalSnapshot: {
        topic: proposal.topic,
        baseline: proposal.baseline,
        candidate: proposal.candidate,
        consumers: proposal.consumers,
        compatibility: proposal.compatibility,
        status: input.kind === "approve" ? "approved" : "rejected",
      },
      lastEventId,
    };

    const finalStatus: StoredProposal["status"] =
      input.kind === "approve" ? "approved" : "rejected";

    const result = this.db.transaction(
      (): {
        proposal: StoredProposal;
        event: CausalEvent;
        blockers: ReturnType<typeof computeBlockers>;
      } => {
        const res = this.db
          .prepare(
            `UPDATE proposals
             SET status = ?, decided_at = ?, decision_json = ?, expected_version = expected_version + 1
           WHERE proposal_id = ? AND status NOT IN ('approved', 'rejected')`,
          )
          .run(finalStatus, now, JSON.stringify(snapshot), input.proposalId);
        if (res.changes === 0) {
          throw new ConflictError(
            "concurrent decision: proposal was already decided by another request",
          );
        }
        const event = this.append(input.proposalId, now, "decision-recorded", {
          kind: input.kind,
          candidateDigest: proposal.candidateDigest,
          decider: input.decider,
          lastEventId,
          appliedExemptionIds: appliedExemptions.map((a) => a.exemptionId),
        });
        return {
          proposal: this.requireById(input.proposalId),
          event,
          blockers,
        };
      },
    )();

    return result;
  }

  getAdditions(
    proposalId: ProposalId,
  ): import("../core/types.js").RequiredConsumerAddition[] {
    const row = this.db
      .prepare("SELECT additions_json FROM proposals WHERE proposal_id = ?")
      .get(proposalId) as { additions_json: string } | undefined;
    return row
      ? (JSON.parse(
          row.additions_json,
        ) as import("../core/types.js").RequiredConsumerAddition[])
      : [];
  }

  addRequiredConsumer(input: {
    proposalId: ProposalId;
    consumerId: ConsumerId;
    addedBy: string;
    reason: string;
    schema: import("../core/types.js").JsonSchema;
  }): {
    proposal: StoredProposal;
    addition: import("../core/types.js").RequiredConsumerAddition;
  } {
    const proposal = this.requireById(input.proposalId);
    if (proposal.status !== "approved") {
      throw new ConflictError(
        "required consumers can only be added to an approved proposal",
      );
    }
    const existing = (proposal.additions ?? []).find(
      (a) => a.consumerId === input.consumerId,
    );
    if (existing) {
      throw new ConflictError(
        `consumer ${input.consumerId} is already a required dependency`,
      );
    }
    if (proposal.consumers.some((c) => c.consumerId === input.consumerId)) {
      throw new ConflictError(
        `consumer ${input.consumerId} was already required at decision time`,
      );
    }
    const now = this.clock.now();
    const addition: import("../core/types.js").RequiredConsumerAddition = {
      consumerId: input.consumerId,
      addedAt: now,
      addedBy: input.addedBy,
      reason: input.reason,
      schema: input.schema,
      reverifiedAt: null,
      reverifiedBy: null,
      evidenceId: null,
    };
    const additions = [...(proposal.additions ?? []), addition];
    this.db
      .prepare("UPDATE proposals SET additions_json = ? WHERE proposal_id = ?")
      .run(JSON.stringify(additions), input.proposalId);
    this.append(input.proposalId, now, "topology-changed", {
      consumerId: input.consumerId,
      addedBy: input.addedBy,
      reason: input.reason,
      snapshotConsumerCount: proposal.consumers.length,
      requiredConsumerCount: additions.length + proposal.consumers.length,
    });
    return { proposal: this.requireById(input.proposalId), addition };
  }

  private ingestReverification(
    proposal: StoredProposal,
    addition: import("../core/types.js").RequiredConsumerAddition,
    input: EvidenceInput,
    now: number,
  ): EvidenceResult {
    const existing = this.db
      .prepare(
        "SELECT evidence_id FROM evidence WHERE proposal_id = ? AND idempotency_key = ?",
      )
      .get(input.proposalId, input.idempotencyKey) as
      | { evidence_id: string }
      | undefined;
    if (existing) {
      const row = this.db
        .prepare("SELECT * FROM evidence WHERE evidence_id = ?")
        .get(existing.evidence_id) as EvidenceRow;
      return {
        accepted: true,
        evidence: rowToEvidence(row),
        deduped: true,
        proposal,
      };
    }

    const evidenceId = `ev-${digestString(
      `${input.proposalId}:${input.idempotencyKey}:${input.consumerId}`,
    ).slice(0, 24)}`;
    const updatedAdditions = (proposal.additions ?? []).map((a) =>
      a.consumerId === addition.consumerId
        ? {
            ...a,
            reverifiedAt: now,
            reverifiedBy: input.agentRunId,
            evidenceId,
          }
        : a,
    );

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO evidence
            (evidence_id, proposal_id, candidate_digest, consumer_id, status, detail, reported_at, received_at, idempotency_key, agent_run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceId,
          input.proposalId,
          input.candidateDigest,
          input.consumerId,
          input.status,
          input.detail,
          input.reportedAt,
          now,
          input.idempotencyKey,
          input.agentRunId,
        );
      this.db
        .prepare(
          "UPDATE proposals SET additions_json = ? WHERE proposal_id = ?",
        )
        .run(JSON.stringify(updatedAdditions), input.proposalId);
      this.append(input.proposalId, now, "evidence-accepted", {
        evidenceId,
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
        postDecision: true,
      });
      this.append(input.proposalId, now, "reverification-concluded", {
        consumerId: addition.consumerId,
        reverifiedBy: input.agentRunId,
        evidenceId,
        candidateDigest: input.candidateDigest,
      });
    })();

    const row = this.db
      .prepare("SELECT * FROM evidence WHERE evidence_id = ?")
      .get(evidenceId) as EvidenceRow;
    return {
      accepted: true,
      evidence: rowToEvidence(row),
      deduped: false,
      proposal: this.requireById(input.proposalId),
    };
  }

  readEventsAfter(eventId: number): CausalEvent[] {
    return this.events.readAfter(eventId);
  }

  /**
   * Find the most recent event of the given type for a proposal and mutate its
   * JSON payload in place (used to enrich topology/reverification events with
   * rollout side-effect information discovered after the event was appended).
   */
  replaceLastEventPayload(
    proposalId: ProposalId,
    eventType: string,
    mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    const row = this.db
      .prepare(
        `SELECT event_id, occurred_at, prev_hash, payload_json FROM event_log
         WHERE proposal_id = ? AND event_type = ?
         ORDER BY event_id DESC LIMIT 1`,
      )
      .get(proposalId, eventType) as
      | {
          event_id: number;
          occurred_at: number;
          prev_hash: string;
          payload_json: string;
        }
      | undefined;
    if (!row) return;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const next = mutate(payload);
    const nextJson = JSON.stringify(next);
    const hash = hashEvent(
      row.event_id,
      proposalId,
      row.occurred_at,
      eventType,
      nextJson,
      row.prev_hash,
    );
    this.db
      .prepare(
        "UPDATE event_log SET payload_json = ?, hash = ? WHERE event_id = ?",
      )
      .run(nextJson, hash, row.event_id);
    this.rechainFrom(row.event_id, proposalId);
    const idx = this.pending.findIndex((e) => e.eventType === eventType);
    if (idx >= 0) {
      this.pending[idx] = {
        ...this.pending[idx],
        payload: next,
        hash,
      } as CausalEvent;
    }
  }

  private rechainFrom(eventId: number, proposalId: ProposalId): void {
    const rows = this.db
      .prepare(
        `SELECT event_id, occurred_at, event_type, payload_json, prev_hash
         FROM event_log WHERE proposal_id = ? AND event_id > ? ORDER BY event_id ASC`,
      )
      .all(proposalId, eventId) as {
      event_id: number;
      occurred_at: number;
      event_type: string;
      payload_json: string;
      prev_hash: string;
    }[];
    let prevHash = this.db
      .prepare("SELECT hash FROM event_log WHERE event_id = ?")
      .get(eventId) as { hash: string };
    for (const r of rows) {
      const hash = hashEvent(
        r.event_id,
        proposalId,
        r.occurred_at,
        r.event_type,
        r.payload_json,
        prevHash.hash,
      );
      this.db
        .prepare(
          "UPDATE event_log SET prev_hash = ?, hash = ? WHERE event_id = ?",
        )
        .run(prevHash.hash, hash, r.event_id);
      prevHash = { hash };
    }
  }
}
