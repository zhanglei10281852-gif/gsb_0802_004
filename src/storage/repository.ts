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
  return {
    proposalId: row.proposal_id,
    topic: row.topic,
    baseline: JSON.parse(row.baseline_json),
    candidate: JSON.parse(row.candidate_json),
    candidateDigest: row.candidate_digest,
    baselineDigest: row.baseline_digest,
    compatibility: JSON.parse(row.compatibility_json),
    consumers: JSON.parse(row.consumers_json) as ConsumerRef[],
    author: row.author,
    status: row.status as StoredProposal["status"],
    createdAt: row.created_at,
    ttlMs: row.ttl_ms,
    decidedAt: row.decided_at,
    decision,
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
      },
    )}`;

    const tx = this.db.transaction(
      (): { proposal: StoredProposal; event: CausalEvent } => {
        this.db
          .prepare(
            `INSERT INTO proposals
            (proposal_id, topic, baseline_json, candidate_json, candidate_digest, baseline_digest,
             compatibility_json, consumers_json, author, status, created_at, ttl_ms, decided_at, decision_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)`,
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
      this.append(input.proposalId, now, "evidence-rejected", {
        reason: "proposal-decided",
        candidateDigest: input.candidateDigest,
        consumerId: input.consumerId,
        idempotencyKey: input.idempotencyKey,
      });
      return { accepted: false, reason: "proposal-decided" };
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

  readEventsAfter(eventId: number): CausalEvent[] {
    return this.events.readAfter(eventId);
  }
}
