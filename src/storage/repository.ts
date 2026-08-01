import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type { Clock } from '../domain/clock.js';
import {
  evaluateGate,
  validateExemptionClosure,
  validateExemptionConfirmation,
  validateExemptionRequest,
} from '../domain/gate.js';
import { stableHash } from '../domain/hash.js';
import { checkBackwardCompatibility } from '../domain/compatibility.js';
import type {
  CausalEvent,
  CausalEventType,
  Consumer,
  Decision,
  DecisionSnapshot,
  EvidenceAcceptance,
  EvidenceRecord,
  EvidenceSubmission,
  Exemption,
  ExemptionDirection,
  ExemptionRequest,
  ExemptionStatus,
  FrozenExemption,
  Proposal,
  ProposalDetail,
  ProposalStatus,
} from '../domain/types.js';

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
  created_at: number;
}

interface EvidenceRow {
  id: string;
  proposal_id: string;
  consumer_id: string;
  candidate_hash: string;
  verdict: 'compatible' | 'incompatible' | 'error';
  details: string;
  idempotency_key: string;
  recorded_at: number;
}

interface ConsumerRow {
  id: string;
  name: string;
  registered_at: number;
}

interface DecisionRow {
  id: string;
  proposal_id: string;
  decision: 'approved' | 'rejected';
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

export class Repository {
  private clock: Clock;
  private lamport: number;
  private eventSink?: (event: CausalEvent) => void;
  private buffering = false;
  private buffer: CausalEvent[] = [];

