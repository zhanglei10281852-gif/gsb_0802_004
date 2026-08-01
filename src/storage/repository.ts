import { randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type { Clock } from '../domain/clock.js';
import { evaluateGate } from '../domain/gate.js';
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
          (id, candidate_hash, candidate_schema, baseline_schema, system_compatible, system_issues, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        candidateHash,
        JSON.stringify(candidateSchema),
        JSON.stringify(baselineSchema),
        systemCompatibility.compatible ? 1 : 0,
        JSON.stringify(systemCompatibility.issues),
        createdAt,
      );
    const proposal = this.getProposal(id)!;
    this.recordEvent('proposal_created', {
      proposalId: id,
      candidateHash,
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

  private buildSnapshot(proposal: Proposal): DecisionSnapshot {
    const evidence = this.listEvidence(proposal.id);
    const requiredConsumerIds = this.listConsumers().map((c) => c.id).sort();
    const evaluation = evaluateGate(proposal, evidence, requiredConsumerIds);
    return {
      proposal,
      evidence,
      requiredConsumerIds,
      missingConsumerIds: evaluation.missingConsumerIds,
      gateReady: evaluation.gateReady,
      blockingReasons: evaluation.blockingReasons,
      systemCompatibility: proposal.systemCompatibility,
    };
  }

  getProposalDetail(id: string): ProposalDetail | null {
    const proposal = this.getProposal(id);
    if (!proposal) return null;
    const evidence = this.listEvidence(id);
    const requiredConsumerIds = this.listConsumers().map((c) => c.id).sort();
    const evaluation = evaluateGate(proposal, evidence, requiredConsumerIds);
    const decision = this.getDecision(id);
    return {
      proposal,
      evidence,
      requiredConsumerIds,
      missingConsumerIds: evaluation.missingConsumerIds,
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
      const proposal = this.getProposal(proposalId);
      if (!proposal) return { ok: false, reason: 'unknown proposal' };
      if (proposal.status !== 'pending') {
        return { ok: false, reason: `proposal already ${proposal.status}; decisions are immutable` };
      }
      const snapshot = this.buildSnapshot(proposal);
      if (action === 'approve' && !snapshot.gateReady) {
        return { ok: false, reason: `cannot approve: ${snapshot.blockingReasons.join('; ')}` };
      }
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      const decidedAt = this.clock.now();
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

  recover(): { proposals: Proposal[]; consumers: Consumer[]; events: CausalEvent[]; lamport: number } {
    return {
      proposals: this.listProposals(),
      consumers: this.listConsumers(),
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
