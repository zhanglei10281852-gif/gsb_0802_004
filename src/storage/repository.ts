import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import type { Clock } from "../domain/clock.js";
import {
  evaluateGate,
  validateExemptionClosure,
  validateExemptionConfirmation,
  validateExemptionRequest,
} from "../domain/gate.js";
import { stableHash } from "../domain/hash.js";
import { checkBackwardCompatibility } from "../domain/compatibility.js";
import type {
  CausalEvent,
  CausalEventType,
  Consumer,
  CoverageGap,
  CoverageGapStatus,
  Decision,
  DecisionSnapshot,
  EvidenceAcceptance,
  EvidenceRecord,
  EvidenceSubmission,
  EvidenceVerdict,
  Exemption,
  ExemptionDirection,
  ExemptionRequest,
  ExemptionStatus,
  FrozenExemption,
  PauseReason,
  Proposal,
  ProposalDetail,
  ProposalLineage,
  ProposalStatus,
  Receipt,
  ReceiptResult,
  Rollout,
  RolloutStatus,
  Wave,
  WaveSpec,
  WaveStatus,
} from "../domain/types.js";

export interface RepositoryOptions {
  clock: Clock;
  eventSink?: (event: CausalEvent) => void;
}

interface ProposalRow {
  id: string;
  candidate_hash: string;
  candidate_schema: string;
  baseline_schema: string;
  system_compatible: number;
  system_issues: string;
  status: ProposalStatus;
  environment: string;
  parent_proposal_id: string | null;
  replaces_candidate_hash: string | null;
  lineage_root_id: string;
  revision: number;
  created_at: number;
}

interface EvidenceRow {
  id: string;
  proposal_id: string;
  consumer_id: string;
  candidate_hash: string;
  verdict: "compatible" | "incompatible" | "error";
  details: string;
  idempotency_key: string;
  recorded_at: number;
  late: number;
}

interface ConsumerRow {
  id: string;
  name: string;
  registered_at: number;
}

interface DecisionRow {
  id: string;
  proposal_id: string;
  decision: "approved" | "rejected";
  reason: string;
  snapshot: string;
  decided_at: number;
}

interface ExemptionRow {
  id: string;
  candidate_hash: string;
  consumer_id: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requester_id: string;
  confirmer_id: string | null;
  status: ExemptionStatus;
  valid_from: number;
  valid_until: number;
  created_at: number;
  confirmed_at: number | null;
  closed_at: number | null;
  closed_by: string | null;
  close_note: string | null;
}

interface RolloutRow {
  id: string;
  proposal_id: string;
  candidate_hash: string;
  decision_id: string;
  environment: string;
  status: RolloutStatus;
  pause_reason: PauseReason;
  previous_version: string | null;
  rolled_back_to: string | null;
  rolled_back_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CoverageGapRow {
  id: string;
  rollout_id: string;
  proposal_id: string;
  candidate_hash: string;
  decision_id: string;
  consumer_id: string;
  status: CoverageGapStatus;
  detected_at: number;
  resolved_at: number | null;
  verdict: EvidenceVerdict | null;
  details: string | null;
  idempotency_key: string | null;
  recorded_at: number | null;
}

interface WaveRow {
  id: string;
  rollout_id: string;
  proposal_id: string;
  sequence: number;
  environment: string;
  status: WaveStatus;
  started_at: number | null;
  finished_at: number | null;
  last_result: ReceiptResult | null;
  attempts: number;
  last_message: string | null;
  last_adapter_id: string | null;
}

interface ReceiptRow {
  id: string;
  wave_id: string;
  proposal_id: string;
  candidate_hash: string;
  decision_id: string;
  result: ReceiptResult;
  adapter_id: string;
  idempotency_key: string;
  message: string;
  recorded_at: number;
}

export class Repository {
  private clock: Clock;
  private lamport: number;
  private eventSink?: (event: CausalEvent) => void;
  private buffering = false;
  private buffer: CausalEvent[] = [];

  constructor(
    private db: DB,
    opts: RepositoryOptions,
  ) {
    this.clock = opts.clock;
    this.eventSink = opts.eventSink;
    const row = db
      .prepare("SELECT MAX(clock) AS m FROM causal_events")
      .get() as { m: number | null };
    this.lamport = row.m ?? 0;
  }

  private tick(): number {
    this.lamport += 1;
    return this.lamport;
  }

  private transactional<T>(fn: () => T): T {
    const wasBuffering = this.buffering;
    this.buffering = true;
    try {
      const result = fn();
      if (!wasBuffering) {
        const flushed = this.buffer;
        this.buffer = [];
        this.buffering = false;
        for (const event of flushed) this.eventSink?.(event);
      }
      return result;
    } catch (err) {
      if (!wasBuffering) {
        this.buffer = [];
        this.buffering = false;
      }
      throw err;
    }
  }

  private recordEvent(
    type: CausalEventType,
    payload: Record<string, unknown>,
  ): CausalEvent {
    const clock = this.tick();
    const recordedAt = this.clock.now();
    const info = this.db
      .prepare(
        "INSERT INTO causal_events (type, payload, clock, recorded_at) VALUES (?, ?, ?, ?)",
      )
      .run(type, JSON.stringify(payload), clock, recordedAt);
    const event: CausalEvent = {
      id: Number(info.lastInsertRowid),
      type,
      payload,
      clock,
      recordedAt,
    };
    if (this.buffering) {
      this.buffer.push(event);
    } else {
      this.eventSink?.(event);
    }
    return event;
  }

  registerConsumer(id: string, name: string): Consumer {
    const txn = this.db.transaction((): Consumer => {
      const existing = this.getConsumer(id);
      if (existing) return existing;
      const registeredAt = this.clock.now();
      this.db
        .prepare(
          "INSERT INTO consumers (id, name, registered_at) VALUES (?, ?, ?)",
        )
        .run(id, name, registeredAt);
      this.recordEvent("consumer_registered", { consumerId: id, name });

      const activeRollouts = this.db
        .prepare(
          "SELECT * FROM rollouts WHERE status IN ('in_progress','paused')",
        )
        .all() as RolloutRow[];
      for (const row of activeRollouts) {
        this.detectCoverageGapForConsumer(row, id, registeredAt);
      }

      return { id, name, registeredAt };
    });
    return this.transactional(() => txn());
  }

