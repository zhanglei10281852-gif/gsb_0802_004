import type { DB } from './schema.js';
import { EventLog } from './event-log.js';
import type { Clock } from '../core/clock.js';
import {
  ConflictError,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  ValidationError,
} from '../core/errors.js';
import { digestString, shortDigest } from '../core/digest.js';
import {
  REQUIRED_EXEMPTION_APPROVALS,
  effectiveExemptionStatus,
  isExemptionApproved,
} from '../core/exemption.js';
import type {
  CausalEvent,
  ExemptionDirection,
  ExemptionRecord,
  ExemptionReview,
  ExemptionStatus,
} from '../core/types.js';

interface ExemptionRow {
  exemption_id: string;
  proposal_id: string;
  candidate_digest: string;
  consumer_id: string;
  environment: string;
  direction: string;
  reason: string;
  requested_by: string;
  requested_at: number;
  expires_at: number;
  status: string;
  reviews_json: string;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface RequestExemptionInput {
  proposalId: string;
  consumerId: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  ttlMs: number;
}

export interface ReviewExemptionInput {
  exemptionId: string;
  reviewer: string;
  approved: boolean;
  comment: string;
}

function rowToExemption(row: ExemptionRow, now: number): ExemptionRecord {
  const reviews = JSON.parse(row.reviews_json) as ExemptionReview[];
  const stored = row.status as ExemptionStatus;
  return {
    exemptionId: row.exemption_id,
    proposalId: row.proposal_id,
    candidateDigest: row.candidate_digest,
    consumerId: row.consumer_id,
    environment: row.environment,
    direction: row.direction as ExemptionDirection,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    status:
      stored === 'approved' && now > row.expires_at ? 'expired' : stored,
    reviews,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

export class ExemptionRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly events: EventLog,
  ) {}

  private pending: CausalEvent[] = [];

  drainEvents(): CausalEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private append(
    proposalId: string,
    occurredAt: number,
    eventType: CausalEvent['eventType'],
    payload: unknown,
  ): CausalEvent {
    const event = this.events.append(proposalId, occurredAt, eventType, payload);
    this.pending.push(event);
    return event;
  }

  request(input: RequestExemptionInput): ExemptionRecord {
    const now = this.clock.now();
    const proposal = this.db
      .prepare('SELECT * FROM proposals WHERE proposal_id = ?')
      .get(input.proposalId) as { status: string; candidate_digest: string } | undefined;
    if (!proposal) throw new ProposalNotFoundError(input.proposalId);
    if (proposal.status === 'approved' || proposal.status === 'rejected') {
      throw new ProposalAlreadyDecidedError(input.proposalId);
    }
    if (!['backward', 'forward', 'both'].includes(input.direction)) {
      throw new ValidationError('direction must be backward, forward, or both');
    }
    if (!input.environment || typeof input.environment !== 'string') {
      throw new ValidationError('environment is required');
    }
    if (!input.reason || typeof input.reason !== 'string') {
      throw new ValidationError('reason is required');
    }
    if (!input.consumerId || typeof input.consumerId !== 'string') {
      throw new ValidationError('consumerId is required');
    }
    if (input.ttlMs <= 0) {
      throw new ValidationError('ttlMs must be positive');
    }

    const known = this.db
      .prepare('SELECT consumers_json FROM proposals WHERE proposal_id = ?')
      .get(input.proposalId) as { consumers_json: string };
    const consumers = JSON.parse(known.consumers_json) as { consumerId: string }[];
    if (!consumers.some((c) => c.consumerId === input.consumerId)) {
      throw new ValidationError(`unknown consumer: ${input.consumerId}`);
    }

    const exemptionId = `ex_${shortDigest({
      p: input.proposalId,
      c: input.consumerId,
      e: input.environment,
      d: input.direction,
      t: now,
    })}`;
    const expiresAt = now + input.ttlMs;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO exemptions
            (exemption_id, proposal_id, candidate_digest, consumer_id, environment, direction, reason,
             requested_by, requested_at, expires_at, status, reviews_json, revoked_at, revoked_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', NULL, NULL)`,
        )
        .run(
          exemptionId,
          input.proposalId,
          proposal.candidate_digest,
          input.consumerId,
          input.environment,
          input.direction,
          input.reason,
          input.requestedBy,
          now,
          expiresAt,
        );
      this.append(input.proposalId, now, 'exemption-requested', {
        exemptionId,
        candidateDigest: proposal.candidate_digest,
        consumerId: input.consumerId,
        environment: input.environment,
        direction: input.direction,
        requestedBy: input.requestedBy,
        expiresAt,
        reason: input.reason,
      });
    })();