  constructor(private db: DB, opts: RepositoryOptions) {
    this.clock = opts.clock;
    this.eventSink = opts.eventSink;
    const row = db.prepare('SELECT MAX(clock) AS m FROM causal_events').get() as { m: number | null };
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

  private recordEvent(type: CausalEventType, payload: Record<string, unknown>): CausalEvent {
    const clock = this.tick();
    const recordedAt = this.clock.now();
    const info = this.db
      .prepare(
        'INSERT INTO causal_events (type, payload, clock, recorded_at) VALUES (?, ?, ?, ?)',
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
    const existing = this.getConsumer(id);
    if (existing) return existing;
    const registeredAt = this.clock.now();
    this.db
      .prepare('INSERT INTO consumers (id, name, registered_at) VALUES (?, ?, ?)')
      .run(id, name, registeredAt);
    this.recordEvent('consumer_registered', { consumerId: id, name });
    return { id, name, registeredAt };
  }

  getConsumer(id: string): Consumer | null {
    const row = this.db.prepare('SELECT * FROM consumers WHERE id = ?').get(id) as
      | ConsumerRow
      | undefined;
    return row ? rowToConsumer(row) : null;
  }

  listConsumers(): Consumer[] {
    const rows = this.db.prepare('SELECT * FROM consumers ORDER BY registered_at ASC').all() as ConsumerRow[];
    return rows.map(rowToConsumer);
  }

  createProposal(
    candidateSchema: Record<string, unknown>,
    baselineSchema: Record<string, unknown>,
    environment = 'production',
  ): { proposal: Proposal; duplicate: boolean } {
    const candidateHash = stableHash(candidateSchema);
    const existing = this.db
      .prepare('SELECT * FROM proposals WHERE candidate_hash = ?')
      .get(candidateHash) as ProposalRow | undefined;
    if (existing) {
      return { proposal: rowToProposal(existing), duplicate: true };
    }
    const systemCompatibility = checkBackwardCompatibility(baselineSchema, candidateSchema);
    const id = randomUUID();
    const createdAt = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO proposals
          (id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues, status, environment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        candidateHash,
        JSON.stringify(candidateSchema),
        JSON.stringify(baselineSchema),
        systemCompatibility.compatible ? 1 : 0,
        JSON.stringify(systemCompatibility.issues),
        environment,
        createdAt,
      );
    const proposal = this.getProposal(id)!;
    this.recordEvent('proposal_created', {
      proposalId: id,
      candidateHash,
      environment,
      systemCompatible: systemCompatibility.compatible,
      issueCount: systemCompatibility.issues.length,
    });
    return { proposal, duplicate: false };
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
    return row ? rowToProposal(row) : null;
  }

  getProposalByHash(hash: string): Proposal | null {
    const row = this.db.prepare('SELECT * FROM proposals WHERE candidate_hash = ?').get(hash) as
      | ProposalRow
      | undefined;
    return row ? rowToProposal(row) : null;
  }

  listProposals(): Proposal[] {
    const rows = this.db.prepare('SELECT * FROM proposals ORDER BY created_at ASC').all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  submitEvidence(submission: EvidenceSubmission): EvidenceAcceptance {
    const txn = this.db.transaction((sub: EvidenceSubmission): EvidenceAcceptance => {
      const proposal = this.getProposal(sub.proposalId);
      const knownConsumers = new Set(this.listConsumers().map((c) => c.id));

      if (!proposal) {
        this.recordEvent('evidence_rejected', {
          reason: 'unknown proposal',
          consumerId: sub.consumerId,
          proposalId: sub.proposalId,
          idempotencyKey: sub.idempotencyKey,
        });
        return { accepted: false, reason: 'unknown proposal', evidence: null };
      }
      if (!knownConsumers.has(sub.consumerId)) {
        this.recordEvent('evidence_rejected', {
          reason: 'unknown consumer',
          consumerId: sub.consumerId,
          proposalId: sub.proposalId,
          idempotencyKey: sub.idempotencyKey,
        });
        return { accepted: false, reason: `unknown consumer "${sub.consumerId}"`, evidence: null };
      }
      if (sub.candidateHash !== proposal.candidateHash) {
        this.recordEvent('evidence_rejected', {
          reason: 'candidate hash mismatch',
          consumerId: sub.consumerId,
          proposalId: sub.proposalId,
          idempotencyKey: sub.idempotencyKey,
          evidenceHash: sub.candidateHash,
          proposalHash: proposal.candidateHash,
        });
        return {
          accepted: false,
          reason: 'candidate hash mismatch; late result for a different proposal',
          evidence: null,
        };
      }
      if (proposal.status !== 'pending') {
        this.recordEvent('evidence_rejected', {
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

      const existing = this.db
        .prepare('SELECT * FROM evidence WHERE proposal_id = ? AND consumer_id = ?')
        .get(sub.proposalId, sub.consumerId) as EvidenceRow | undefined;

      if (existing && existing.idempotency_key === sub.idempotencyKey) {
        return { accepted: true, evidence: rowToEvidence(existing), deduped: true };
      }

      const recordedAt = this.clock.now();
      if (existing) {
        this.db
          .prepare(
            `UPDATE evidence
             SET verdict = ?, details = ?, idempotency_key = ?, recorded_at = ?, candidate_hash = ?
             WHERE id = ?`,
          )
          .run(sub.verdict, sub.details, sub.idempotencyKey, recordedAt, sub.candidateHash, existing.id);
        const updated = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(existing.id) as EvidenceRow;
        const evidence = rowToEvidence(updated);
        this.recordEvent('evidence_accepted', {
          proposalId: sub.proposalId,
          consumerId: sub.consumerId,
          verdict: sub.verdict,
          idempotencyKey: sub.idempotencyKey,
          deduped: false,
          updated: true,
        });
        return { accepted: true, evidence, deduped: false };
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO evidence
            (id, proposal_id, consumer_id, candidate_hash, verdict, details, idempotency_key, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as EvidenceRow;
      const evidence = rowToEvidence(row);
      this.recordEvent('evidence_accepted', {
        proposalId: sub.proposalId,
        consumerId: sub.consumerId,
        verdict: sub.verdict,
        idempotencyKey: sub.idempotencyKey,
        deduped: false,
        updated: false,
      });
      return { accepted: true, evidence, deduped: false };
    });

    return this.transactional(() => txn(submission));
  }

  listEvidence(proposalId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE proposal_id = ? ORDER BY recorded_at ASC')
      .all(proposalId) as EvidenceRow[];
    return rows.map(rowToEvidence);
  }

  getExemption(id: string): Exemption | null {
    const row = this.db.prepare('SELECT * FROM exemptions WHERE id = ?').get(id) as
      | ExemptionRow
      | undefined;
    return row ? rowToExemption(row) : null;
  }

  listExemptions(candidateHash?: string): Exemption[] {
    const rows = candidateHash
      ? (this.db
          .prepare('SELECT * FROM exemptions WHERE candidate_hash = ? ORDER BY created_at ASC')
          .all(candidateHash) as ExemptionRow[])
      : (this.db.prepare('SELECT * FROM exemptions ORDER BY created_at ASC').all() as ExemptionRow[]);
    return rows.map(rowToExemption);
  }

  sweepExpiredExemptions(): Exemption[] {
    const now = this.clock.now();
    const expired: Exemption[] = [];
    const run = (): Exemption[] => {
      const rows = this.db
        .prepare("SELECT * FROM exemptions WHERE status = 'active' AND valid_until < ?")
        .all(now) as ExemptionRow[];
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE exemptions SET status = 'expired', closed_at = ?, closed_by = ?, close_note = ? WHERE id = ? AND status = 'active'`,
          )
          .run(now, 'system:expiry', `expired at ${now} (valid_until=${row.valid_until})`, row.id);
        const ex = rowToExemption({ ...row, status: 'expired', closed_at: now, closed_by: 'system:expiry' });
        expired.push(ex);
        this.recordEvent('exemption_expired', {
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
    const validation = validateExemptionRequest(req, knownConsumers, this.clock.now());
    if (!validation.ok) return { ok: false, reason: validation.reason! };

    const candidate = this.getProposalByHash(req.candidateHash);
    if (!candidate) return { ok: false, reason: 'unknown candidate hash' };

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
      return { ok: false, reason: `an open exemption already exists for this candidate/consumer/environment/direction: ${(err as Error).message}` };
    }

    const exemption = this.getExemption(id)!;
    this.recordEvent('exemption_requested', {
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
      if (!ex) return { ok: false as const, reason: 'unknown exemption' };
      const validation = validateExemptionConfirmation(ex, confirmerId);
      if (!validation.ok) return { ok: false as const, reason: validation.reason! };

      const confirmedAt = this.clock.now();
      this.db
        .prepare("UPDATE exemptions SET status = 'active', confirmer_id = ?, confirmed_at = ? WHERE id = ?")
        .run(confirmerId, confirmedAt, id);
      const updated = this.getExemption(id)!;
      this.recordEvent('exemption_confirmed', {
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
    action: 'reject' | 'revoke',
    note: string,
  ): { ok: true; exemption: Exemption } | { ok: false; reason: string } {
    const txn = this.db.transaction(() => {
      const ex = this.getExemption(id);
      if (!ex) return { ok: false as const, reason: 'unknown exemption' };
      const validation = validateExemptionClosure(ex, reviewerId, action);
      if (!validation.ok) return { ok: false as const, reason: validation.reason! };

      const closedAt = this.clock.now();
      const status = action === 'reject' ? 'rejected' : 'revoked';
      this.db
        .prepare(
          `UPDATE exemptions SET status = ?, closed_at = ?, closed_by = ?, close_note = ? WHERE id = ?`,
        )
        .run(status, closedAt, reviewerId, note, id);
      const updated = this.getExemption(id)!;
      this.recordEvent(action === 'reject' ? 'exemption_rejected' : 'exemption_revoked', {
        exemptionId: id,
        candidateHash: ex.candidateHash,
        consumerId: ex.consumerId,
        environment: ex.environment,
        direction: ex.direction,
        reviewerId,
        note,
        closedAt,
      });
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
    const requiredConsumerIds = this.listConsumers().map((c) => c.id).sort();
    const exemptions = this.listExemptions(proposal.candidateHash);
    const evaluation = evaluateGate(proposal, evidence, requiredConsumerIds, exemptions, now);
    return {
      proposal,
      evidence,
      requiredConsumerIds,
      missingConsumerIds: evaluation.missingConsumerIds,
      exemptedConsumerIds: evaluation.exemptedConsumerIds,
      appliedExemptions: evaluation.appliedExemptions.map((e) => this.freezeExemption(e)),
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
    const requiredConsumerIds = this.listConsumers().map((c) => c.id).sort();
    const exemptions = this.listExemptions(proposal.candidateHash);
    const evaluation = evaluateGate(proposal, evidence, requiredConsumerIds, exemptions, now);
    const decision = this.getDecision(id);
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
    };
  }

  decide(
    proposalId: string,
    action: 'approve' | 'reject',
    reason: string,
  ): { ok: true; decision: Decision } | { ok: false; reason: string } {
    const txn = this.db.transaction<() => { ok: true; decision: Decision } | { ok: false; reason: string }>(() => {
      this.sweepExpiredExemptions();
      const now = this.clock.now();
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { ok: false, reason: 'unknown proposal' };
      if (proposal.status !== 'pending') {
        return { ok: false, reason: `proposal already ${proposal.status}; decisions are immutable` };
      }
      const snapshot = this.buildSnapshot(proposal, now);
      if (action === 'approve' && !snapshot.gateReady) {
        return { ok: false, reason: `cannot approve: ${snapshot.blockingReasons.join('; ')}` };
      }
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      const decidedAt = now;
      const decisionId = randomUUID();

      const updateResult = this.db
        .prepare("UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'")
        .run(newStatus, proposalId);
      if (updateResult.changes !== 1) {
        return { ok: false, reason: 'concurrent decision detected; proposal already decided' };
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
      this.recordEvent('decision_made', {
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
    const row = this.db.prepare('SELECT * FROM decisions WHERE proposal_id = ?').get(proposalId) as
      | DecisionRow
      | undefined;
    return row ? rowToDecision(row) : null;
  }

  listEvents(): CausalEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM causal_events ORDER BY id ASC')
      .all() as Array<{ id: number; type: CausalEventType; payload: string; clock: number; recorded_at: number }>;
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
    candidateSchema: JSON.parse(row.candidate_schema) as Record<string, unknown>,
    baselineSchema: JSON.parse(row.baseline_schema) as Record<string, unknown>,
    systemCompatibility: {
      compatible: row.system_compatible === 1,
      issues: JSON.parse(row.system_issues) as CompatibilityIssueShape[],
    },
    status: row.status,
    environment: row.environment ?? 'production',
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
