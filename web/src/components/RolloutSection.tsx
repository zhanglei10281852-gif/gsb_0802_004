import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, createRollout, pauseRollout, resumeRollout, retryWave, rollbackRollout } from '../api';
import type { ProposalDetail, RolloutDetail } from '../api';
import {
  PAUSE_REASON_LABEL,
  RECEIPT_OUTCOME_LABEL,
  RECEIPT_RESULT_LABEL,
  REVALIDATION_STATUS_LABEL,
  ROLLOUT_STATUS_LABEL,
  WAVE_STATUS_LABEL,
  formatTime,
  shortDigest,
} from '../format';

interface RolloutSectionProps {
  proposal: ProposalDetail;
  onRefresh: () => Promise<void>;
}

interface WaveRow {
  name: string;
  environment: string;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.errorMessage ? err.errorMessage : fallback;
}

function resumeErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 422 && err.errorCode === 'COVERAGE_GAP') {
    const gaps = err.coverageGapRevalidations;
    if (gaps.length > 0) {
      const detail = gaps.map((g) => `${g.consumerId}=${REVALIDATION_STATUS_LABEL[g.status]}`).join('、');
      return `覆盖缺口未关闭：${detail}`;
    }
    return err.errorMessage ?? '覆盖缺口未关闭，恢复被阻止。';
  }
  return errorText(err, '操作失败，请稍后重试。');
}

