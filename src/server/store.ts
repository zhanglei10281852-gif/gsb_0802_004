import { randomUUID } from 'node:crypto';
import type { Clock } from '../core/clock.js';
import { stableDigest } from '../core/canonical.js';
import { checkCompatibility } from '../core/compat.js';
import { REQUIRED_CONFIRMS, effectiveExemptionStatus } from '../core/exemption.js';
import { decisionBlockers, evaluateGate, latestApplicableEvidence } from '../core/gate.js';
import { classifyReceipt, isKnownRollbackTarget, waveStatusForResult } from '../core/rollout.js';
import type {
  CompatResult,
  Decision,
  DecisionAction,
  DecisionSnapshot,
  DomainEvent,
  EvidenceInput,
  EvidenceRecord,
  Exemption,
  ExemptionDirection,
  ExemptionView,
  ProposalDetail,
  Receipt,
  ReceiptOutcome,
  ReceiptResult,
  Rollout,
  RolloutDetail,
  Wave,
} from '../core/types.js';
import { openDatabase, type Db } from './db.js';

export class StoreError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface CreateProposalInput {
  title: string;
  createdBy?: string;
  baseline: unknown;
  candidate: unknown;
  consumers: string[];
  evidenceTtlMs?: number;
  environment?: string;
  /** 内部使用：谱系中的上一版提案。 */
  predecessorId?: string;
}

export interface CreateSuccessorInput {
  candidate: unknown;
  createdBy?: string;
  title?: string;
  consumers?: string[];
  environment?: string;
  evidenceTtlMs?: number;
  reason?: string;
}

export interface CreateRolloutInput {
  waves: { name: string; environment: string }[];
  createdBy: string;
}

export interface ReceiptInput {
  waveId: string;
  decisionId: string;
  result: ReceiptResult;
  receiptKey: string;
  detail?: unknown;
}

export interface RequestExemptionInput {
  consumerId: string;
  direction: ExemptionDirection;
  reason: string;
  requestedBy: string;
  ttlMs: number;
  environment?: string;
}

export interface EvidenceResult {
  outcome: 'recorded' | 'duplicate' | 'stale_candidate' | 'closed';
  evidence: EvidenceRecord;
}

export interface DecideInput {
  action: DecisionAction;
  decidedBy: string;
  expectedVersion: number;
  rationale?: string;
  acknowledgeBreaking?: boolean;
}

export interface Snapshot {
  serverTime: number;
  eventCursor: number;
  proposals: ProposalDetail[];
}

interface ProposalRow {
  id: string;
  title: string;
  status: 'open' | 'approved' | 'rejected';
  version: number;
  baseline_json: string;
  baseline_digest: string;
  candidate_json: string;
  candidate_digest: string;
  compat_json: string;
  consumers_json: string;
  environment: string;
  evidence_ttl_ms: number;
  created_at: number;
  updated_at: number;
  decision_id: string | null;
  predecessor_id: string | null;
  superseded_by_id: string | null;
}

interface EvidenceRow {
  id: number;
  proposal_id: string;
  consumer_id: string;
  candidate_digest: string;
  verdict: 'pass' | 'fail';
  run_id: string;
  idempotency_key: string;
  details_json: string | null;
  recorded_at: number;
  applies_to_current: number;
}

interface ExemptionRow {
  id: string;
  proposal_id: string;
  candidate_digest: string;
  consumer_id: string;
  environment: string;
  direction: ExemptionDirection;
  reason: string;
  requested_by: string;
  requested_at: number;
  ttl_ms: number;
  expires_at: number;
  status: 'pending' | 'active' | 'rejected' | 'revoked' | 'expired';
  confirmations_json: string;
  rejected_by: string | null;
  rejected_at: number | null;
  reject_reason: string | null;
  revoked_by: string | null;
  revoked_at: number | null;
  revoke_reason: string | null;
}

interface RolloutRow {
  id: string;
  proposal_id: string;
  decision_id: string;
  candidate_digest: string;
  status: 'active' | 'paused' | 'completed' | 'rolled_back';
  current_ordinal: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  rolled_back_to: number | null;
  rollback_reason: string | null;
  rolled_back_by: string | null;
  rolled_back_at: number | null;
}

interface WaveRow {
  id: string;
  rollout_id: string;
  ordinal: number;
  name: string;
  environment: string;
  status: 'pending' | 'deploying' | 'succeeded' | 'failed' | 'unknown' | 'rolled_back';
  retry_count: number;
  started_at: number | null;
  finished_at: number | null;
}

interface ReceiptRow {
  id: number;
  rollout_id: string;
  wave_id: string;
  decision_id: string;
  result: 'success' | 'failure' | 'unknown';
  receipt_key: string;
  detail_json: string | null;
  received_at: number;
  applied: number;
  outcome: string;
}

export class Store {
  private db: Db;
  private clock: Clock;
  private defaultTtlMs: number;
  private listeners = new Set<(e: DomainEvent) => void>();

  constructor(opts: { path: string; clock: Clock; defaultTtlMs: number }) {
    this.db = openDatabase(opts.path);
    this.clock = opts.clock;
    this.defaultTtlMs = opts.defaultTtlMs;
  }

  close(): void {
    this.db.close();
  }