  private detectCoverageGapForConsumer(
    rolloutRow: RolloutRow,
    consumerId: string,
    now: number,
  ): void {
    const decision = this.getDecision(rolloutRow.proposal_id);
    if (!decision) return;
    const snapshotConsumerIds = new Set(decision.snapshot.requiredConsumerIds);
    if (snapshotConsumerIds.has(consumerId)) return;

    const existing = this.db
      .prepare(
        "SELECT id FROM coverage_gaps WHERE rollout_id = ? AND consumer_id = ?",
      )
      .get(rolloutRow.id, consumerId) as { id: string } | undefined;
    if (existing) return;

    const gapId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO coverage_gaps
          (id, rollout_id, proposal_id, candidate_hash, decision_id, consumer_id, status, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        gapId,
        rolloutRow.id,
        rolloutRow.proposal_id,
        rolloutRow.candidate_hash,
        rolloutRow.decision_id,
        consumerId,
        now,
      );
    this.recordEvent("coverage_gap_detected", {
      rolloutId: rolloutRow.id,
      proposalId: rolloutRow.proposal_id,
      candidateHash: rolloutRow.candidate_hash,
      decisionId: rolloutRow.decision_id,
      consumerId,
      gapId,
      detectedAt: now,
    });

    if (rolloutRow.status === "in_progress") {
      this.db
        .prepare(
          "UPDATE rollouts SET status = 'paused', pause_reason = 'coverage_gap', updated_at = ? WHERE id = ? AND status = 'in_progress'",
        )
        .run(now, rolloutRow.id);
      this.recordEvent("rollout_auto_paused_coverage", {
        rolloutId: rolloutRow.id,
        proposalId: rolloutRow.proposal_id,
        consumerId,
        gapId,
        pausedAt: now,
        reason: `new consumer ${consumerId} registered after decision; coverage gap must be resolved before next wave`,
      });
    }
  }

  getConsumer(id: string): Consumer | null {
    const row = this.db
      .prepare("SELECT * FROM consumers WHERE id = ?")
      .get(id) as ConsumerRow | undefined;
    return row ? rowToConsumer(row) : null;
  }

  listConsumers(): Consumer[] {
    const rows = this.db
      .prepare("SELECT * FROM consumers ORDER BY registered_at ASC")
      .all() as ConsumerRow[];
    return rows.map(rowToConsumer);
  }

  createProposal(
    candidateSchema: Record<string, unknown>,
    baselineSchema: Record<string, unknown>,
    environment = "production",
  ): { proposal: Proposal; duplicate: boolean } {
    const candidateHash = stableHash(candidateSchema);
    const existing = this.db
      .prepare("SELECT * FROM proposals WHERE candidate_hash = ?")
      .get(candidateHash) as ProposalRow | undefined;
    if (existing) {
      return { proposal: rowToProposal(existing), duplicate: true };
    }
    const systemCompatibility = checkBackwardCompatibility(
      baselineSchema,
      candidateSchema,
    );
    const id = randomUUID();
    const createdAt = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO proposals
          (id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues,
           status, environment, parent_proposal_id, replaces_candidate_hash, lineage_root_id, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, 1, ?)`,
      )
      .run(
        id,
        candidateHash,
        JSON.stringify(candidateSchema),
        JSON.stringify(baselineSchema),
        systemCompatibility.compatible ? 1 : 0,
        JSON.stringify(systemCompatibility.issues),
        environment,
        id,
        createdAt,
      );
    const proposal = this.getProposal(id)!;
    this.recordEvent("proposal_created", {
      proposalId: id,
      candidateHash,
      environment,
      revision: 1,
      lineageRootId: id,
      systemCompatible: systemCompatibility.compatible,
      issueCount: systemCompatibility.issues.length,
    });
    return { proposal, duplicate: false };
  }

  createSuccessor(
    parentId: string,
    newCandidateSchema: Record<string, unknown>,
  ):
    | {
        ok: true;
        successor: Proposal;
        superseded: Proposal;
        duplicate: boolean;
      }
    | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () =>
        | {
            ok: true;
            successor: Proposal;
            superseded: Proposal;
            duplicate: boolean;
          }
        | { ok: false; reason: string }
    >(() => {
      const parent = this.getProposal(parentId);
      if (!parent) return { ok: false, reason: "unknown parent proposal" };
      if (parent.status !== "pending") {
        return {
          ok: false,
          reason: `cannot supersede a ${parent.status} proposal`,
        };
      }

      const candidateHash = stableHash(newCandidateSchema);
      if (candidateHash === parent.candidateHash) {
        return {
          ok: false,
          reason: "successor candidate is identical to parent candidate",
        };
      }
      const existing = this.db
        .prepare("SELECT * FROM proposals WHERE candidate_hash = ?")
        .get(candidateHash) as ProposalRow | undefined;
      if (existing) {
        return {
          ok: true,
          successor: rowToProposal(existing),
          superseded: parent,
          duplicate: true,
        };
      }

      const systemCompatibility = checkBackwardCompatibility(
        parent.baselineSchema,
        newCandidateSchema,
      );
      const id = randomUUID();
      const createdAt = this.clock.now();
      const revision = parent.revision + 1;
      const lineageRootId = parent.lineageRootId;
      this.db
        .prepare(
          `INSERT INTO proposals
            (id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues,
             status, environment, parent_proposal_id, replaces_candidate_hash, lineage_root_id, revision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          candidateHash,
          JSON.stringify(newCandidateSchema),
          JSON.stringify(parent.baselineSchema),
          systemCompatibility.compatible ? 1 : 0,
          JSON.stringify(systemCompatibility.issues),
          parent.environment,
          parent.id,
          parent.candidateHash,
          lineageRootId,
          revision,
          createdAt,
        );

      const updateResult = this.db
        .prepare(
          "UPDATE proposals SET status = 'superseded' WHERE id = ? AND status = 'pending'",
        )
        .run(parent.id);
      if (updateResult.changes !== 1) {
        throw new Error("concurrent close of parent proposal detected");
      }

      const oldExemptions = this.db
        .prepare(
          "SELECT * FROM exemptions WHERE candidate_hash = ? AND status IN ('pending','active')",
        )
        .all(parent.candidateHash) as ExemptionRow[];
      const closedAt = this.clock.now();
      for (const ex of oldExemptions) {
        this.db
          .prepare(
            `UPDATE exemptions SET status = 'voided', closed_at = ?, closed_by = ?, close_note = ? WHERE id = ?`,
          )
          .run(
            closedAt,
            "system:successor",
            `voided when parent proposal superseded by ${id}`,
            ex.id,
          );
        this.recordEvent("exemption_voided", {
          exemptionId: ex.id,
          candidateHash: ex.candidate_hash,
          consumerId: ex.consumer_id,
          environment: ex.environment,
          direction: ex.direction,
          successorProposalId: id,
          successorCandidateHash: candidateHash,
          voidedAt: closedAt,
        });
      }

      const successor = this.getProposal(id)!;
      const superseded = this.getProposal(parent.id)!;

      this.recordEvent("proposal_superseded", {
        proposalId: parent.id,
        candidateHash: parent.candidateHash,
        successorProposalId: id,
        successorCandidateHash: candidateHash,
        voidedExemptionIds: oldExemptions.map((e) => e.id),
        supersededAt: closedAt,
      });
      this.recordEvent("successor_created", {
        proposalId: id,
        candidateHash,
        parentProposalId: parent.id,
        replacesCandidateHash: parent.candidateHash,
        lineageRootId,
        revision,
        environment: parent.environment,
      });

      return { ok: true, successor, superseded, duplicate: false };
    });

