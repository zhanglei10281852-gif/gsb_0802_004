import type { DB } from './schema.js';
import { EventLog } from './event-log.js';
import type { Clock } from '../core/clock.js';
import {
  ConflictError,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  ValidationError,
} from '../core/errors.js';
import { digestString } from '../core/digest.js';
import {
  applyReceipt,
  buildRolloutSnapshot,
  buildWaves,
  getCurrentWave,
  getWave,
  isTerminal,
  makeRolloutId,
  pauseRollout,
  resumeRollout,
  retryWave,
  rollback,
  startRollout,
} from '../core/rollout.js';
import type {
  CausalEvent,
  CreateRolloutInput,
  DecisionSnapshot,
  ProposalId,
  ReceiptInput,
  ReceiptResult,
  RolloutId,
  StoredProposal,
  StoredRollout,
  Wave,
} from '../core/types.js';
import type { ProposalRepository } from './repository.js';

interface RolloutRow {
  rollout_id: string;
  proposal_id: string;
  topic: string;
  status: string;
  owner: string;
  created_at: number;
  started_at: number | null;
  paused_at: number | null;
  finished_at: number | null;
  current_wave_sequence: number;
  previous_version: string | null;
  rollback_target_wave_id: string | null;
  rolled_back_at: number | null;
  note: string | null;
  snapshot_json: string;
  waves_json: string;
  expected_version: number;
}

interface ReceiptRow {
  receipt_id: string;
  rollout_id: string;
  wave_id: string;
  wave_sequence: number;
  result: ReceiptResult;
  message: string;
  reported_at: number;
  received_at: number;
  idempotency_key: string;
  adapter_run_id: string;
}

function rowToRollout(
  row: RolloutRow,
  receipts: ReceiptRow[],
): StoredRollout {
  return {
    rolloutId: row.rollout_id,
    proposalId: row.proposal_id,
    topic: row.topic,
    status: row.status as StoredRollout['status'],
    owner: row.owner,
    createdAt: row.created_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    finishedAt: row.finished_at,
    currentWaveSequence: row.current_wave_sequence,
    previousVersion: row.previous_version,
    rollbackTargetWaveId: row.rollback_target_wave_id,
    rolledBackAt: row.rolled_back_at,
    note: row.note,
    snapshot: JSON.parse(row.snapshot_json),
    waves: JSON.parse(row.waves_json) as Wave[],
    receipts: receipts.map((r) => ({
      receiptId: r.receipt_id,
      rolloutId: r.rollout_id,
      waveId: r.wave_id,
      waveSequence: r.wave_sequence,
      result: r.result,
      message: r.message,
      reportedAt: r.reported_at,
      receivedAt: r.received_at,
      idempotencyKey: r.idempotency_key,
      adapterRunId: r.adapter_run_id,
    })),
  };
}

export interface ReceiptResult2 {
  accepted: boolean;
  deduped: boolean;
  reason?: string;
  rollout: StoredRollout;
}