  /** SSE 等场景订阅提交后的新事件。事件先落库，提交后才推送。 */
  onEvent(fn: (e: DomainEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(events: DomainEvent[]): void {
    for (const e of events) for (const l of this.listeners) l(e);
  }

  private getRow(id: string): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
  }

  private mustGetRow(id: string): ProposalRow {
    const row = this.getRow(id);
    if (!row) throw new StoreError('NOT_FOUND', 404, `提案 ${id} 不存在`);
    return row;
  }

  createProposal(input: CreateProposalInput): ProposalDetail {
    if (!input.title || typeof input.title !== 'string') {
      throw new StoreError('BAD_REQUEST', 400, 'title 不能为空');
    }
    if (!Array.isArray(input.consumers) || input.consumers.length === 0) {
      throw new StoreError('BAD_REQUEST', 400, 'consumers 必须是非空数组');
    }
    const consumers = input.consumers.map((c) => String(c).trim()).filter(Boolean);
    if (new Set(consumers).size !== consumers.length || consumers.length === 0) {
      throw new StoreError('BAD_REQUEST', 400, 'consumers 存在重复或空项');
    }
    const compat = checkCompatibility(input.baseline, input.candidate);
    const now = this.clock.now();
    const id = `prp_${randomUUID()}`;
    const baselineDigest = stableDigest(input.baseline);
    const candidateDigest = stableDigest(input.candidate);
    const ttl = input.evidenceTtlMs && input.evidenceTtlMs > 0 ? Math.floor(input.evidenceTtlMs) : this.defaultTtlMs;
    const environment = input.environment && input.environment.trim() ? input.environment.trim() : 'prod';

    let created: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO proposals (id, title, status, version, baseline_json, baseline_digest,
             candidate_json, candidate_digest, compat_json, consumers_json, environment, evidence_ttl_ms,
             created_at, updated_at, decision_id, predecessor_id, superseded_by_id)
           VALUES (?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(
          id,
          input.title,
          JSON.stringify(input.baseline),
          baselineDigest,
          JSON.stringify(input.candidate),
          candidateDigest,
          JSON.stringify(compat),
          JSON.stringify(consumers),
          environment,
          ttl,
          now,
          now,
          input.predecessorId ?? null,
        );
      created = [
        this.appendEvent(id, 'PROPOSAL_CREATED', {
          title: input.title,
          createdBy: input.createdBy ?? null,
          baselineDigest,
          candidateDigest,
          compatStatus: compat.status,
          consumers,
          environment,
          evidenceTtlMs: ttl,
          predecessorId: input.predecessorId ?? null,
        }),
      ];
    });
    tx();
    this.emit(created);
    return this.getProposal(id)!;
  }

  /**
   * 从当前提案派生后继提案：继承基线（标题/消费方/环境/TTL 可覆盖），
   * 新候选产生新摘要并重新计算兼容性。原提案仍开放则在同一事务内被替代关闭
   * （superseded）；已决策的原提案保持原结论，仅记录谱系链接。
   * 原提案的构建证据与豁免按原精确作用域留在原提案，绝不因名称相同而继承。
   * CAS 保证同一提案只能有一个后继（线性谱系）。
   */
  createSuccessor(proposalId: string, input: CreateSuccessorInput): ProposalDetail {
    this.sweepExpiredExemptions();
    let successorId = '';
    let events: { proposalId: string; ev: DomainEvent }[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      const now = this.clock.now();
      const baseline = JSON.parse(p.baseline_json) as unknown;
      const candidate = input.candidate;
      const consumers =
        input.consumers && input.consumers.length > 0
          ? input.consumers.map((c) => String(c).trim()).filter(Boolean)
          : (JSON.parse(p.consumers_json) as string[]);
      if (new Set(consumers).size !== consumers.length || consumers.length === 0) {
        throw new StoreError('BAD_REQUEST', 400, 'consumers 存在重复或空项');
      }
      const compat = checkCompatibility(baseline, candidate);
      successorId = `prp_${randomUUID()}`;
      const digest = stableDigest(candidate);
      const baselineDigest = stableDigest(baseline);
      const ttl = input.evidenceTtlMs && input.evidenceTtlMs > 0 ? Math.floor(input.evidenceTtlMs) : p.evidence_ttl_ms;
      const environment = input.environment && input.environment.trim() ? input.environment.trim() : p.environment;
      const title = input.title && input.title.trim() ? input.title.trim() : p.title;
      // CAS：同一提案只允许一个后继（无论其当前状态），并发派生只有一个成功。
      const res = this.db
        .prepare('UPDATE proposals SET superseded_by_id = ?, updated_at = ? WHERE id = ? AND superseded_by_id IS NULL')
        .run(successorId, now, proposalId);
      if (res.changes !== 1) {
        throw new StoreError('ALREADY_SUPERSEDED', 409, `提案 ${proposalId} 已存在后继 ${p.superseded_by_id}，谱系必须保持线性`);
      }
      this.db
        .prepare(
          `INSERT INTO proposals (id, title, status, version, baseline_json, baseline_digest,
             candidate_json, candidate_digest, compat_json, consumers_json, environment, evidence_ttl_ms,
             created_at, updated_at, decision_id, predecessor_id, superseded_by_id)
           VALUES (?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(
          successorId,
          title,
          JSON.stringify(baseline),
          baselineDigest,
          JSON.stringify(candidate),
          digest,
          JSON.stringify(compat),
          JSON.stringify(consumers),
          environment,
          ttl,
          now,
          now,
          proposalId,
        );
      events = [
        {
          proposalId,
          ev: this.appendEvent(proposalId, 'PROPOSAL_SUPERSEDED', {
            successorId,
            successorDigest: digest,
            reason: input.reason ?? null,
            closedByReplacement: p.status === 'open',
            previousStatus: p.status,
          }),
        },
        {
          proposalId: successorId,
          ev: this.appendEvent(successorId, 'PROPOSAL_CREATED', {
            title,
            createdBy: input.createdBy ?? null,
            baselineDigest,
            candidateDigest: digest,
            compatStatus: compat.status,
            consumers,
            environment,
            evidenceTtlMs: ttl,
            predecessorId: proposalId,
            predecessorDigest: p.candidate_digest,
          }),
        },
      ];
    });
    tx();
    this.emit(events.map((e) => e.ev));
    return this.getProposal(successorId)!;
  }

  /** 开放的判定：未被决策且未被替代。 */
  private isOpenRow(p: ProposalRow): boolean {
    return p.status === 'open' && p.superseded_by_id === null;
  }

  addRevision(proposalId: string, candidate: unknown, expectedVersion: number): ProposalDetail {
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      if (p.superseded_by_id !== null) {
        throw new StoreError('PROPOSAL_SUPERSEDED', 409, `提案已被后继 ${p.superseded_by_id} 替代，不能再修订候选`);
      }
      if (p.status !== 'open') {
        throw new StoreError('PROPOSAL_CLOSED', 409, `提案已${p.status === 'approved' ? '批准' : '驳回'}，不能再修订候选`);
      }
      if (p.version !== expectedVersion) {
        throw new StoreError('VERSION_CONFLICT', 409, `版本冲突：期望 ${expectedVersion}，当前 ${p.version}`);
      }
      const baseline = JSON.parse(p.baseline_json) as unknown;
      const compat = checkCompatibility(baseline, candidate);
      const newDigest = stableDigest(candidate);
      const now = this.clock.now();
      const res = this.db
        .prepare(
          `UPDATE proposals SET candidate_json = ?, candidate_digest = ?, compat_json = ?,
             version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .run(JSON.stringify(candidate), newDigest, JSON.stringify(compat), now, proposalId, expectedVersion);
      if (res.changes !== 1) {
        throw new StoreError('VERSION_CONFLICT', 409, '并发修订冲突，请刷新后重试');
      }
      events = [
        this.appendEvent(proposalId, 'CANDIDATE_REVISED', {
          fromDigest: p.candidate_digest,
          toDigest: newDigest,
          version: expectedVersion + 1,
          compatStatus: compat.status,
        }),
      ];
    });
    tx();
    this.emit(events);
    return this.getProposal(proposalId)!;
  }