    return this.transactional(() => txn());
  }

  listSuccessors(parentProposalId: string): Proposal[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM proposals WHERE parent_proposal_id = ? ORDER BY revision ASC",
      )
      .all(parentProposalId) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  getLineage(rootId: string): Proposal[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM proposals WHERE lineage_root_id = ? ORDER BY revision ASC",
      )
      .all(rootId) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  getProposal(id: string): Proposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE id = ?")
      .get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  getProposalByHash(hash: string): Proposal | null {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE candidate_hash = ?")
      .get(hash) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  listProposals(): Proposal[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals ORDER BY created_at ASC")
      .all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  submitEvidence(submission: EvidenceSubmission): EvidenceAcceptance {
    const txn = this.db.transaction(
      (sub: EvidenceSubmission): EvidenceAcceptance => {
        const proposal = this.getProposal(sub.proposalId);
        const knownConsumers = new Set(this.listConsumers().map((c) => c.id));

        if (!proposal) {
          this.recordEvent("evidence_rejected", {
            reason: "unknown proposal",
            consumerId: sub.consumerId,
            proposalId: sub.proposalId,
            idempotencyKey: sub.idempotencyKey,
          });
          return {
            accepted: false,
            reason: "unknown proposal",
            evidence: null,
          };
        }
        if (!knownConsumers.has(sub.consumerId)) {
          this.recordEvent("evidence_rejected", {
            reason: "unknown consumer",
            consumerId: sub.consumerId,
            proposalId: sub.proposalId,
            idempotencyKey: sub.idempotencyKey,
          });
          return {
            accepted: false,
            reason: `unknown consumer "${sub.consumerId}"`,
            evidence: null,
          };
        }
        if (sub.candidateHash !== proposal.candidateHash) {
          this.recordEvent("evidence_rejected", {
            reason: "candidate hash mismatch",
            consumerId: sub.consumerId,
            proposalId: sub.proposalId,
            idempotencyKey: sub.idempotencyKey,
            evidenceHash: sub.candidateHash,
            proposalHash: proposal.candidateHash,
          });
          return {
            accepted: false,
            reason:
              "candidate hash mismatch; late result for a different proposal",
            evidence: null,
          };
        }
        if (proposal.status === "approved" || proposal.status === "rejected") {
          this.recordEvent("evidence_rejected", {
            reason: `proposal already ${proposal.status}`,
            consumerId: sub.consumerId,
            proposalId: sub.proposalId,
            idempotencyKey: sub.idempotencyKey,
          });
          return {
            accepted: false,
            reason: `proposal already ${proposal.status}; evidence cannot alter the decision`,
            evidence: null,
          };
        }

        const late = proposal.status === "superseded";
        const existing = this.db
          .prepare(
            "SELECT * FROM evidence WHERE proposal_id = ? AND consumer_id = ?",
          )
          .get(sub.proposalId, sub.consumerId) as EvidenceRow | undefined;

        if (existing && existing.idempotency_key === sub.idempotencyKey) {
          return {
            accepted: true,
            evidence: rowToEvidence(existing),
            deduped: true,
          };
        }

        const recordedAt = this.clock.now();
        if (existing) {
          this.db
            .prepare(
              `UPDATE evidence
             SET verdict = ?, details = ?, idempotency_key = ?, recorded_at = ?, candidate_hash = ?, late = ?
             WHERE id = ?`,
            )
            .run(
              sub.verdict,
              sub.details,
              sub.idempotencyKey,
              recordedAt,
              sub.candidateHash,
              late ? 1 : 0,
              existing.id,
            );
          const updated = this.db
            .prepare("SELECT * FROM evidence WHERE id = ?")
            .get(existing.id) as EvidenceRow;
          const evidence = rowToEvidence(updated);
          this.recordEvent(
            late ? "evidence_received_late" : "evidence_accepted",
            {
              proposalId: sub.proposalId,
              consumerId: sub.consumerId,
              verdict: sub.verdict,
              idempotencyKey: sub.idempotencyKey,
              deduped: false,
              updated: true,
              late,
            },
          );
          return { accepted: true, evidence, deduped: false };
        }

        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO evidence
            (id, proposal_id, consumer_id, candidate_hash, verdict, details, idempotency_key, recorded_at, late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            sub.proposalId,
            sub.consumerId,
            sub.candidateHash,
            sub.verdict,
            sub.details,
            sub.idempotencyKey,
            recordedAt,
            late ? 1 : 0,
          );
        const row = this.db
          .prepare("SELECT * FROM evidence WHERE id = ?")
          .get(id) as EvidenceRow;
        const evidence = rowToEvidence(row);
        this.recordEvent(
          late ? "evidence_received_late" : "evidence_accepted",
          {
            proposalId: sub.proposalId,
            consumerId: sub.consumerId,
            verdict: sub.verdict,
            idempotencyKey: sub.idempotencyKey,
            deduped: false,
            updated: false,
            late,
          },
        );
        return { accepted: true, evidence, deduped: false };
      },
    );

    return this.transactional(() => txn(submission));
  }

  listEvidence(proposalId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM evidence WHERE proposal_id = ? ORDER BY recorded_at ASC",
      )
      .all(proposalId) as EvidenceRow[];
    return rows.map(rowToEvidence);
  }

  getExemption(id: string): Exemption | null {
    const row = this.db
      .prepare("SELECT * FROM exemptions WHERE id = ?")
      .get(id) as ExemptionRow | undefined;
    return row ? rowToExemption(row) : null;
  }

  listExemptions(candidateHash?: string): Exemption[] {
    const rows = candidateHash
      ? (this.db
          .prepare(
            "SELECT * FROM exemptions WHERE candidate_hash = ? ORDER BY created_at ASC",
          )
          .all(candidateHash) as ExemptionRow[])
      : (this.db
          .prepare("SELECT * FROM exemptions ORDER BY created_at ASC")
          .all() as ExemptionRow[]);
    return rows.map(rowToExemption);
  }

  sweepExpiredExemptions(): Exemption[] {
    const now = this.clock.now();
    const expired: Exemption[] = [];
    const run = (): Exemption[] => {
      const rows = this.db
        .prepare(
          "SELECT * FROM exemptions WHERE status = 'active' AND valid_until < ?",
        )
        .all(now) as ExemptionRow[];
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE exemptions SET status = 'expired', closed_at = ?, closed_by = ?, close_note = ? WHERE id = ? AND status = 'active'`,
          )
          .run(
            now,
            "system:expiry",
            `expired at ${now} (valid_until=${row.valid_until})`,
            row.id,
          );
        const ex = rowToExemption({
          ...row,
          status: "expired",
          closed_at: now,
          closed_by: "system:expiry",
        });
        expired.push(ex);
        this.recordEvent("exemption_expired", {
          exemptionId: row.id,
          candidateHash: row.candidate_hash,
          consumerId: row.consumer_id,
          environment: row.environment,
          direction: row.direction,
          validUntil: row.valid_until,
          expiredAt: now,
        });
      }
      return expired;
    };
    if (this.buffering) return run();
    return this.transactional(() => this.db.transaction(run)());
  }

  requestExemption(
    req: ExemptionRequest,
  ): { ok: true; exemption: Exemption } | { ok: false; reason: string } {
    const knownConsumers = new Set(this.listConsumers().map((c) => c.id));
    const validation = validateExemptionRequest(
      req,
      knownConsumers,
      this.clock.now(),
    );
    if (!validation.ok) return { ok: false, reason: validation.reason! };

    const candidate = this.getProposalByHash(req.candidateHash);
    if (!candidate) return { ok: false, reason: "unknown candidate hash" };

    const id = randomUUID();
    const createdAt = this.clock.now();
    try {
      this.db
        .prepare(
          `INSERT INTO exemptions
            (id, candidate_hash, consumer_id, environment, direction, reason, requester_id, confirmer_id,
             status, valid_from, valid_until, created_at, confirmed_at, closed_at, closed_by, close_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          id,
          req.candidateHash,
          req.consumerId,
          req.environment,
          req.direction,
          req.reason,
          req.requesterId,
          req.validFrom,
          req.validUntil,
          createdAt,
        );
    } catch (err) {
      return {
        ok: false,
        reason: `an open exemption already exists for this candidate/consumer/environment/direction: ${(err as Error).message}`,
      };
    }

    const exemption = this.getExemption(id)!;
    this.recordEvent("exemption_requested", {
      exemptionId: id,
      candidateHash: req.candidateHash,
      consumerId: req.consumerId,
      environment: req.environment,
      direction: req.direction,
      requesterId: req.requesterId,
      validFrom: req.validFrom,
      validUntil: req.validUntil,
      reason: req.reason,
    });
    return { ok: true, exemption };
  }

  confirmExemption(
    id: string,
    confirmerId: string,
  ): { ok: true; exemption: Exemption } | { ok: false; reason: string } {
    const txn = this.db.transaction(() => {
      const ex = this.getExemption(id);
      if (!ex) return { ok: false as const, reason: "unknown exemption" };
      const validation = validateExemptionConfirmation(ex, confirmerId);
      if (!validation.ok)
        return { ok: false as const, reason: validation.reason! };

      const confirmedAt = this.clock.now();
      this.db
        .prepare(
          "UPDATE exemptions SET status = 'active', confirmer_id = ?, confirmed_at = ? WHERE id = ?",
        )
        .run(confirmerId, confirmedAt, id);
      const updated = this.getExemption(id)!;
      this.recordEvent("exemption_confirmed", {
        exemptionId: id,
        candidateHash: ex.candidateHash,
        consumerId: ex.consumerId,
        environment: ex.environment,
        direction: ex.direction,
        requesterId: ex.requesterId,
        confirmerId,
        confirmedAt,
        validUntil: ex.validUntil,
      });
      return { ok: true as const, exemption: updated };
    });
    return this.transactional(() => txn());
  }

  closeExemption(
    id: string,
    reviewerId: string,
    action: "reject" | "revoke",
    note: string,
  ): { ok: true; exemption: Exemption } | { ok: false; reason: string } {
    const txn = this.db.transaction(() => {
      const ex = this.getExemption(id);
      if (!ex) return { ok: false as const, reason: "unknown exemption" };
      const validation = validateExemptionClosure(ex, reviewerId, action);
      if (!validation.ok)
        return { ok: false as const, reason: validation.reason! };

      const closedAt = this.clock.now();
      const status = action === "reject" ? "rejected" : "revoked";
      this.db
        .prepare(
          `UPDATE exemptions SET status = ?, closed_at = ?, closed_by = ?, close_note = ? WHERE id = ?`,
        )
        .run(status, closedAt, reviewerId, note, id);
      const updated = this.getExemption(id)!;
      this.recordEvent(
        action === "reject" ? "exemption_rejected" : "exemption_revoked",
        {
          exemptionId: id,
          candidateHash: ex.candidateHash,
          consumerId: ex.consumerId,
          environment: ex.environment,
          direction: ex.direction,
          reviewerId,
          note,
          closedAt,
        },
      );
      return { ok: true as const, exemption: updated };
    });
    return this.transactional(() => txn());
  }

  private freezeExemption(ex: Exemption): FrozenExemption {
    return {
      id: ex.id,
      candidateHash: ex.candidateHash,
      consumerId: ex.consumerId,
      environment: ex.environment,
      direction: ex.direction,
      reason: ex.reason,
      requesterId: ex.requesterId,
      confirmerId: ex.confirmerId!,
      validFrom: ex.validFrom,
      validUntil: ex.validUntil,
      confirmedAt: ex.confirmedAt!,
    };
  }

  private buildSnapshot(proposal: Proposal, now: number): DecisionSnapshot {
    const evidence = this.listEvidence(proposal.id);
    const requiredConsumerIds = this.listConsumers()
      .map((c) => c.id)
      .sort();
    const exemptions = this.listExemptions(proposal.candidateHash);
    const evaluation = evaluateGate(
      proposal,
      evidence,
      requiredConsumerIds,
      exemptions,
      now,
    );
    return {
      proposal,
      evidence,
      requiredConsumerIds,
      missingConsumerIds: evaluation.missingConsumerIds,
      exemptedConsumerIds: evaluation.exemptedConsumerIds,
      appliedExemptions: evaluation.appliedExemptions.map((e) =>
        this.freezeExemption(e),
      ),
      gateReady: evaluation.gateReady,
      blockingReasons: evaluation.blockingReasons,
      systemCompatibility: proposal.systemCompatibility,
    };
  }

  getProposalDetail(id: string): ProposalDetail | null {
    this.sweepExpiredExemptions();
    const now = this.clock.now();
    const proposal = this.getProposal(id);
    if (!proposal) return null;
    const evidence = this.listEvidence(id);
    const requiredConsumerIds = this.listConsumers()
      .map((c) => c.id)
      .sort();
    const exemptions = this.listExemptions(proposal.candidateHash);
    const evaluation = evaluateGate(
      proposal,
      evidence,
      requiredConsumerIds,
      exemptions,
      now,
    );
    const decision = this.getDecision(id);
    const successors = this.listSuccessors(id);
    const parent = proposal.parentProposalId
      ? this.getProposal(proposal.parentProposalId)
      : null;
    const successorIds = successors.map((s) => s.id);
    const lineage: ProposalLineage = {
      rootId: proposal.lineageRootId,
      revision: proposal.revision,
      parentProposalId: proposal.parentProposalId,
      replacesCandidateHash: proposal.replacesCandidateHash,
      successorIds,
    };
    return {
      proposal,
      evidence,
      exemptions,
      requiredConsumerIds,
      missingConsumerIds: evaluation.missingConsumerIds,
      exemptedConsumerIds: evaluation.exemptedConsumerIds,
      compatibleConsumerIds: evaluation.compatibleConsumers,
      incompatibleConsumerIds: evaluation.incompatibleConsumers,
      appliedExemptions: evaluation.appliedExemptions,
      gateReady: evaluation.gateReady,
      blockingReasons: evaluation.blockingReasons,
      decision,
      lineage,
      successors,
      parent,
      rollout: this.getRolloutByProposal(id),
    };
  }

  // ---------------------------------------------------------------------------
  // Phased rollout
  // ---------------------------------------------------------------------------

  private rowToWave(row: WaveRow): Wave {
    return {
      id: row.id,
      rolloutId: row.rollout_id,
      proposalId: row.proposal_id,
      sequence: row.sequence,
      environment: row.environment,
      status: row.status as WaveStatus,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      lastResult: (row.last_result as ReceiptResult | null) ?? null,
      attempts: row.attempts,
      lastMessage: row.last_message,
      lastAdapterId: row.last_adapter_id,
    };
  }

  private rowToCoverageGap(row: CoverageGapRow): CoverageGap {
    return {
      id: row.id,
      rolloutId: row.rollout_id,
      proposalId: row.proposal_id,
      candidateHash: row.candidate_hash,
      decisionId: row.decision_id,
      consumerId: row.consumer_id,
      status: row.status as CoverageGapStatus,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
      verdict: (row.verdict as EvidenceVerdict | null) ?? null,
      details: row.details,
      idempotencyKey: row.idempotency_key,
      recordedAt: row.recorded_at,
    };
  }

  private listCoverageGaps(rolloutId: string): CoverageGap[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM coverage_gaps WHERE rollout_id = ? ORDER BY detected_at ASC",
      )
      .all(rolloutId) as CoverageGapRow[];
    return rows.map((r) => this.rowToCoverageGap(r));
  }

  private hasOpenCoverageGaps(rolloutId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM coverage_gaps WHERE rollout_id = ? AND status = 'open'",
      )
      .get(rolloutId) as { c: number };
    return row.c > 0;
  }

  private rowToRollout(
    row: RolloutRow,
    waves: Wave[],
    coverageGaps: CoverageGap[],
  ): Rollout {
    return {
      id: row.id,
      proposalId: row.proposal_id,
      candidateHash: row.candidate_hash,
      decisionId: row.decision_id,
      environment: row.environment,
      status: row.status as RolloutStatus,
      waves,
      previousVersion: row.previous_version,
      rolledBackTo: row.rolled_back_to,
      rolledBackAt: row.rolled_back_at,
      pauseReason: (row.pause_reason as PauseReason) ?? null,
      coverageGaps,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private loadRolloutRow(row: RolloutRow): Rollout {
    const waves = this.db
      .prepare("SELECT * FROM waves WHERE rollout_id = ? ORDER BY sequence ASC")
      .all(row.id) as WaveRow[];
    const gaps = this.listCoverageGaps(row.id);
    return this.rowToRollout(
      row,
      waves.map((w) => this.rowToWave(w)),
      gaps,
    );
  }

  getRolloutByProposal(proposalId: string): Rollout | null {
    const row = this.db
      .prepare("SELECT * FROM rollouts WHERE proposal_id = ?")
      .get(proposalId) as RolloutRow | undefined;
    if (!row) return null;
    return this.loadRolloutRow(row);
  }

  getRollout(id: string): Rollout | null {
    const row = this.db
      .prepare("SELECT * FROM rollouts WHERE id = ?")
      .get(id) as RolloutRow | undefined;
    if (!row) return null;
    return this.loadRolloutRow(row);
  }

  startRollout(
    proposalId: string,
    waveSpecs: WaveSpec[],
    previousVersion: string | null,
  ): { ok: true; rollout: Rollout } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; rollout: Rollout } | { ok: false; reason: string }
    >(() => {
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { ok: false, reason: "unknown proposal" };
      if (proposal.status !== "approved") {
        return {
          ok: false,
          reason: `can only start rollout for an approved proposal (status=${proposal.status})`,
        };
      }
      const decision = this.getDecision(proposalId);
      if (!decision)
        return { ok: false, reason: "approved proposal has no decision" };

      const existing = this.getRolloutByProposal(proposalId);
      if (existing)
        return {
          ok: false,
          reason: "rollout already exists for this proposal",
        };

      if (!Array.isArray(waveSpecs) || waveSpecs.length === 0) {
        return { ok: false, reason: "at least one wave is required" };
      }
      const sequences = waveSpecs.map((w) => w.sequence);
      if (new Set(sequences).size !== sequences.length) {
        return { ok: false, reason: "wave sequences must be unique" };
      }
      const sorted = [...waveSpecs].sort((a, b) => a.sequence - b.sequence);
      if (sorted.some((w, i) => w.sequence !== i + 1)) {
        return {
          ok: false,
          reason: "wave sequences must be 1..N with no gaps",
        };
      }

      const now = this.clock.now();
      const rolloutId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO rollouts
            (id, proposal_id, candidate_hash, decision_id, environment, status,
             previous_version, rolled_back_to, rolled_back_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'in_progress', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          rolloutId,
          proposalId,
          proposal.candidateHash,
          decision.id,
          proposal.environment,
          previousVersion,
          now,
          now,
        );

      const waveIds: string[] = [];
      for (const spec of sorted) {
        const waveId = randomUUID();
        waveIds.push(waveId);
        const isFirst = spec.sequence === 1;
        this.db
          .prepare(
            `INSERT INTO waves
              (id, rollout_id, proposal_id, sequence, environment, status,
               started_at, finished_at, last_result, attempts, last_message, last_adapter_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL)`,
          )
          .run(
            waveId,
            rolloutId,
            proposalId,
            spec.sequence,
            spec.environment,
            isFirst ? "in_progress" : "pending",
            isFirst ? now : null,
          );
        if (isFirst) {
          this.recordEvent("wave_started", {
            rolloutId,
            waveId,
            proposalId,
            sequence: spec.sequence,
            environment: spec.environment,
            decisionId: decision.id,
            candidateHash: proposal.candidateHash,
            startedAt: now,
          });
        }
      }

      const snapshotConsumerIds = new Set(
        decision.snapshot.requiredConsumerIds,
      );
      const allConsumers = this.listConsumers();
      const newConsumers = allConsumers.filter(
        (c) => !snapshotConsumerIds.has(c.id),
      );
      for (const c of newConsumers) {
        const gapId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO coverage_gaps
              (id, rollout_id, proposal_id, candidate_hash, decision_id, consumer_id, status, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(
            gapId,
            rolloutId,
            proposalId,
            proposal.candidateHash,
            decision.id,
            c.id,
            now,
          );
        this.recordEvent("coverage_gap_detected", {
          rolloutId,
          proposalId,
          candidateHash: proposal.candidateHash,
          decisionId: decision.id,
          consumerId: c.id,
          gapId,
          detectedAt: now,
        });
      }
      if (newConsumers.length > 0) {
        this.db
          .prepare(
            "UPDATE rollouts SET status = 'paused', pause_reason = 'coverage_gap', updated_at = ? WHERE id = ?",
          )
          .run(now, rolloutId);
        this.recordEvent("rollout_auto_paused_coverage", {
          rolloutId,
          proposalId,
          consumerIds: newConsumers.map((c) => c.id),
          pausedAt: now,
          reason: `${newConsumers.length} new consumer(s) registered after decision; coverage gaps must be resolved before next wave`,
        });
      }

      this.recordEvent("rollout_started", {
        rolloutId,
        proposalId,
        decisionId: decision.id,
        candidateHash: proposal.candidateHash,
        waveCount: sorted.length,
        waves: sorted.map((w) => ({
          sequence: w.sequence,
          environment: w.environment,
        })),
        previousVersion,
        coverageGapConsumerIds: newConsumers.map((c) => c.id),
        startedAt: now,
      });

      return { ok: true, rollout: this.getRollout(rolloutId)! };
    });
    return this.transactional(() => txn());
  }

  reportReceipt(input: {
    rolloutId: string;
    sequence: number;
    result: ReceiptResult;
    adapterId: string;
    idempotencyKey: string;
    message?: string;
  }):
    | { ok: true; receipt: Receipt; rollout: Rollout; duplicate: boolean }
    | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () =>
        | { ok: true; receipt: Receipt; rollout: Rollout; duplicate: boolean }
        | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(input.rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };

      const wave = rollout.waves.find((w) => w.sequence === input.sequence);
      if (!wave)
        return { ok: false, reason: `no wave with sequence ${input.sequence}` };

      if (wave.proposalId !== rollout.proposalId) {
        return { ok: false, reason: "wave/proposal binding mismatch" };
      }

      const existing = this.db
        .prepare(
          "SELECT * FROM receipts WHERE wave_id = ? AND idempotency_key = ?",
        )
        .get(wave.id, input.idempotencyKey) as ReceiptRow | undefined;
      if (existing) {
        const receipt = this.rowToReceipt(existing, true);
        return {
          ok: true,
          receipt,
          rollout: this.getRollout(rollout.id)!,
          duplicate: true,
        };
      }

      if (
        input.result !== "success" &&
        input.result !== "failure" &&
        input.result !== "unknown"
      ) {
        return { ok: false, reason: `invalid result "${input.result}"` };
      }

      if (wave.status !== "in_progress") {
        return {
          ok: false,
          reason: `wave ${input.sequence} is ${wave.status}; receipts only accepted for the current (in_progress) wave`,
        };
      }

      const now = this.clock.now();
      const receiptId = randomUUID();
      const message = input.message ?? "";
      this.db
        .prepare(
          `INSERT INTO receipts
            (id, wave_id, proposal_id, candidate_hash, decision_id, result, adapter_id, idempotency_key, message, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          wave.id,
          rollout.proposalId,
          rollout.candidateHash,
          rollout.decisionId,
          input.result,
          input.adapterId,
          input.idempotencyKey,
          message,
          now,
        );

      const attempts = wave.attempts + 1;
      this.db
        .prepare(
          `UPDATE waves SET attempts = ?, last_result = ?, last_message = ?, last_adapter_id = ? WHERE id = ?`,
        )
        .run(attempts, input.result, message, input.adapterId, wave.id);

      const receipt = {
        id: receiptId,
        waveId: wave.id,
        proposalId: rollout.proposalId,
        candidateHash: rollout.candidateHash,
        decisionId: rollout.decisionId,
        result: input.result,
        adapterId: input.adapterId,
        idempotencyKey: input.idempotencyKey,
        message,
        recordedAt: now,
        duplicate: false,
      };

      this.recordEvent("wave_receipt", {
        rolloutId: rollout.id,
        waveId: wave.id,
        proposalId: rollout.proposalId,
        sequence: wave.sequence,
        decisionId: rollout.decisionId,
        candidateHash: rollout.candidateHash,
        result: input.result,
        adapterId: input.adapterId,
        idempotencyKey: input.idempotencyKey,
        attempts,
        recordedAt: now,
      });

      if (input.result === "success") {
        this.db
          .prepare(
            `UPDATE waves SET status = 'succeeded', finished_at = ? WHERE id = ?`,
          )
          .run(now, wave.id);
        this.recordEvent("wave_succeeded", {
          rolloutId: rollout.id,
          waveId: wave.id,
          sequence: wave.sequence,
          finishedAt: now,
        });

        const hasGaps = this.hasOpenCoverageGaps(rollout.id);
        if (hasGaps) {
          const openGaps = this.listCoverageGaps(rollout.id).filter(
            (g) => g.status === "open",
          );
          this.db
            .prepare(
              "UPDATE rollouts SET status = 'paused', pause_reason = 'coverage_gap', updated_at = ? WHERE id = ?",
            )
            .run(now, rollout.id);
          this.recordEvent("rollout_auto_paused_coverage", {
            rolloutId: rollout.id,
            proposalId: rollout.proposalId,
            afterWave: wave.sequence,
            openGapConsumerIds: openGaps.map((g) => g.consumerId),
            pausedAt: now,
            reason: `wave ${wave.sequence} succeeded but ${openGaps.length} coverage gap(s) remain; next wave held`,
          });
        } else {
          const next = rollout.waves.find(
            (w) => w.sequence === wave.sequence + 1,
          );
          if (next) {
            this.db
              .prepare(
                `UPDATE waves SET status = 'in_progress', started_at = ? WHERE id = ?`,
              )
              .run(now, next.id);
            this.recordEvent("wave_started", {
              rolloutId: rollout.id,
              waveId: next.id,
              sequence: next.sequence,
              environment: next.environment,
              startedAt: now,
            });
            this.db
              .prepare(
                "UPDATE rollouts SET status = 'in_progress', pause_reason = NULL, updated_at = ? WHERE id = ?",
              )
              .run(now, rollout.id);
          } else {
            this.db
              .prepare(
                "UPDATE rollouts SET status = 'succeeded', pause_reason = NULL, updated_at = ? WHERE id = ?",
              )
              .run(now, rollout.id);
            this.recordEvent("rollout_succeeded", {
              rolloutId: rollout.id,
              proposalId: rollout.proposalId,
              finishedAt: now,
            });
          }
        }
      } else if (input.result === "failure") {
        this.db
          .prepare(
            `UPDATE waves SET status = 'failed', finished_at = ? WHERE id = ?`,
          )
          .run(now, wave.id);
        this.db
          .prepare(
            "UPDATE rollouts SET status = 'failed', pause_reason = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now, rollout.id);
        this.recordEvent("wave_failed", {
          rolloutId: rollout.id,
          waveId: wave.id,
          sequence: wave.sequence,
          message,
          finishedAt: now,
        });
        this.recordEvent("rollout_failed", {
          rolloutId: rollout.id,
          proposalId: rollout.proposalId,
          failedWave: wave.sequence,
          finishedAt: now,
        });
      } else {
        this.db
          .prepare("UPDATE rollouts SET updated_at = ? WHERE id = ?")
          .run(now, rollout.id);
      }

      return {
        ok: true,
        receipt,
        rollout: this.getRollout(rollout.id)!,
        duplicate: false,
      };
    });
    return this.transactional(() => txn());
  }

  pauseRollout(
    rolloutId: string,
    reason: string,
  ): { ok: true; rollout: Rollout } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; rollout: Rollout } | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };
      if (rollout.status !== "in_progress") {
        return {
          ok: false,
          reason: `cannot pause a ${rollout.status} rollout`,
        };
      }
      const now = this.clock.now();
      const current = rollout.waves.find((w) => w.status === "in_progress");
      if (current) {
        this.db
          .prepare("UPDATE waves SET status = 'paused' WHERE id = ?")
          .run(current.id);
      }
      this.db
        .prepare(
          "UPDATE rollouts SET status = 'paused', pause_reason = 'manual', updated_at = ? WHERE id = ?",
        )
        .run(now, rolloutId);
      this.recordEvent("rollout_paused", {
        rolloutId,
        proposalId: rollout.proposalId,
        currentWave: current?.sequence ?? null,
        reason,
        pausedAt: now,
      });
      return { ok: true, rollout: this.getRollout(rolloutId)! };
    });
    return this.transactional(() => txn());
  }

  resumeRollout(
    rolloutId: string,
  ): { ok: true; rollout: Rollout } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; rollout: Rollout } | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };
      if (rollout.status !== "paused") {
        return {
          ok: false,
          reason: `cannot resume a ${rollout.status} rollout`,
        };
      }
      if (this.hasOpenCoverageGaps(rolloutId)) {
        const openGaps = this.listCoverageGaps(rolloutId).filter(
          (g) => g.status === "open",
        );
        return {
          ok: false,
          reason: `cannot resume: ${openGaps.length} open coverage gap(s) for consumer(s): ${openGaps.map((g) => g.consumerId).join(", ")}`,
        };
      }
      const now = this.clock.now();
      const paused = rollout.waves.find((w) => w.status === "paused");
      if (paused) {
        this.db
          .prepare("UPDATE waves SET status = 'in_progress' WHERE id = ?")
          .run(paused.id);
      } else {
        const nextPending = rollout.waves.find((w) => w.status === "pending");
        if (nextPending) {
          this.db
            .prepare(
              "UPDATE waves SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?",
            )
            .run(now, nextPending.id);
          this.recordEvent("wave_started", {
            rolloutId,
            waveId: nextPending.id,
            sequence: nextPending.sequence,
            environment: nextPending.environment,
            startedAt: now,
          });
        }
      }
      this.db
        .prepare(
          "UPDATE rollouts SET status = 'in_progress', pause_reason = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, rolloutId);
      this.recordEvent("rollout_resumed", {
        rolloutId,
        proposalId: rollout.proposalId,
        resumedWave:
          paused?.sequence ??
          rollout.waves.find((w) => w.status === "pending")?.sequence ??
          null,
        resumedAt: now,
      });
      return { ok: true, rollout: this.getRollout(rolloutId)! };
    });
    return this.transactional(() => txn());
  }

  retryWave(
    rolloutId: string,
    sequence: number,
  ): { ok: true; rollout: Rollout } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; rollout: Rollout } | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };
      const wave = rollout.waves.find((w) => w.sequence === sequence);
      if (!wave)
        return { ok: false, reason: `no wave with sequence ${sequence}` };
      if (wave.status !== "failed") {
        return {
          ok: false,
          reason: `only failed waves can be retried (status=${wave.status})`,
        };
      }
      const now = this.clock.now();
      this.db
        .prepare(
          `UPDATE waves SET status = 'in_progress', started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?`,
        )
        .run(now, wave.id);
      this.db
        .prepare(
          "UPDATE rollouts SET status = 'in_progress', pause_reason = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, rolloutId);
      this.recordEvent("wave_retried", {
        rolloutId,
        waveId: wave.id,
        proposalId: rollout.proposalId,
        sequence,
        retriedAt: now,
      });
      return { ok: true, rollout: this.getRollout(rolloutId)! };
    });
    return this.transactional(() => txn());
  }

  rollback(
    rolloutId: string,
    targetVersion: string,
    reason: string,
  ): { ok: true; rollout: Rollout } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; rollout: Rollout } | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };
      if (rollout.status === "succeeded") {
        return { ok: false, reason: "cannot rollback a completed rollout" };
      }
      if (rollout.status === "rolled_back") {
        return { ok: false, reason: "rollout already rolled back" };
      }
      if (!targetVersion)
        return { ok: false, reason: "targetVersion is required" };
      const now = this.clock.now();
      this.db
        .prepare(
          `UPDATE waves SET status = 'rolled_back', finished_at = COALESCE(finished_at, ?)
           WHERE rollout_id = ? AND status IN ('in_progress','pending','paused','failed')`,
        )
        .run(now, rolloutId);
      this.db
        .prepare(
          `UPDATE rollouts SET status = 'rolled_back', pause_reason = NULL, rolled_back_to = ?, rolled_back_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(targetVersion, now, now, rolloutId);
      this.recordEvent("rollout_rolled_back", {
        rolloutId,
        proposalId: rollout.proposalId,
        decisionId: rollout.decisionId,
        candidateHash: rollout.candidateHash,
        targetVersion,
        previousVersion: rollout.previousVersion,
        reason,
        rolledBackAt: now,
      });
      return { ok: true, rollout: this.getRollout(rolloutId)! };
    });
    return this.transactional(() => txn());
  }

  submitVerification(input: {
    rolloutId: string;
    consumerId: string;
    verdict: EvidenceVerdict;
    details: string;
    idempotencyKey: string;
    adapterId?: string;
  }):
    | { ok: true; gap: CoverageGap; rollout: Rollout; duplicate: boolean }
    | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () =>
        | { ok: true; gap: CoverageGap; rollout: Rollout; duplicate: boolean }
        | { ok: false; reason: string }
    >(() => {
      const rollout = this.getRollout(input.rolloutId);
      if (!rollout) return { ok: false, reason: "unknown rollout" };
      if (rollout.status === "succeeded" || rollout.status === "rolled_back") {
        return {
          ok: false,
          reason: `cannot verify on a ${rollout.status} rollout`,
        };
      }

      const gapRow = this.db
        .prepare(
          "SELECT * FROM coverage_gaps WHERE rollout_id = ? AND consumer_id = ?",
        )
        .get(input.rolloutId, input.consumerId) as CoverageGapRow | undefined;
      if (!gapRow) {
        return {
          ok: false,
          reason: `no open coverage gap for consumer "${input.consumerId}" on this rollout`,
        };
      }
      if (gapRow.status !== "open") {
        const existing = this.rowToCoverageGap(gapRow);
        return {
          ok: true,
          gap: existing,
          rollout: this.getRollout(input.rolloutId)!,
          duplicate: true,
        };
      }

      if (
        input.idempotencyKey &&
        gapRow.idempotency_key === input.idempotencyKey
      ) {
        const existing = this.rowToCoverageGap(gapRow);
        return {
          ok: true,
          gap: existing,
          rollout: this.getRollout(input.rolloutId)!,
          duplicate: true,
        };
      }

      if (
        input.verdict !== "compatible" &&
        input.verdict !== "incompatible" &&
        input.verdict !== "error"
      ) {
        return { ok: false, reason: `invalid verdict "${input.verdict}"` };
      }

      const now = this.clock.now();
      const resolvedStatus: CoverageGapStatus =
        input.verdict === "compatible"
          ? "resolved_compatible"
          : "resolved_incompatible";

      this.db
        .prepare(
          `UPDATE coverage_gaps
           SET status = ?, resolved_at = ?, verdict = ?, details = ?, idempotency_key = ?, recorded_at = ?
           WHERE id = ?`,
        )
        .run(
          resolvedStatus,
          now,
          input.verdict,
          input.details,
          input.idempotencyKey,
          now,
          gapRow.id,
        );

      const updatedGap = this.rowToCoverageGap(
        this.db
          .prepare("SELECT * FROM coverage_gaps WHERE id = ?")
          .get(gapRow.id) as CoverageGapRow,
      );

      this.recordEvent("reverification_recorded", {
        rolloutId: input.rolloutId,
        proposalId: rollout.proposalId,
        candidateHash: rollout.candidateHash,
        decisionId: rollout.decisionId,
        consumerId: input.consumerId,
        verdict: input.verdict,
        details: input.details,
        idempotencyKey: input.idempotencyKey,
        adapterId: input.adapterId ?? null,
        recordedAt: now,
      });
      this.recordEvent("coverage_gap_resolved", {
        rolloutId: input.rolloutId,
        proposalId: rollout.proposalId,
        gapId: gapRow.id,
        consumerId: input.consumerId,
        resolution: resolvedStatus,
        verdict: input.verdict,
        resolvedAt: now,
      });

      if (input.verdict !== "compatible") {
        this.db
          .prepare(
            "UPDATE rollouts SET status = 'failed', pause_reason = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now, input.rolloutId);
        const current = rollout.waves.find((w) => w.status === "in_progress");
        if (current) {
          this.db
            .prepare(
              "UPDATE waves SET status = 'failed', finished_at = ? WHERE id = ?",
            )
            .run(now, current.id);
        }
        this.recordEvent("rollout_failed", {
          rolloutId: input.rolloutId,
          proposalId: rollout.proposalId,
          reason: `re-verification by ${input.consumerId} returned ${input.verdict}`,
          failedWave: current?.sequence ?? null,
          finishedAt: now,
        });
      }

      return {
        ok: true,
        gap: updatedGap,
        rollout: this.getRollout(input.rolloutId)!,
        duplicate: false,
      };
    });
    return this.transactional(() => txn());
  }

  private rowToReceipt(row: ReceiptRow, duplicate: boolean): Receipt {
    return {
      id: row.id,
      waveId: row.wave_id,
      proposalId: row.proposal_id,
      candidateHash: row.candidate_hash,
      decisionId: row.decision_id,
      result: row.result as ReceiptResult,
      adapterId: row.adapter_id,
      idempotencyKey: row.idempotency_key,
      message: row.message,
      recordedAt: row.recorded_at,
      duplicate,
    };
  }

  listReceipts(waveId: string): Receipt[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM receipts WHERE wave_id = ? ORDER BY recorded_at ASC",
      )
      .all(waveId) as ReceiptRow[];
    return rows.map((r) => this.rowToReceipt(r, false));
  }

  decide(
    proposalId: string,
    action: "approve" | "reject",
    reason: string,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const txn = this.db.transaction<
      () => { ok: true; decision: Decision } | { ok: false; reason: string }
    >(() => {
      this.sweepExpiredExemptions();
      const now = this.clock.now();
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { ok: false, reason: "unknown proposal" };
      if (proposal.status === "superseded") {
        return {
          ok: false,
          reason: "proposal has been superseded; decide on the latest revision",
        };
      }
      if (proposal.status !== "pending") {
        return {
          ok: false,
          reason: `proposal already ${proposal.status}; decisions are immutable`,
        };
      }
      const snapshot = this.buildSnapshot(proposal, now);
      if (action === "approve" && !snapshot.gateReady) {
        return {
          ok: false,
          reason: `cannot approve: ${snapshot.blockingReasons.join("; ")}`,
        };
      }
      const newStatus = action === "approve" ? "approved" : "rejected";
      const decidedAt = now;
      const decisionId = randomUUID();

      const updateResult = this.db
        .prepare(
          "UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'",
        )
        .run(newStatus, proposalId);
      if (updateResult.changes !== 1) {
        return {
          ok: false,
          reason: "concurrent decision detected; proposal already decided",
        };
      }

      try {
        this.db
          .prepare(
            `INSERT INTO decisions (id, proposal_id, decision, reason, snapshot, decided_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decisionId,
            proposalId,
            newStatus,
            reason,
            JSON.stringify(snapshot),
            decidedAt,
          );
      } catch (err) {
        throw new Error(`decision conflict: ${(err as Error).message}`);
      }

      const updated = this.getProposal(proposalId)!;
      this.recordEvent("decision_made", {
        proposalId,
        decision: newStatus,
        reason,
        gateReady: snapshot.gateReady,
        missingConsumerIds: snapshot.missingConsumerIds,
        exemptedConsumerIds: snapshot.exemptedConsumerIds,
        appliedExemptionIds: snapshot.appliedExemptions.map((e) => e.id),
        evidenceCount: snapshot.evidence.length,
      });

      const decision: Decision = {
        id: decisionId,
        proposalId,
        decision: newStatus,
        reason,
        snapshot: { ...snapshot, proposal: updated },
        decidedAt,
      };
      return { ok: true, decision };
    });

    return this.transactional(() => txn());
  }

  getDecision(proposalId: string): Decision | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE proposal_id = ?")
      .get(proposalId) as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  listEvents(): CausalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM causal_events ORDER BY id ASC")
      .all() as Array<{
      id: number;
      type: CausalEventType;
      payload: string;
      clock: number;
      recorded_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      clock: r.clock,
      recordedAt: r.recorded_at,
    }));
  }

  recover(): {
    proposals: Proposal[];
    consumers: Consumer[];
    exemptions: Exemption[];
    events: CausalEvent[];
    lamport: number;
  } {
    return {
      proposals: this.listProposals(),
      consumers: this.listConsumers(),
      exemptions: this.listExemptions(),
      events: this.listEvents(),
      lamport: this.lamport,
    };
  }
}

function rowToConsumer(row: ConsumerRow): Consumer {
  return { id: row.id, name: row.name, registeredAt: row.registered_at };
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    candidateHash: row.candidate_hash,
    candidateSchema: JSON.parse(row.candidate_schema) as Record<
      string,
      unknown
    >,
    baselineSchema: JSON.parse(row.baseline_schema) as Record<string, unknown>,
    systemCompatibility: {
      compatible: row.system_compatible === 1,
      issues: JSON.parse(row.system_issues) as CompatibilityIssueShape[],
    },
    status: row.status,
    environment: row.environment ?? "production",
    parentProposalId: row.parent_proposal_id,
    replacesCandidateHash: row.replaces_candidate_hash,
    lineageRootId: row.lineage_root_id,
    revision: row.revision,
    createdAt: row.created_at,
  };
}

function rowToEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    consumerId: row.consumer_id,
    candidateHash: row.candidate_hash,
    verdict: row.verdict,
    details: row.details,
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at,
    late: row.late === 1,
  };
}

function rowToExemption(row: ExemptionRow): Exemption {
  return {
    id: row.id,
    candidateHash: row.candidate_hash,
    consumerId: row.consumer_id,
    environment: row.environment,
    direction: row.direction,
    reason: row.reason,
    requesterId: row.requester_id,
    confirmerId: row.confirmer_id,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closeNote: row.close_note,
  };
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    decision: row.decision,
    reason: row.reason,
    snapshot: JSON.parse(row.snapshot) as DecisionSnapshot,
    decidedAt: row.decided_at,
  };
}

interface CompatibilityIssueShape {
  code: string;
  message: string;
  path: string;
}