export class RolloutRepository {
  readonly events: EventLog;
  private pending: CausalEvent[] = [];

  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
    private readonly proposals: ProposalRepository,
    events: EventLog,
  ) {
    this.events = events;
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
    proposalId: ProposalId,
    occurredAt: number,
    eventType: CausalEvent['eventType'],
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

  private persist(rollout: StoredRollout): void {
    this.db
      .prepare(
        `UPDATE rollouts
         SET status = ?, started_at = ?, paused_at = ?, finished_at = ?, current_wave_sequence = ?,
             previous_version = ?, rollback_target_wave_id = ?, rolled_back_at = ?, note = ?,
             waves_json = ?, expected_version = expected_version + 1
         WHERE rollout_id = ?`,
      )
      .run(
        rollout.status,
        rollout.startedAt,
        rollout.pausedAt,
        rollout.finishedAt,
        rollout.currentWaveSequence,
        rollout.previousVersion,
        rollout.rollbackTargetWaveId,
        rollout.rolledBackAt,
        rollout.note,
        JSON.stringify(rollout.waves),
        rollout.rolloutId,
      );
  }

  getById(rolloutId: RolloutId): StoredRollout | null {
    const row = this.db
      .prepare('SELECT * FROM rollouts WHERE rollout_id = ?')
      .get(rolloutId) as RolloutRow | undefined;
    if (!row) return null;
    return rowToRollout(row, this.getReceipts(rolloutId));
  }

  requireById(rolloutId: RolloutId): StoredRollout {
    const r = this.getById(rolloutId);
    if (!r) throw new ProposalNotFoundError(`rollout ${rolloutId}`);
    return r;
  }

  listForProposal(proposalId: ProposalId): StoredRollout[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM rollouts WHERE proposal_id = ? ORDER BY created_at DESC',
      )
      .all(proposalId) as RolloutRow[];
    return rows.map((row) => rowToRollout(row, this.getReceipts(row.rollout_id)));
  }

  listActive(): StoredRollout[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM rollouts WHERE status IN ('planned','active','paused') ORDER BY created_at ASC`,
      )
      .all() as RolloutRow[];
    return rows.map((row) => rowToRollout(row, this.getReceipts(row.rollout_id)));
  }

  private getReceipts(rolloutId: RolloutId): ReceiptRow[] {
    return this.db
      .prepare(
        'SELECT * FROM rollout_receipts WHERE rollout_id = ? ORDER BY received_at ASC, receipt_id ASC',
      )
      .all(rolloutId) as ReceiptRow[];
  }

  create(input: CreateRolloutInput): {
    rollout: StoredRollout;
    proposal: StoredProposal;
  } {
    if (!input.waves || input.waves.length === 0) {
      throw new ValidationError('at least one wave is required');
    }
    for (const w of input.waves) {
      if (!w.environment || typeof w.environment !== 'string') {
        throw new ValidationError('each wave needs an environment');
      }
      if (!w.adapter || typeof w.adapter !== 'string') {
        throw new ValidationError('each wave needs an adapter');
      }
    }
    const proposal = this.proposals.requireById(input.proposalId);
    if (proposal.status !== 'approved' || !proposal.decision) {
      throw new ConflictError(
        'a rollout can only be created from an approved proposal',
      );
    }
    if (proposal.decision.kind !== 'approve') {
      throw new ConflictError(
        'a rollout can only be created from an approved (not rejected) decision',
      );
    }
    const existing = this.db
      .prepare(
        `SELECT rollout_id FROM rollouts WHERE proposal_id = ? AND status IN ('planned','active','paused')`,
      )
      .get(input.proposalId);
    if (existing) {
      throw new ConflictError(
        'an active rollout already exists for this proposal',
      );
    }

    const decision = proposal.decision as DecisionSnapshot;
    const now = this.clock.now();
    const snapshot = buildRolloutSnapshot(proposal.proposalId, decision);
    const rolloutId = makeRolloutId(proposal.topic, snapshot, input.owner, now);
    const waves = buildWaves(rolloutId, input.waves);

    const rollout: StoredRollout = {
      rolloutId,
      proposalId: proposal.proposalId,
      topic: proposal.topic,
      status: 'planned',
      owner: input.owner,
      createdAt: now,
      startedAt: null,
      pausedAt: null,
      finishedAt: null,
      currentWaveSequence: 0,
      previousVersion: input.previousVersion ?? null,
      rollbackTargetWaveId: null,
      rolledBackAt: null,
      note: input.note ?? null,
      snapshot,
      waves,
      receipts: [],
    };

    this.db
      .prepare(
        `INSERT INTO rollouts
          (rollout_id, proposal_id, topic, status, owner, created_at, started_at, paused_at, finished_at,
           current_wave_sequence, previous_version, rollback_target_wave_id, rolled_back_at, note,
           snapshot_json, waves_json, expected_version)
         VALUES (?, ?, ?, 'planned', ?, ?, NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?, ?, 0)`,
      )
      .run(
        rolloutId,
        proposal.proposalId,
        proposal.topic,
        input.owner,
        now,
        input.previousVersion ?? null,
        input.note ?? null,
        JSON.stringify(snapshot),
        JSON.stringify(waves),
      );

    this.append(proposal.proposalId, now, 'rollout-created', {
      rolloutId,
      owner: input.owner,
      waveCount: waves.length,
      environments: waves.map((w) => w.environment),
      candidateDigest: snapshot.candidateDigest,
      previousVersion: input.previousVersion ?? null,
    });

    let created = rollout;
    if (input.autoStart !== false) {
      created = this.doStart(rolloutId);
    }
    return { rollout: created, proposal };
  }

  private doStart(rolloutId: RolloutId): StoredRollout {
    const rollout = this.requireById(rolloutId);
    const now = this.clock.now();
    const { rollout: next, wave } = startRollout(rollout, now);
    this.db.transaction(() => {
      this.persist(next);
      this.append(next.proposalId, now, 'rollout-started', {
        rolloutId,
        firstWaveSequence: wave!.sequence,
        environment: wave!.environment,
      });
      this.append(next.proposalId, now, 'wave-deploying', {
        rolloutId,
        waveId: wave!.waveId,
        waveSequence: wave!.sequence,
        environment: wave!.environment,
        attempt: wave!.attempts,
      });
    })();
    return this.requireById(rolloutId);
  }

  start(rolloutId: RolloutId): StoredRollout {
    const rollout = this.requireById(rolloutId);
    if (rollout.status !== 'planned') {
      throw new ConflictError(`cannot start rollout in status ${rollout.status}`);
    }
    return this.doStart(rolloutId);
  }

  pause(rolloutId: RolloutId, pausedBy: string): StoredRollout {
    const rollout = this.requireById(rolloutId);
    const now = this.clock.now();
    const { rollout: next } = pauseRollout(rollout, now);
    this.db.transaction(() => {
      this.persist(next);
      const current = getCurrentWave(next);
      this.append(next.proposalId, now, 'rollout-paused', {
        rolloutId,
        pausedBy,
        atWaveSequence: current?.sequence ?? next.currentWaveSequence,
      });
    })();
    return this.requireById(rolloutId);
  }

  resume(rolloutId: RolloutId, resumedBy: string): StoredRollout {
    const rollout = this.requireById(rolloutId);
    const now = this.clock.now();
    const { rollout: next, effects } = resumeRollout(rollout, now);
    this.db.transaction(() => {
      this.persist(next);
      this.append(next.proposalId, now, 'rollout-resumed', {
        rolloutId,
        resumedBy,
        atWaveSequence: next.currentWaveSequence,
      });
      if (effects.includes('wave-deploying')) {
        const current = getCurrentWave(next);
        if (current) {
          this.append(next.proposalId, now, 'wave-deploying', {
            rolloutId,
            waveId: current.waveId,
            waveSequence: current.sequence,
            environment: current.environment,
            attempt: current.attempts,
          });
        }
      }
    })();
    return this.requireById(rolloutId);
  }

  retry(
    rolloutId: RolloutId,
    waveSequence: number,
    retriedBy: string,
  ): StoredRollout {
    const rollout = this.requireById(rolloutId);
    const now = this.clock.now();
    const { rollout: next, wave } = retryWave(
      rollout,
      waveSequence,
      retriedBy,
      now,
    );
    this.db.transaction(() => {
      this.persist(next);
      this.append(next.proposalId, now, 'wave-retried', {
        rolloutId,
        waveId: wave!.waveId,
        waveSequence: wave!.sequence,
        environment: wave!.environment,
        attempt: wave!.attempts,
        retriedBy,
      });
      this.append(next.proposalId, now, 'wave-deploying', {
        rolloutId,
        waveId: wave!.waveId,
        waveSequence: wave!.sequence,
        environment: wave!.environment,
        attempt: wave!.attempts,
      });
    })();
    return this.requireById(rolloutId);
  }

  rollback(
    rolloutId: RolloutId,
    rolledBackBy: string,
    note: string,
  ): StoredRollout {
    const rollout = this.requireById(rolloutId);
    const now = this.clock.now();
    const { rollout: next, wave } = rollback(
      rollout,
      rolledBackBy,
      now,
      note,
    );
    this.db.transaction(() => {
      this.persist(next);
      this.append(next.proposalId, now, 'rollout-rolled-back', {
        rolloutId,
        rolledBackBy,
        fromWaveSequence: next.currentWaveSequence,
        targetWaveId: next.rollbackTargetWaveId,
        previousVersion: next.previousVersion,
        note,
      });
    })();
    void wave;
    return this.requireById(rolloutId);
  }

  reportReceipt(input: ReceiptInput): ReceiptResult2 {
    const rollout = this.requireById(input.rolloutId);
    const now = this.clock.now();

    const existing = this.db
      .prepare(
        'SELECT * FROM rollout_receipts WHERE rollout_id = ? AND idempotency_key = ?',
      )
      .get(input.rolloutId, input.idempotencyKey) as ReceiptRow | undefined;
    if (existing) {
      return { accepted: true, deduped: true, rollout };
    }

    const receiptId = `rcpt_${digestString(
      `${input.rolloutId}:${input.idempotencyKey}:${input.waveSequence}`,
    ).slice(0, 24)}`;

    const application = applyReceipt(rollout, input, receiptId, now);
    if (!application.accepted) {
      this.append(rollout.proposalId, now, 'receipt-rejected', {
        rolloutId: input.rolloutId,
        reason: application.reason,
        waveSequence: input.waveSequence,
        idempotencyKey: input.idempotencyKey,
        result: input.result,
        currentWaveSequence: rollout.currentWaveSequence,
        rolloutStatus: rollout.status,
      });
      return {
        accepted: false,
        deduped: false,
        reason: application.reason,
        rollout,
      };
    }
    if (application.deduped) {
      return { accepted: true, deduped: true, rollout };
    }

    const next = application.rollout;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rollout_receipts
            (receipt_id, rollout_id, wave_id, wave_sequence, result, message,
             reported_at, received_at, idempotency_key, adapter_run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          input.rolloutId,
          application.wave!.waveId,
          input.waveSequence,
          input.result,
          input.message,
          input.reportedAt,
          now,
          input.idempotencyKey,
          input.adapterRunId,
        );
      this.persist(next);

      const advanced = next.currentWaveSequence !== rollout.currentWaveSequence;
      this.append(next.proposalId, now, 'wave-result', {
        rolloutId: input.rolloutId,
        waveId: application.wave!.waveId,
        waveSequence: input.waveSequence,
        environment: application.wave!.environment,
        result: input.result,
        message: input.message,
        receiptId,
        idempotencyKey: input.idempotencyKey,
        advanced,
        nextWaveSequence: advanced ? next.currentWaveSequence : null,
      });

      for (const effect of application.effects) {
        if (effect === 'wave-deploying') {
          const current = getCurrentWave(next);
          if (current) {
            this.append(next.proposalId, now, 'wave-deploying', {
              rolloutId: input.rolloutId,
              waveId: current.waveId,
              waveSequence: current.sequence,
              environment: current.environment,
              attempt: current.attempts,
            });
          }
        } else if (effect === 'rollout-completed') {
          this.append(next.proposalId, now, 'rollout-completed', {
            rolloutId: input.rolloutId,
            waveCount: next.waves.length,
            candidateDigest: next.snapshot.candidateDigest,
          });
        } else if (effect === 'rollout-failed') {
          const current = getCurrentWave(next);
          this.append(next.proposalId, now, 'rollout-failed', {
            rolloutId: input.rolloutId,
            waveSequence: input.waveSequence,
            environment: current?.environment ?? '',
            message: input.message,
          });
        }
      }
    })();

    return {
      accepted: true,
      deduped: false,
      rollout: this.requireById(input.rolloutId),
    };
  }

  readEventsAfter(eventId: number): CausalEvent[] {
    return this.events.readAfter(eventId);
  }
}

export { getWave, isTerminal, ProposalAlreadyDecidedError };