  /**
   * 证据报送。幂等：相同 idempotencyKey 的重试只生效一次；
   * 旧候选摘要或已关闭提案的证据会被记录但标记为不适用，绝不污染当前门禁。
   */
  recordEvidence(proposalId: string, input: EvidenceInput): EvidenceResult {
    let result!: EvidenceResult;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      const existing = this.db
        .prepare('SELECT * FROM evidence WHERE idempotency_key = ?')
        .get(input.idempotencyKey) as EvidenceRow | undefined;
      if (existing) {
        if (
          existing.proposal_id !== proposalId ||
          existing.consumer_id !== input.consumerId ||
          existing.candidate_digest !== input.candidateDigest ||
          existing.verdict !== input.verdict ||
          existing.run_id !== input.runId
        ) {
          throw new StoreError(
            'IDEMPOTENCY_CONFLICT',
            409,
            `幂等键 ${input.idempotencyKey} 已被不同内容的报送占用`,
          );
        }
        result = { outcome: 'duplicate', evidence: this.mapEvidence(existing) };
        return;
      }
      const consumers = JSON.parse(p.consumers_json) as string[];
      if (!consumers.includes(input.consumerId)) {
        throw new StoreError('UNKNOWN_CONSUMER', 422, `消费方 ${input.consumerId} 不在提案 ${proposalId} 的依赖清单中`, {
          consumers,
        });
      }
      if (input.verdict !== 'pass' && input.verdict !== 'fail') {
        throw new StoreError('BAD_REQUEST', 400, 'verdict 必须是 pass 或 fail');
      }
      const applies = this.isOpenRow(p) && input.candidateDigest === p.candidate_digest;
      const outcome: EvidenceResult['outcome'] = !this.isOpenRow(p)
        ? 'closed'
        : input.candidateDigest !== p.candidate_digest
          ? 'stale_candidate'
          : 'recorded';
      const recordedAt = this.clock.now();
      const ins = this.db
        .prepare(
          `INSERT INTO evidence (proposal_id, consumer_id, candidate_digest, verdict, run_id,
             idempotency_key, details_json, recorded_at, applies_to_current)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposalId,
          input.consumerId,
          input.candidateDigest,
          input.verdict,
          input.runId,
          input.idempotencyKey,
          input.details === undefined ? null : JSON.stringify(input.details),
          recordedAt,
          applies ? 1 : 0,
        );
      const row = this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(ins.lastInsertRowid) as EvidenceRow;
      result = { outcome, evidence: this.mapEvidence(row) };
      events = [
        this.appendEvent(proposalId, 'EVIDENCE_RECORDED', {
          evidenceId: row.id,
          outcome,
          consumerId: input.consumerId,
          verdict: input.verdict,
          runId: input.runId,
          candidateDigest: input.candidateDigest,
          appliesToCurrent: applies,
        }),
      ];
      // 迟到报送（旧候选或已关闭/被替代提案）显式写入因果记录：归入原提案但被隔离。
      if (outcome !== 'recorded') {
        events.push(
          this.appendEvent(proposalId, 'EVIDENCE_LATE', {
            evidenceId: row.id,
            outcome,
            consumerId: input.consumerId,
            candidateDigest: input.candidateDigest,
            currentCandidateDigest: p.candidate_digest,
            reason:
              outcome === 'stale_candidate'
                ? '候选摘要与当前候选不一致，按迟到结果隔离，不参与门禁'
                : '提案已关闭或已被替代，证据归入原提案存档，不参与门禁',
          }),
        );
      }
    });
    tx();
    this.emit(events);
    return result;
  }

  /**
   * 申请限时豁免：只能针对提案的当前候选摘要与已声明消费方，
   * 需两名不同审核人确认后才生效；到期或被撤销后不再参与新决策。
   */
  requestExemption(proposalId: string, input: RequestExemptionInput): ExemptionView {
    this.sweepExpiredExemptions();
    if (!input.requestedBy) throw new StoreError('BAD_REQUEST', 400, 'requestedBy 不能为空');
    if (!input.reason) throw new StoreError('BAD_REQUEST', 400, '豁免原因 reason 不能为空');
    if (input.direction !== 'backward' && input.direction !== 'forward') {
      throw new StoreError('BAD_REQUEST', 400, "direction 必须是 'backward' 或 'forward'");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new StoreError('BAD_REQUEST', 400, 'ttlMs 必须是正数（豁免必须限时）');
    }
    let view!: ExemptionView;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      const consumers = JSON.parse(p.consumers_json) as string[];
      if (!consumers.includes(input.consumerId)) {
        throw new StoreError('UNKNOWN_CONSUMER', 422, `消费方 ${input.consumerId} 不在提案 ${proposalId} 的依赖清单中`, { consumers });
      }
      const now = this.clock.now();
      const id = `exm_${randomUUID()}`;
      const environment = input.environment && input.environment.trim() ? input.environment.trim() : p.environment;
      const expiresAt = now + Math.floor(input.ttlMs);
      this.db
        .prepare(
          `INSERT INTO exemptions (id, proposal_id, candidate_digest, consumer_id, environment, direction,
             reason, requested_by, requested_at, ttl_ms, expires_at, status, confirmations_json,
             rejected_by, rejected_at, reject_reason, revoked_by, revoked_at, revoke_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', NULL, NULL, NULL, NULL, NULL, NULL)`,
        )
        .run(id, proposalId, p.candidate_digest, input.consumerId, environment, input.direction, input.reason, input.requestedBy, now, Math.floor(input.ttlMs), expiresAt);
      view = this.viewExemption(this.mustGetExemptionRow(id));
      events = [
        this.appendEvent(proposalId, 'EXEMPTION_REQUESTED', {
          exemptionId: id,
          consumerId: input.consumerId,
          candidateDigest: p.candidate_digest,
          environment,
          direction: input.direction,
          requestedBy: input.requestedBy,
          ttlMs: Math.floor(input.ttlMs),
          expiresAt,
          reason: input.reason,
        }),
      ];
    });
    tx();
    this.emit(events);
    return view;
  }

  /** 复核确认：两名不同审核人（且都不是申请人）确认后豁免生效。 */
  confirmExemption(id: string, by: string): ExemptionView {
    this.sweepExpiredExemptions();
    if (!by) throw new StoreError('BAD_REQUEST', 400, '审核人 by 不能为空');
    let view!: ExemptionView;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const row = this.mustGetExemptionRow(id);
      const now = this.clock.now();
      if (row.status !== 'pending') {
        throw new StoreError('EXEMPTION_STATE', 409, `豁免当前状态为 ${row.status}，不能复核`);
      }
      if (now > row.expires_at) {
        throw new StoreError('EXEMPTION_STATE', 409, '豁免已超过到期时刻，不能复核');
      }
      if (by === row.requested_by) {
        throw new StoreError('REQUESTER_CANNOT_CONFIRM', 422, '申请人不能复核自己的豁免');
      }
      const confirmations = JSON.parse(row.confirmations_json) as { by: string; at: number }[];
      if (confirmations.some((c) => c.by === by)) {
        throw new StoreError('DUPLICATE_CONFIRMER', 409, `审核人 ${by} 已确认过该豁免，需要两名不同审核人`);
      }
      confirmations.push({ by, at: now });
      const active = confirmations.length >= REQUIRED_CONFIRMS;
      this.db
        .prepare('UPDATE exemptions SET confirmations_json = ?, status = ? WHERE id = ?')
        .run(JSON.stringify(confirmations), active ? 'active' : 'pending', id);
      view = this.viewExemption(this.mustGetExemptionRow(id));
      events = [
        this.appendEvent(row.proposal_id, 'EXEMPTION_CONFIRMED', {
          exemptionId: id,
          by,
          confirmations: confirmations.length,
          required: REQUIRED_CONFIRMS,
          status: view.status,
        }),
      ];
    });
    tx();
    this.emit(events);
    return view;
  }

  /** 复核阶段拒绝（待复核状态才可拒绝，需给出原因）。 */
  rejectExemption(id: string, by: string, reason?: string): ExemptionView {
    this.sweepExpiredExemptions();
    if (!by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let view!: ExemptionView;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const row = this.mustGetExemptionRow(id);
      if (row.status !== 'pending') {
        throw new StoreError('EXEMPTION_STATE', 409, `豁免当前状态为 ${row.status}，只有待复核的豁免可以拒绝`);
      }
      const now = this.clock.now();
      this.db
        .prepare(`UPDATE exemptions SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ? WHERE id = ?`)
        .run(by, now, reason ?? null, id);
      view = this.viewExemption(this.mustGetExemptionRow(id));
      events = [
        this.appendEvent(row.proposal_id, 'EXEMPTION_REJECTED', { exemptionId: id, by, reason: reason ?? null }),
      ];
    });
    tx();
    this.emit(events);
    return view;
  }

  /** 撤销生效中的豁免：立即退出后续新决策；历史决策快照保持原样。 */
  revokeExemption(id: string, by: string, reason?: string): ExemptionView {
    this.sweepExpiredExemptions();
    if (!by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let view!: ExemptionView;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const row = this.mustGetExemptionRow(id);
      if (row.status !== 'active') {
        throw new StoreError('EXEMPTION_STATE', 409, `豁免当前状态为 ${row.status}，只有生效中的豁免可以撤销`);
      }
      const now = this.clock.now();
      this.db
        .prepare(`UPDATE exemptions SET status = 'revoked', revoked_by = ?, revoked_at = ?, revoke_reason = ? WHERE id = ?`)
        .run(by, now, reason ?? null, id);
      view = this.viewExemption(this.mustGetExemptionRow(id));
      events = [
        this.appendEvent(row.proposal_id, 'EXEMPTION_REVOKED', { exemptionId: id, by, reason: reason ?? null }),
      ];
    });
    tx();
    this.emit(events);
    return view;
  }

  getExemption(id: string): ExemptionView | null {
    this.sweepExpiredExemptions();
    const row = this.db.prepare('SELECT * FROM exemptions WHERE id = ?').get(id) as ExemptionRow | undefined;
    return row ? this.viewExemption(row) : null;
  }

  // ---- 分阶段发布 ----

  /**
   * 为已通过门禁（已批准）的提案创建分阶段发布：绑定当时的决策快照，
   * 波次按顺序连续部署，第一波次立即进入部署中。每个提案至多一个发布。
   */
  createRollout(proposalId: string, input: CreateRolloutInput): RolloutDetail {
    if (!input.createdBy) throw new StoreError('BAD_REQUEST', 400, 'createdBy 不能为空');
    if (!Array.isArray(input.waves) || input.waves.length === 0) {
      throw new StoreError('BAD_REQUEST', 400, 'waves 必须是非空数组');
    }
    for (const [i, w] of input.waves.entries()) {
      if (!w.name?.trim() || !w.environment?.trim()) {
        throw new StoreError('BAD_REQUEST', 400, `第 ${i + 1} 个波次的 name 与 environment 不能为空`);
      }
    }
    let rolloutId = '';
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      if (p.status !== 'approved' || !p.decision_id) {
        throw new StoreError('PROPOSAL_NOT_APPROVED', 422, '只有已批准（通过门禁）的提案才能创建发布');
      }
      const existing = this.db.prepare('SELECT id FROM rollouts WHERE proposal_id = ?').get(proposalId) as
        | { id: string }
        | undefined;
      if (existing) {
        throw new StoreError('ROLLOUT_EXISTS', 409, `提案已存在发布 ${existing.id}`);
      }
      const now = this.clock.now();
      rolloutId = `ro_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO rollouts (id, proposal_id, decision_id, candidate_digest, status, current_ordinal,
             created_by, created_at, updated_at, rolled_back_to, rollback_reason, rolled_back_by, rolled_back_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(rolloutId, proposalId, p.decision_id, p.candidate_digest, input.createdBy, now, now);
      input.waves.forEach((w, i) => {
        const ordinal = i + 1;
        this.db
          .prepare(
            `INSERT INTO waves (id, rollout_id, ordinal, name, environment, status, retry_count, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
          )
          .run(`wv_${randomUUID()}`, rolloutId, ordinal, w.name.trim(), w.environment.trim(), ordinal === 1 ? 'deploying' : 'pending', ordinal === 1 ? now : null);
      });
      events = [
        this.appendEvent(proposalId, 'ROLLOUT_CREATED', {
          rolloutId,
          decisionId: p.decision_id,
          candidateDigest: p.candidate_digest,
          waves: input.waves.map((w, i) => ({ ordinal: i + 1, name: w.name.trim(), environment: w.environment.trim() })),
          createdBy: input.createdBy,
        }),
        this.appendEvent(proposalId, 'WAVE_DEPLOYING', {
          rolloutId,
          waveOrdinal: 1,
          name: input.waves[0].name.trim(),
          environment: input.waves[0].environment.trim(),
          retry: 0,
        }),
      ];
    });
    tx();
    this.emit(events);
    return this.getRollout(rolloutId)!;
  }

  /**
   * 部署适配器回执。幂等键去重；只有绑定同一决策快照、指向当前波次
   * （部署中）的回执才会推进；重复、乱序、决策不匹配、暂停中与已关闭
   * 的回执都被记录但隔离（附 RECEIPT_LATE 因果事件）。
   */
  recordReceipt(rolloutId: string, input: ReceiptInput): { outcome: ReceiptOutcome; receipt: Receipt } {
    if (!input.receiptKey) throw new StoreError('BAD_REQUEST', 400, 'receiptKey 不能为空');
    if (input.result !== 'success' && input.result !== 'failure' && input.result !== 'unknown') {
      throw new StoreError('BAD_REQUEST', 400, "result 必须是 success / failure / unknown");
    }
    let result!: { outcome: ReceiptOutcome; receipt: Receipt };
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const rollout = this.mustGetRolloutRow(rolloutId);
      const existing = this.db.prepare('SELECT * FROM receipts WHERE receipt_key = ?').get(input.receiptKey) as
        | ReceiptRow
        | undefined;
      if (existing) {
        if (existing.rollout_id !== rolloutId || existing.wave_id !== input.waveId || existing.result !== input.result) {
          throw new StoreError('IDEMPOTENCY_CONFLICT', 409, `回执幂等键 ${input.receiptKey} 已被不同内容占用`);
        }
        result = { outcome: 'duplicate', receipt: this.mapReceipt(existing) };
        return;
      }
      const wave = this.db.prepare('SELECT * FROM waves WHERE id = ?').get(input.waveId) as WaveRow | undefined;
      if (!wave || wave.rollout_id !== rolloutId) {
        throw new StoreError('UNKNOWN_WAVE', 422, `波次 ${input.waveId} 不属于发布 ${rolloutId}`);
      }
      const outcome = classifyReceipt(this.mapRollout(rollout), this.mapWave(wave), input.decisionId);
      const applied = outcome === 'applied';
      const now = this.clock.now();
      const ins = this.db
        .prepare(
          `INSERT INTO receipts (rollout_id, wave_id, decision_id, result, receipt_key, detail_json, received_at, applied, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(rolloutId, input.waveId, input.decisionId, input.result, input.receiptKey, input.detail === undefined ? null : JSON.stringify(input.detail), now, applied ? 1 : 0, outcome);
      const receipt = this.mapReceipt(this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(ins.lastInsertRowid) as ReceiptRow);
      result = { outcome, receipt };
      events = [
        this.appendEvent(rollout.proposal_id, 'RECEIPT_RECORDED', {
          receiptId: receipt.id,
          rolloutId,
          waveOrdinal: wave.ordinal,
          result: input.result,
          outcome,
          decisionId: input.decisionId,
        }),
      ];
      if (!applied) {
        events.push(
          this.appendEvent(rollout.proposal_id, 'RECEIPT_LATE', {
            receiptId: receipt.id,
            rolloutId,
            waveOrdinal: wave.ordinal,
            outcome,
            reason:
              outcome === 'stale_decision'
                ? '回执绑定的决策快照与发布不一致，被隔离'
                : outcome === 'stale_wave'
                  ? '回执指向非当前波次（乱序/迟到），被隔离'
                  : outcome === 'paused'
                    ? '发布已暂停，回执不推进波次；恢复后需重新报送'
                    : '发布已完成或已回退，回执归档但不生效',
          }),
        );
        return;
      }
      const waveStatus = waveStatusForResult(input.result);
      this.db
        .prepare('UPDATE waves SET status = ?, finished_at = ? WHERE id = ?')
        .run(waveStatus, now, wave.id);
      events.push(
        this.appendEvent(rollout.proposal_id, `WAVE_${waveStatus === 'succeeded' ? 'SUCCEEDED' : waveStatus === 'failed' ? 'FAILED' : 'UNKNOWN'}`, {
          rolloutId,
          waveOrdinal: wave.ordinal,
          result: input.result,
        }),
      );
      if (waveStatus === 'succeeded') {
        const next = this.db
          .prepare('SELECT * FROM waves WHERE rollout_id = ? AND ordinal = ?')
          .get(rolloutId, wave.ordinal + 1) as WaveRow | undefined;
        if (next) {
          this.db.prepare(`UPDATE waves SET status = 'deploying', started_at = ? WHERE id = ?`).run(now, next.id);
          this.db.prepare(`UPDATE rollouts SET current_ordinal = ?, updated_at = ? WHERE id = ?`).run(wave.ordinal + 1, now, rolloutId);
          events.push(
            this.appendEvent(rollout.proposal_id, 'WAVE_DEPLOYING', {
              rolloutId,
              waveOrdinal: next.ordinal,
              name: next.name,
              environment: next.environment,
              retry: 0,
            }),
          );
        } else {
          this.db.prepare(`UPDATE rollouts SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, rolloutId);
          events.push(this.appendEvent(rollout.proposal_id, 'ROLLOUT_COMPLETED', { rolloutId, waves: wave.ordinal }));
        }
      } else {
        // 失败或未知：自动暂停，等待人工重试或回退。
        this.db.prepare(`UPDATE rollouts SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, rolloutId);
        events.push(
          this.appendEvent(rollout.proposal_id, 'ROLLOUT_PAUSED', {
            rolloutId,
            reason: waveStatus === 'failed' ? `波次 ${wave.ordinal} 部署失败` : `波次 ${wave.ordinal} 结果未知`,
            waveOrdinal: wave.ordinal,
          }),
        );
      }
    });
    tx();
    this.emit(events);
    return result;
  }

  pauseRollout(id: string, by: string): RolloutDetail {
    if (!by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const r = this.mustGetRolloutRow(id);
      if (r.status !== 'active') throw new StoreError('ROLLOUT_STATE', 409, `发布状态为 ${r.status}，不能暂停`);
      this.db.prepare(`UPDATE rollouts SET status = 'paused', updated_at = ? WHERE id = ?`).run(this.clock.now(), id);
      events = [this.appendEvent(r.proposal_id, 'ROLLOUT_PAUSED', { rolloutId: id, by, reason: '人工暂停' })];
    });
    tx();
    this.emit(events);
    return this.getRollout(id)!;
  }

  resumeRollout(id: string, by: string): RolloutDetail {
    if (!by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const r = this.mustGetRolloutRow(id);
      if (r.status !== 'paused') throw new StoreError('ROLLOUT_STATE', 409, `发布状态为 ${r.status}，不能恢复`);
      this.db.prepare(`UPDATE rollouts SET status = 'active', updated_at = ? WHERE id = ?`).run(this.clock.now(), id);
      events = [this.appendEvent(r.proposal_id, 'ROLLOUT_RESUMED', { rolloutId: id, by })];
    });
    tx();
    this.emit(events);
    return this.getRollout(id)!;
  }

  /** 重试当前波次（仅失败/结果未知的当前波次可重试），发布回到进行中。 */
  retryWave(rolloutId: string, waveId: string, by: string): RolloutDetail {
    if (!by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const rollout = this.mustGetRolloutRow(rolloutId);
      if (rollout.status !== 'paused' && rollout.status !== 'active') {
        throw new StoreError('ROLLOUT_STATE', 409, `发布状态为 ${rollout.status}，不能重试波次`);
      }
      const wave = this.db.prepare('SELECT * FROM waves WHERE id = ?').get(waveId) as WaveRow | undefined;
      if (!wave || wave.rollout_id !== rolloutId) throw new StoreError('UNKNOWN_WAVE', 422, `波次 ${waveId} 不属于发布 ${rolloutId}`);
      if (wave.ordinal !== rollout.current_ordinal || (wave.status !== 'failed' && wave.status !== 'unknown')) {
        throw new StoreError('WAVE_STATE', 409, '只有失败或结果未知的当前波次可以重试');
      }
      const now = this.clock.now();
      this.db
        .prepare(`UPDATE waves SET status = 'deploying', retry_count = retry_count + 1, started_at = ?, finished_at = NULL WHERE id = ?`)
        .run(now, waveId);
      this.db.prepare(`UPDATE rollouts SET status = 'active', updated_at = ? WHERE id = ?`).run(now, rolloutId);
      events = [
        this.appendEvent(rollout.proposal_id, 'WAVE_RETRIED', { rolloutId, waveOrdinal: wave.ordinal, by, retryCount: wave.retry_count + 1 }),
        this.appendEvent(rollout.proposal_id, 'WAVE_DEPLOYING', { rolloutId, waveOrdinal: wave.ordinal, name: wave.name, environment: wave.environment, retry: wave.retry_count + 1 }),
      ];
    });
    tx();
    this.emit(events);
    return this.getRollout(rolloutId)!;
  }

  /**
   * 回退到上一个已知版本（已成功的波次，或 0 表示发布前）。
   * 只改发布/波次状态：不改写原契约决策快照，也不触碰任何豁免
   * （已失效的豁免不会被复活）。
   */
  rollbackRollout(id: string, input: { toWaveOrdinal: number; by: string; reason?: string }): RolloutDetail {
    if (!input.by) throw new StoreError('BAD_REQUEST', 400, '操作人 by 不能为空');
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const rollout = this.mustGetRolloutRow(id);
      if (rollout.status === 'rolled_back') {
        throw new StoreError('ROLLOUT_STATE', 409, '发布已回退，不能重复回退');
      }
      const waves = this.waveRowsFor(id).map((w) => this.mapWave(w));
      if (!isKnownRollbackTarget(waves, input.toWaveOrdinal)) {
        throw new StoreError('NOT_A_KNOWN_VERSION', 422, `波次序号 ${input.toWaveOrdinal} 不是已知版本（必须已成功，或 0 表示发布前）`);
      }
      const now = this.clock.now();
      const affected: number[] = [];
      for (const w of waves) {
        if (w.ordinal > input.toWaveOrdinal && w.status !== 'rolled_back') {
          this.db.prepare(`UPDATE waves SET status = 'rolled_back', finished_at = ? WHERE id = ?`).run(now, w.id);
          affected.push(w.ordinal);
        }
      }
      this.db
        .prepare(
          `UPDATE rollouts SET status = 'rolled_back', current_ordinal = ?, rolled_back_to = ?,
             rollback_reason = ?, rolled_back_by = ?, rolled_back_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.toWaveOrdinal, input.toWaveOrdinal, input.reason ?? null, input.by, now, now, id);
      events = [
        this.appendEvent(rollout.proposal_id, 'ROLLOUT_ROLLED_BACK', {
          rolloutId: id,
          toWaveOrdinal: input.toWaveOrdinal,
          affectedWaves: affected,
          by: input.by,
          reason: input.reason ?? null,
        }),
      ];
    });
    tx();
    this.emit(events);
    return this.getRollout(id)!;
  }

  getRollout(id: string): RolloutDetail | null {
    const row = this.db.prepare('SELECT * FROM rollouts WHERE id = ?').get(id) as RolloutRow | undefined;
    return row ? this.assembleRollout(row) : null;
  }

  private mustGetRolloutRow(id: string): RolloutRow {
    const row = this.db.prepare('SELECT * FROM rollouts WHERE id = ?').get(id) as RolloutRow | undefined;
    if (!row) throw new StoreError('NOT_FOUND', 404, `发布 ${id} 不存在`);
    return row;
  }

  private waveRowsFor(rolloutId: string): WaveRow[] {
    return this.db.prepare('SELECT * FROM waves WHERE rollout_id = ? ORDER BY ordinal').all(rolloutId) as WaveRow[];
  }

  private mapRollout(r: RolloutRow): Rollout {
    return {
      id: r.id,
      proposalId: r.proposal_id,
      decisionId: r.decision_id,
      candidateDigest: r.candidate_digest,
      status: r.status,
      currentOrdinal: r.current_ordinal,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      rolledBackTo: r.rolled_back_to,
      rollbackReason: r.rollback_reason,
      rolledBackBy: r.rolled_back_by,
      rolledBackAt: r.rolled_back_at,
    };
  }

  private mapWave(r: WaveRow): Wave {
    return {
      id: r.id,
      rolloutId: r.rollout_id,
      ordinal: r.ordinal,
      name: r.name,
      environment: r.environment,
      status: r.status,
      retryCount: r.retry_count,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }

  private mapReceipt(r: ReceiptRow): Receipt {
    return {
      id: r.id,
      rolloutId: r.rollout_id,
      waveId: r.wave_id,
      decisionId: r.decision_id,
      result: r.result,
      receiptKey: r.receipt_key,
      detail: r.detail_json === null ? undefined : JSON.parse(r.detail_json),
      receivedAt: r.received_at,
      applied: r.applied === 1,
      outcome: r.outcome as ReceiptOutcome,
    };
  }

  private assembleRollout(row: RolloutRow): RolloutDetail {
    const receipts = this.db.prepare('SELECT * FROM receipts WHERE rollout_id = ? ORDER BY id').all(row.id) as ReceiptRow[];
    return {
      ...this.mapRollout(row),
      waves: this.waveRowsFor(row.id).map((w) => this.mapWave(w)),
      receipts: receipts.map((r) => this.mapReceipt(r)),
    };
  }

  /**
   * 过期扫描：把已到期但仍标记 active 的豁免物化为 expired，并把到期原因写入审计链。
   * 在读写入口统一调用，保证“到期后不再参与新决策”且可追溯。
   */
  private sweepExpiredExemptions(): void {
    const now = this.clock.now();
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM exemptions WHERE status = 'active' AND expires_at < ?`)
        .all(now) as ExemptionRow[];
      for (const row of rows) {
        this.db.prepare(`UPDATE exemptions SET status = 'expired' WHERE id = ? AND status = 'active'`).run(row.id);
        events.push(
          this.appendEvent(row.proposal_id, 'EXEMPTION_EXPIRED', {
            exemptionId: row.id,
            consumerId: row.consumer_id,
            reason: `豁免已于 ${row.expires_at} 到期（有效期 ${row.ttl_ms}ms），不再参与新决策`,
            expiresAt: row.expires_at,
          }),
        );
      }
    });
    tx();
    this.emit(events);
  }

  private mustGetExemptionRow(id: string): ExemptionRow {
    const row = this.db.prepare('SELECT * FROM exemptions WHERE id = ?').get(id) as ExemptionRow | undefined;
    if (!row) throw new StoreError('NOT_FOUND', 404, `豁免 ${id} 不存在`);
    return row;
  }

  private exemptionRowsFor(proposalId: string): ExemptionRow[] {
    return this.db.prepare('SELECT * FROM exemptions WHERE proposal_id = ? ORDER BY requested_at, id').all(proposalId) as ExemptionRow[];
  }

  private mapExemption(r: ExemptionRow): Exemption {
    return {
      id: r.id,
      proposalId: r.proposal_id,
      candidateDigest: r.candidate_digest,
      consumerId: r.consumer_id,
      environment: r.environment,
      direction: r.direction,
      reason: r.reason,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      ttlMs: r.ttl_ms,
      expiresAt: r.expires_at,
      status: r.status,
      confirmations: JSON.parse(r.confirmations_json) as { by: string; at: number }[],
      rejectedBy: r.rejected_by,
      rejectedAt: r.rejected_at,
      rejectReason: r.reject_reason,
      revokedBy: r.revoked_by,
      revokedAt: r.revoked_at,
      revokeReason: r.revoke_reason,
    };
  }

  private viewExemption(r: ExemptionRow): ExemptionView {
    const e = this.mapExemption(r);
    return { ...e, effectiveStatus: effectiveExemptionStatus(e, this.clock.now()) };
  }

  /**
   * 决策。门禁评估、版本 CAS、快照落库在同一事务内完成：
   * 并发审批只有一个能胜出；决策快照从此不可变，后到的证据无法改变当时的结论。
   */
  decide(proposalId: string, input: DecideInput): Decision {
    if (!input.decidedBy) throw new StoreError('BAD_REQUEST', 400, 'decidedBy 不能为空');
    this.sweepExpiredExemptions();
    let decision!: Decision;
    let events: DomainEvent[] = [];
    const tx = this.db.transaction(() => {
      const p = this.mustGetRow(proposalId);
      if (p.version !== input.expectedVersion) {
        throw new StoreError('VERSION_CONFLICT', 409, `版本冲突：期望 ${input.expectedVersion}，当前 ${p.version}`);
      }
      if (p.superseded_by_id !== null) {
        throw new StoreError('PROPOSAL_SUPERSEDED', 409, `提案已被后继 ${p.superseded_by_id} 替代，不能决策；请在后继提案上操作`);
      }
      if (p.status !== 'open') {
        throw new StoreError('DECISION_ALREADY_MADE', 409, `提案已存在有效决策（${p.status}），不能重复决策`);
      }
      const compat = JSON.parse(p.compat_json) as CompatResult;
      const consumers = JSON.parse(p.consumers_json) as string[];
      const evidence = this.evidenceFor(proposalId);
      const exemptions = this.exemptionRowsFor(proposalId).map((r) => this.mapExemption(r));
      const now = this.clock.now();
      const gate = evaluateGate({
        candidateDigest: p.candidate_digest,
        consumers,
        evidence,
        compat,
        now,
        ttlMs: p.evidence_ttl_ms,
        environment: p.environment,
        exemptions,
      });
      const remaining = decisionBlockers(gate, input.action, input.acknowledgeBreaking === true);
      if (remaining.length > 0) {
        throw new StoreError('GATE_BLOCKED', 422, '门禁未通过，不能对该候选作出决策', { blockers: remaining });
      }
      const snapshot: DecisionSnapshot = {
        proposalId,
        version: p.version,
        environment: p.environment,
        baselineDigest: p.baseline_digest,
        candidateDigest: p.candidate_digest,
        compat,
        gate,
        evidenceUsed: [...latestApplicableEvidence(evidence, p.candidate_digest).values()],
        exemptionsUsed: gate.waived.map((w) => {
          const ex = exemptions.find((e) => e.id === w.exemptionId)!;
          return { ...ex, effectiveStatus: effectiveExemptionStatus(ex, now) };
        }),
        action: input.action,
        decidedBy: input.decidedBy,
        rationale: input.rationale ?? null,
        decidedAt: now,
        acknowledgeBreaking: input.acknowledgeBreaking === true,
      };
      const id = `dec_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO decisions (id, proposal_id, action, decided_by, rationale, decided_at, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, proposalId, input.action, input.decidedBy, input.rationale ?? null, now, JSON.stringify(snapshot));
      const res = this.db
        .prepare(
          `UPDATE proposals SET status = ?, version = version + 1, updated_at = ?, decision_id = ?
           WHERE id = ? AND version = ? AND status = 'open'`,
        )
        .run(input.action === 'approve' ? 'approved' : 'rejected', now, id, proposalId, input.expectedVersion);
      if (res.changes !== 1) {
        throw new StoreError('VERSION_CONFLICT', 409, '并发决策冲突，请刷新后重试');
      }
      decision = { id, proposalId, action: input.action, decidedBy: input.decidedBy, rationale: input.rationale ?? null, decidedAt: now, snapshot };
      events = [
        this.appendEvent(proposalId, 'DECISION_MADE', {
          decisionId: id,
          action: input.action,
          decidedBy: input.decidedBy,
          candidateDigest: p.candidate_digest,
          snapshotDigest: stableDigest(snapshot),
        }),
      ];
    });
    tx();
    this.emit(events);
    return decision;
  }

  getProposal(id: string): ProposalDetail | null {
    this.sweepExpiredExemptions();
    const row = this.getRow(id);
    if (!row) return null;
    return this.assemble(row);
  }

  listProposals(): ProposalDetail[] {
    this.sweepExpiredExemptions();
    const rows = this.db.prepare('SELECT * FROM proposals ORDER BY created_at, rowid').all() as ProposalRow[];
    return rows.map((r) => this.assemble(r));
  }

  /** 一致快照：单个只读事务内取全量状态，供网页重连后恢复一致视图。 */
  snapshot(): Snapshot {
    this.sweepExpiredExemptions();
    const tx = this.db.transaction(() => {
      const cursor = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS c FROM events').get() as { c: number }).c;
      return { serverTime: this.clock.now(), eventCursor: cursor, proposals: this.listProposals() };
    });
    return tx();
  }

  eventsSince(id: number): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(id) as {
      id: number;
      ts: number;
      proposal_id: string;
      type: string;
      payload_json: string;
    }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, proposalId: r.proposal_id, type: r.type, payload: JSON.parse(r.payload_json) }));
  }

  private appendEvent(proposalId: string, type: string, payload: unknown): DomainEvent {
    const ts = this.clock.now();
    const ins = this.db
      .prepare('INSERT INTO events (ts, proposal_id, type, payload_json) VALUES (?, ?, ?, ?)')
      .run(ts, proposalId, type, JSON.stringify(payload));
    return { id: Number(ins.lastInsertRowid), ts, proposalId, type, payload };
  }

  private evidenceFor(proposalId: string): EvidenceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE proposal_id = ? ORDER BY id')
      .all(proposalId) as EvidenceRow[];
    return rows.map((r) => this.mapEvidence(r));
  }

  private mapEvidence(r: EvidenceRow): EvidenceRecord {
    return {
      id: r.id,
      proposalId: r.proposal_id,
      consumerId: r.consumer_id,
      candidateDigest: r.candidate_digest,
      verdict: r.verdict,
      runId: r.run_id,
      idempotencyKey: r.idempotency_key,
      details: r.details_json === null ? undefined : JSON.parse(r.details_json),
      recordedAt: r.recorded_at,
      appliesToCurrent: r.applies_to_current === 1,
    };
  }

  private assemble(row: ProposalRow): ProposalDetail {
    const compat = JSON.parse(row.compat_json) as CompatResult;
    const consumers = JSON.parse(row.consumers_json) as string[];
    const evidence = this.evidenceFor(row.id);
    const exemptions = this.exemptionRowsFor(row.id);
    const gate = evaluateGate({
      candidateDigest: row.candidate_digest,
      consumers,
      evidence,
      compat,
      now: this.clock.now(),
      ttlMs: row.evidence_ttl_ms,
      environment: row.environment,
      exemptions: exemptions.map((r) => this.mapExemption(r)),
    });
    let decision: Decision | null = null;
    if (row.decision_id) {
      const d = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(row.decision_id) as
        | { id: string; proposal_id: string; action: DecisionAction; decided_by: string; rationale: string | null; decided_at: number; snapshot_json: string }
        | undefined;
      if (d) {
        decision = {
          id: d.id,
          proposalId: d.proposal_id,
          action: d.action,
          decidedBy: d.decided_by,
          rationale: d.rationale,
          decidedAt: d.decided_at,
          snapshot: JSON.parse(d.snapshot_json) as DecisionSnapshot,
        };
      }
    }
    return {
      id: row.id,
      title: row.title,
      status: row.status === 'open' && row.superseded_by_id !== null ? 'superseded' : row.status,
      version: row.version,
      baseline: JSON.parse(row.baseline_json),
      candidate: JSON.parse(row.candidate_json),
      baselineDigest: row.baseline_digest,
      candidateDigest: row.candidate_digest,
      compat,
      consumers,
      environment: row.environment,
      evidenceTtlMs: row.evidence_ttl_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence,
      gate,
      exemptions: exemptions.map((r) => this.viewExemption(r)),
      predecessorId: row.predecessor_id,
      supersededById: row.superseded_by_id,
      rollout: (() => {
        const ro = this.db.prepare('SELECT * FROM rollouts WHERE proposal_id = ?').get(row.id) as RolloutRow | undefined;
        return ro ? this.assembleRollout(ro) : null;
      })(),
      decision,
      events: this.eventsSinceFor(row.id),
    };
  }

  private eventsSinceFor(proposalId: string): DomainEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE proposal_id = ? ORDER BY id')
      .all(proposalId) as { id: number; ts: number; proposal_id: string; type: string; payload_json: string }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, proposalId: r.proposal_id, type: r.type, payload: JSON.parse(r.payload_json) }));
  }
}