function RolloutCreateForm({ proposal, onRefresh }: RolloutSectionProps) {
  const [waveRows, setWaveRows] = useState<WaveRow[]>([{ name: '', environment: '' }]);
  const [createdBy, setCreatedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(index: number, patch: Partial<WaveRow>) {
    setWaveRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setWaveRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const waves = waveRows.map((row) => ({ name: row.name.trim(), environment: row.environment.trim() }));
    if (waves.some((w) => w.name === '' || w.environment === '')) {
      setError('请填写每个波次的名称与环境。');
      return;
    }
    if (createdBy.trim() === '') {
      setError('请填写创建人。');
      return;
    }
    setBusy(true);
    try {
      await createRollout(proposal.id, { waves, createdBy: createdBy.trim() });
      await onRefresh();
    } catch (err) {
      setError(errorText(err, '创建发布失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <p className="muted">
        波次将按顺序连续部署；部署适配器回传成功/失败/未知回执，仅绑定同一决策快照的当前波次回执才能推进；重复与乱序回执会被隔离记录。
      </p>
      <h3 className="panel-subtitle">波次编排</h3>
      {waveRows.map((row, i) => (
        <div className="wave-row" key={i}>
          <span className="wave-row-ordinal mono muted">{i + 1}</span>
          <input
            type="text"
            value={row.name}
            onChange={(e) => updateRow(i, { name: e.target.value })}
            placeholder="波次名称，例如：第一波-内部"
          />
          <input
            type="text"
            value={row.environment}
            onChange={(e) => updateRow(i, { environment: e.target.value })}
            placeholder="环境，例如：staging"
          />
          <button type="button" className="btn" disabled={busy || waveRows.length <= 1} onClick={() => removeRow(i)}>
            删除
          </button>
        </div>
      ))}
      <div className="button-row">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => setWaveRows((rows) => [...rows, { name: '', environment: '' }])}
        >
          添加波次
        </button>
      </div>
      <label className="field">
        <span className="field-label">创建人</span>
        <input
          type="text"
          value={createdBy}
          onChange={(e) => setCreatedBy(e.target.value)}
          placeholder="例如：release-ops"
        />
      </label>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '创建中…' : '创建发布'}
        </button>
      </div>
    </form>
  );
}

function RolloutDetailPanel({ rollout, onRefresh }: { rollout: RolloutDetail; onRefresh: () => Promise<void> }) {
  const [opBy, setOpBy] = useState('');
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState('0');
  const [rollbackBy, setRollbackBy] = useState('');
  const [rollbackReason, setRollbackReason] = useState('');
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const waves = [...rollout.waves].sort((a, b) => a.ordinal - b.ordinal);
  const receipts = [...rollout.receipts].sort((a, b) => a.id - b.id);
  const waveById = new Map(rollout.waves.map((w) => [w.id, w]));
  const currentWave = rollout.waves.find((w) => w.ordinal === rollout.currentOrdinal) ?? null;
  const canRetry =
    currentWave !== null && (currentWave.status === 'failed' || currentWave.status === 'unknown');
  const showOpBy = rollout.status === 'active' || rollout.status === 'paused' || canRetry;
  const succeededWaves = waves.filter((w) => w.status === 'succeeded');

  async function runAction(action: () => Promise<unknown>, mapError?: (err: unknown) => string) {
    setOpBusy(true);
    try {
      await action();
      setOpError(null);
      await onRefresh();
    } catch (err) {
      setOpError(mapError ? mapError(err) : errorText(err, '操作失败，请稍后重试。'));
    } finally {
      setOpBusy(false);
    }
  }

  async function handlePauseResumeResume(kind: 'pause' | 'resume' | 'retry') {
    setOpError(null);
    if (opBy.trim() === '') {
      setOpError('请填写操作人。');
      return;
    }
    const by = opBy.trim();
    if (kind === 'pause') {
      await runAction(() => pauseRollout(rollout.id, { by }));
    } else if (kind === 'resume') {
      await runAction(() => resumeRollout(rollout.id, { by }), resumeErrorText);
    } else if (currentWave) {
      await runAction(() => retryWave(rollout.id, currentWave.id, { by }));
    }
  }

  async function handleRollback(e: FormEvent) {
    e.preventDefault();
    setRollbackError(null);
    if (rollbackBy.trim() === '') {
      setRollbackError('请填写操作人。');
      return;
    }
    setRollbackBusy(true);
    try {
      await rollbackRollout(rollout.id, {
        toWaveOrdinal: Number(rollbackTarget),
        by: rollbackBy.trim(),
        reason: rollbackReason.trim() === '' ? undefined : rollbackReason.trim(),
      });
      setRollbackOpen(false);
      await onRefresh();
    } catch (err) {
      setRollbackError(errorText(err, '回退失败，请稍后重试。'));
    } finally {
      setRollbackBusy(false);
    }
  }

  return (
    <div className="rollout-detail">
      {rollout.status === 'paused' && (
        <div className="alert alert-warning rollout-pause-alert">
          {rollout.pausedReason !== null ? PAUSE_REASON_LABEL[rollout.pausedReason] : ROLLOUT_STATUS_LABEL.paused}
        </div>
      )}
      <dl className="summary-grid">
        <div>
          <dt>发布状态</dt>
          <dd>
            <span className={`badge badge-rollout-${rollout.status}`}>{ROLLOUT_STATUS_LABEL[rollout.status]}</span>
          </dd>
        </div>
        <div>
          <dt>当前波次序号</dt>
          <dd className="mono">{rollout.currentOrdinal}</dd>
        </div>
        <div>
          <dt>决策快照</dt>
          <dd className="mono" title={rollout.decisionId}>
            {shortDigest(rollout.decisionId)}
          </dd>
        </div>
        <div>
          <dt>候选摘要</dt>
          <dd className="mono" title={rollout.candidateDigest}>
            {shortDigest(rollout.candidateDigest)}
          </dd>
        </div>
        <div>
          <dt>创建人</dt>
          <dd>{rollout.createdBy}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatTime(rollout.createdAt)}</dd>
        </div>
        {rollout.status === 'rolled_back' && (
          <>
            <div>
              <dt>回退目标波次</dt>
              <dd>{rollout.rolledBackTo === 0 ? '发布前' : `第 ${rollout.rolledBackTo ?? '—'} 波`}</dd>
            </div>
            <div>
              <dt>回退操作人</dt>
              <dd>{rollout.rolledBackBy ?? '—'}</dd>
            </div>
            <div>
              <dt>回退原因</dt>
              <dd>{rollout.rollbackReason ?? '（无）'}</dd>
            </div>
            <div>
              <dt>回退时间</dt>
              <dd>{rollout.rolledBackAt !== null ? formatTime(rollout.rolledBackAt) : '—'}</dd>
            </div>
          </>
        )}
      </dl>

      <h3 className="panel-subtitle">波次时间线</h3>
      {waves.length === 0 ? (
        <p className="muted">暂无波次。</p>
      ) : (
        <ul className="wave-list">
          {waves.map((w) => {
            const isCurrent =
              w.ordinal === rollout.currentOrdinal &&
              (rollout.status === 'active' || rollout.status === 'paused');
            return (
              <li key={w.id} className={`wave-item${isCurrent ? ' wave-item-current' : ''}`}>
                <span className="wave-ordinal mono">#{w.ordinal}</span>
                <span className="wave-name">{w.name}</span>
                <span className="badge badge-env">{w.environment}</span>
                <span className={`badge badge-wave-${w.status}`}>{WAVE_STATUS_LABEL[w.status]}</span>
                {w.retryCount > 0 && <span className="wave-retry muted">重试 {w.retryCount} 次</span>}
                <span className="wave-meta muted">开始：{w.startedAt !== null ? formatTime(w.startedAt) : '—'}</span>
                <span className="wave-meta muted">
                  完成：{w.finishedAt !== null ? formatTime(w.finishedAt) : '—'}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rollout-actions">
        {showOpBy && (
          <label className="field">
            <span className="field-label">操作人</span>
            <input
              type="text"
              value={opBy}
              onChange={(e) => setOpBy(e.target.value)}
              placeholder="例如：release-ops"
            />
          </label>
        )}
        <div className="button-row">
          {rollout.status === 'active' && (
            <button
              type="button"
              className="btn"
              disabled={opBusy}
              onClick={() => void handlePauseResumeResume('pause')}
            >
              暂停
            </button>
          )}
          {rollout.status === 'paused' && (
            <button
              type="button"
              className="btn"
              disabled={opBusy}
              onClick={() => void handlePauseResumeResume('resume')}
            >
              恢复
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={opBusy}
              onClick={() => void handlePauseResumeResume('retry')}
            >
              重试当前波次
            </button>
          )}
          {rollout.status !== 'rolled_back' && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={opBusy || rollbackBusy}
              onClick={() => {
                setRollbackError(null);
                setRollbackOpen((v) => !v);
              }}
            >
              {rollbackOpen ? '取消回退' : '回退'}
            </button>
          )}
        </div>
        {opError && <div className="alert alert-error">{opError}</div>}
        {rollbackOpen && rollout.status !== 'rolled_back' && (
          <form
            className="rollback-form"
            onSubmit={(e) => {
              void handleRollback(e);
            }}
          >
            <div className="exemption-form-grid">
              <label className="field">
                <span className="field-label">目标波次</span>
                <select value={rollbackTarget} onChange={(e) => setRollbackTarget(e.target.value)}>
                  <option value="0">0：回到发布前</option>
                  {succeededWaves.map((w) => (
                    <option key={w.id} value={String(w.ordinal)}>
                      {w.ordinal}：{w.name}（{w.environment}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">操作人</span>
                <input
                  type="text"
                  value={rollbackBy}
                  onChange={(e) => setRollbackBy(e.target.value)}
                  placeholder="例如：release-ops"
                />
              </label>
              <label className="field">
                <span className="field-label">原因</span>
                <input
                  type="text"
                  value={rollbackReason}
                  onChange={(e) => setRollbackReason(e.target.value)}
                  placeholder="可空"
                />
              </label>
            </div>
            {rollbackError && <div className="alert alert-error">{rollbackError}</div>}
            <div className="button-row">
              <button type="submit" className="btn btn-danger" disabled={rollbackBusy}>
                {rollbackBusy ? '回退中…' : '确认回退'}
              </button>
            </div>
          </form>
        )}
      </div>

      <h3 className="panel-subtitle">回执</h3>
      {receipts.length === 0 ? (
        <p className="muted">暂无回执。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>波次序号</th>
              <th>结果</th>
              <th>处理结果</th>
              <th>接收时间</th>
              <th>回执键</th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => {
              const wave = waveById.get(r.waveId);
              return (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td className="mono">{wave ? wave.ordinal : '—'}</td>
                  <td>
                    <span className={`badge badge-receipt-${r.result}`}>{RECEIPT_RESULT_LABEL[r.result]}</span>
                  </td>
                  <td>
                    <span className={`badge badge-outcome-${r.outcome}`}>{RECEIPT_OUTCOME_LABEL[r.outcome]}</span>
                  </td>
                  <td>{formatTime(r.receivedAt)}</td>
                  <td className="mono" title={r.receiptKey}>
                    {shortDigest(r.receiptKey)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function RolloutSection({ proposal, onRefresh }: RolloutSectionProps) {
  return (
    <section className="panel">
      <h2 className="panel-title">分阶段发布</h2>
      {proposal.rollout ? (
        <RolloutDetailPanel rollout={proposal.rollout} onRefresh={onRefresh} />
      ) : proposal.status === 'approved' ? (
        <RolloutCreateForm proposal={proposal} onRefresh={onRefresh} />
      ) : (
        <p className="muted">提案经批准后可创建分阶段发布。</p>
      )}
    </section>
  );
}