    return this.getById(exemptionId)!;
  }

  review(input: ReviewExemptionInput): ExemptionRecord {
    const now = this.clock.now();
    const row = this.db
      .prepare('SELECT * FROM exemptions WHERE exemption_id = ?')
      .get(input.exemptionId) as ExemptionRow | undefined;
    if (!row) {
      throw new ValidationError(`exemption not found: ${input.exemptionId}`);
    }

    if (row.status !== 'pending') {
      throw new ConflictError(`exemption is ${row.status}, cannot review`);
    }
    if (input.reviewer === row.requested_by) {
      throw new ConflictError('the requester cannot review their own exemption');
    }

    const reviews = JSON.parse(row.reviews_json) as ExemptionReview[];
    if (reviews.some((r) => r.reviewer === input.reviewer)) {
      throw new ConflictError(`reviewer ${input.reviewer} has already reviewed this exemption`);
    }

    reviews.push({
      reviewer: input.reviewer,
      reviewedAt: now,
      approved: input.approved,
      comment: input.comment,
    });

    const nextStatus: ExemptionStatus = input.approved
      ? reviews.filter((r) => r.approved).length >= REQUIRED_EXEMPTION_APPROVALS
        ? 'approved'
        : 'pending'
      : 'rejected';

    this.db.transaction(() => {
      this.db
        .prepare('UPDATE exemptions SET reviews_json = ?, status = ? WHERE exemption_id = ?')
        .run(JSON.stringify(reviews), nextStatus, input.exemptionId);
      if (input.approved) {
        this.append(row.proposal_id, now, 'exemption-approved', {
          exemptionId: input.exemptionId,
          reviewer: input.reviewer,
          approvalCount: reviews.filter((r) => r.approved).length,
          requiredApprovals: REQUIRED_EXEMPTION_APPROVALS,
          active: nextStatus === 'approved',
        });
      } else {
        this.append(row.proposal_id, now, 'exemption-rejected', {
          exemptionId: input.exemptionId,
          reviewer: input.reviewer,
          comment: input.comment,
        });
      }
    })();

    return this.getById(input.exemptionId)!;
  }

  revoke(exemptionId: string, revokedBy: string): ExemptionRecord {
    const now = this.clock.now();
    const row = this.db
      .prepare('SELECT * FROM exemptions WHERE exemption_id = ?')
      .get(exemptionId) as ExemptionRow | undefined;
    if (!row) throw new ValidationError(`exemption not found: ${exemptionId}`);
    if (row.status === 'revoked' || row.status === 'rejected') {
      throw new ConflictError(`exemption is already ${row.status}`);
    }
    const proposal = this.db
      .prepare('SELECT status FROM proposals WHERE proposal_id = ?')
      .get(row.proposal_id) as { status: string };
    if (proposal.status === 'approved' || proposal.status === 'rejected') {
      throw new ConflictError('cannot revoke an exemption after a decision is recorded');
    }

    this.db.transaction(() => {
      this.revokeRow(row, now, revokedBy, 'manual-revocation');
    })();
    return this.getById(exemptionId)!;
  }

  revokeAllForProposal(
    proposalId: string,
    revokedBy: string,
    reason: string,
    now: number = this.clock.now(),
  ): ExemptionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM exemptions
         WHERE proposal_id = ? AND status IN ('pending','approved')`,
      )
      .all(proposalId) as ExemptionRow[];
    if (rows.length === 0) return [];
    const revoked: ExemptionRecord[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        this.revokeRow(row, now, revokedBy, reason);
        const rec = this.getById(row.exemption_id);
        if (rec) revoked.push(rec);
      }
    })();
    return revoked;
  }

  private revokeRow(
    row: ExemptionRow,
    now: number,
    revokedBy: string,
    reason: string,
  ): void {
    this.db
      .prepare(
        'UPDATE exemptions SET status = ?, revoked_at = ?, revoked_by = ? WHERE exemption_id = ?',
      )
      .run('revoked', now, revokedBy, row.exemption_id);
    this.append(row.proposal_id, now, 'exemption-revoked', {
      exemptionId: row.exemption_id,
      revokedBy,
      reason,
    });
  }

  getById(exemptionId: string): ExemptionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM exemptions WHERE exemption_id = ?')
      .get(exemptionId) as ExemptionRow | undefined;
    return row ? rowToExemption(row, this.clock.now()) : null;
  }

  listForProposal(proposalId: string): ExemptionRecord[] {
    const now = this.clock.now();
    const rows = this.db
      .prepare('SELECT * FROM exemptions WHERE proposal_id = ? ORDER BY requested_at ASC')
      .all(proposalId) as ExemptionRow[];
    return rows.map((r) => rowToExemption(r, now));
  }

  listEffectiveForProposal(proposalId: string): ExemptionRecord[] {
    const now = this.clock.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM exemptions
         WHERE proposal_id = ? AND status = 'approved' AND expires_at > ?
         ORDER BY requested_at ASC`,
      )
      .all(proposalId, now) as ExemptionRow[];
    return rows.map((r) => rowToExemption(r, now));
  }

  isApprovedForScope(
    proposalId: string,
    candidateDigest: string,
    consumerId: string,
    environment: string,
    direction: ExemptionDirection,
    now: number = this.clock.now(),
  ): ExemptionRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM exemptions
         WHERE proposal_id = ? AND candidate_digest = ? AND consumer_id = ?
           AND environment = ? AND status = 'approved' AND expires_at > ?`,
      )
      .all(proposalId, candidateDigest, consumerId, environment, now) as ExemptionRow[];
    for (const row of rows) {
      if (row.direction === direction || row.direction === 'both') {
        return rowToExemption(row, now);
      }
    }
    return undefined;
  }

  static isApproved(exemption: ExemptionRecord): boolean {
    return isExemptionApproved(exemption);
  }

  static effectiveStatus(exemption: ExemptionRecord, now: number): ExemptionStatus {
    return effectiveExemptionStatus(exemption, now);
  }
}

export { digestString };
