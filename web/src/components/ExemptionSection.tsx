import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, confirmExemption, createExemption, rejectExemption, revokeExemption } from '../api';
import type { ExemptionDirection, ExemptionView, ProposalDetail } from '../api';
import { EXEMPTION_DIRECTION_LABEL, EXEMPTION_STATUS_LABEL, formatTime, shortDigest } from '../format';

interface ExemptionSectionProps {
  proposal: ProposalDetail;
  serverTime: number;
  onRefresh: () => Promise<void>;
}

interface ExemptionCardProps {
  exemption: ExemptionView;
  serverTime: number;
  canOperate: boolean;
  onRefresh: () => Promise<void>;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.errorMessage ? err.errorMessage : fallback;
}

function ExemptionCard({ exemption, serverTime, canOperate, onRefresh }: ExemptionCardProps) {
  const [confirmBy, setConfirmBy] = useState('');
  const [actionBy, setActionBy] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remainingMs = exemption.expiresAt - serverTime;

  async function runAction(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setError(null);
      await onRefresh();
    } catch (err) {
      setError(errorText(err, '操作失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setError(null);
    if (confirmBy.trim() === '') {
      setError('请填写审核人。');
      return;
    }
    await runAction(() => confirmExemption(exemption.id, { by: confirmBy.trim() }));
  }

  async function handleReject() {
    setError(null);
    if (actionBy.trim() === '') {
      setError('请填写操作人。');
      return;
    }
    if (actionReason.trim() === '') {
      setError('请填写拒绝原因。');
      return;
    }
    await runAction(() => rejectExemption(exemption.id, { by: actionBy.trim(), reason: actionReason.trim() }));
  }

  async function handleRevoke() {
    setError(null);
    if (actionBy.trim() === '') {
      setError('请填写操作人。');
      return;
    }
    if (actionReason.trim() === '') {
      setError('请填写撤销原因。');
      return;
    }
    await runAction(() => revokeExemption(exemption.id, { by: actionBy.trim(), reason: actionReason.trim() }));
  }

  return (
    <li className="exemption-card">
      <div className="exemption-card-head">
        <span className={`badge badge-exemption-${exemption.effectiveStatus}`}>
          {EXEMPTION_STATUS_LABEL[exemption.effectiveStatus]}
        </span>
        <span className="badge badge-direction">{EXEMPTION_DIRECTION_LABEL[exemption.direction]}</span>
        <span className="mono">{exemption.consumerId}</span>
        <span className="muted">环境 {exemption.environment}</span>
        <span className="mono muted" title={exemption.id}>
          {shortDigest(exemption.id)}
        </span>
      </div>
      <dl className="summary-grid">
        <div>
          <dt>候选摘要</dt>
          <dd className="mono" title={exemption.candidateDigest}>
            {shortDigest(exemption.candidateDigest)}
          </dd>
        </div>
        <div>
          <dt>申请人</dt>
          <dd>
            {exemption.requestedBy} · {formatTime(exemption.requestedAt)}
          </dd>
        </div>
        <div>
          <dt>有效期 TTL</dt>
          <dd>{exemption.ttlMs} 毫秒</dd>
        </div>
        <div>
          <dt>到期时间</dt>
          <dd>
            {formatTime(exemption.expiresAt)}
            {remainingMs > 0 ? `（剩余 ${remainingMs} 毫秒）` : '（已到期）'}
          </dd>
        </div>
        <div>
          <dt>复核进度</dt>
          <dd>
            {exemption.confirmations.length}/2
            {exemption.confirmations.length > 0 && `：${exemption.confirmations.map((c) => c.by).join('、')}`}
            {exemption.confirmations.map((c) => (
              <div key={`${c.by}-${c.at}`} className="muted">
                {c.by} · {formatTime(c.at)}
              </div>
            ))}
          </dd>
        </div>
        <div>
          <dt>申请原因</dt>
          <dd>{exemption.reason}</dd>
        </div>
      </dl>
      {exemption.rejectedBy !== null && (
        <p className="muted exemption-terminal-note">
          拒绝人：{exemption.rejectedBy}
          {exemption.rejectedAt !== null && ` · ${formatTime(exemption.rejectedAt)}`}；拒绝原因：
          {exemption.rejectReason ?? '（无）'}
        </p>
      )}
      {exemption.revokedBy !== null && (
        <p className="muted exemption-terminal-note">
          撤销人：{exemption.revokedBy}
          {exemption.revokedAt !== null && ` · ${formatTime(exemption.revokedAt)}`}；撤销原因：
          {exemption.revokeReason ?? '（无）'}
        </p>
      )}
      {error && <div className="alert alert-error">{error}</div>}
      {canOperate && exemption.effectiveStatus === 'pending' && (
        <div className="exemption-actions">
          <div className="exemption-action-row">
            <input
              type="text"
              value={confirmBy}
              onChange={(e) => setConfirmBy(e.target.value)}
              placeholder="审核人（不能与申请人相同）"
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleConfirm()}>
              确认
            </button>
          </div>
          <div className="exemption-action-row">
            <input
              type="text"
              value={actionBy}
              onChange={(e) => setActionBy(e.target.value)}
              placeholder="操作人"
            />
            <input
              type="text"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              placeholder="拒绝原因"
            />
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void handleReject()}>
              拒绝
            </button>
          </div>
        </div>
      )}
      {canOperate && exemption.effectiveStatus === 'active' && (
        <div className="exemption-actions">
          <div className="exemption-action-row">
            <input
              type="text"
              value={actionBy}
              onChange={(e) => setActionBy(e.target.value)}
              placeholder="操作人"
            />
            <input
              type="text"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              placeholder="撤销原因"
            />
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void handleRevoke()}>
              撤销
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ExemptionSection({ proposal, serverTime, onRefresh }: ExemptionSectionProps) {
  const isOpen = proposal.status === 'open';

  const [consumerId, setConsumerId] = useState(proposal.consumers[0] ?? '');
  const [direction, setDirection] = useState<ExemptionDirection>('backward');
  const [environment, setEnvironment] = useState(proposal.environment);
  const [ttlText, setTtlText] = useState('');
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (consumerId === '') {
      setError('请选择消费方。');
      return;
    }
    if (ttlText.trim() === '') {
      setError('请填写有效期 TTL（毫秒）。');
      return;
    }
    const ttlMs = Number(ttlText.trim());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      setError('有效期 TTL 需为正数毫秒。');
      return;
    }
    if (reason.trim() === '') {
      setError('请填写申请原因。');
      return;
    }
    if (requestedBy.trim() === '') {
      setError('请填写申请人。');
      return;
    }
    setBusy(true);
    try {
      await createExemption(proposal.id, {
        consumerId,
        direction,
        reason: reason.trim(),
        requestedBy: requestedBy.trim(),
        ttlMs,
        environment: environment.trim() === '' ? undefined : environment.trim(),
      });
      setTtlText('');
      setReason('');
      await onRefresh();
    } catch (err) {
      setError(errorText(err, '申请豁免失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2 className="panel-title">限时豁免</h2>
      <p className="muted">
        豁免由两名不同审核人共同确认后生效，仅覆盖指定候选摘要、消费方、环境与兼容方向；到期或被撤销后不再参与新决策，历史决策快照保持原样。
      </p>
      {isOpen &&
        (proposal.consumers.length === 0 ? (
          <p className="muted">该提案未声明消费方，无法申请豁免。</p>
        ) : (
          <form
            className="exemption-form"
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
          >
            <h3 className="panel-subtitle">申请豁免</h3>
            <div className="exemption-form-grid">
              <label className="field">
                <span className="field-label">消费方</span>
                <select value={consumerId} onChange={(e) => setConsumerId(e.target.value)}>
                  {proposal.consumers.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">兼容方向</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value as ExemptionDirection)}>
                  <option value="backward">backward（消费方方向）</option>
                  <option value="forward">forward（生产方方向）</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">环境</span>
                <input
                  type="text"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  placeholder={proposal.environment}
                />
              </label>
              <label className="field">
                <span className="field-label">有效期 TTL（毫秒）</span>
                <input
                  type="number"
                  min="1"
                  value={ttlText}
                  onChange={(e) => setTtlText(e.target.value)}
                  placeholder="例如：86400000"
                />
              </label>
              <label className="field">
                <span className="field-label">申请人</span>
                <input
                  type="text"
                  value={requestedBy}
                  onChange={(e) => setRequestedBy(e.target.value)}
                  placeholder="例如：order-owner"
                />
              </label>
              <label className="field">
                <span className="field-label">申请原因</span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="例如：消费方迁移窗口期临时豁免"
                />
              </label>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="button-row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '提交中…' : '提交豁免申请'}
              </button>
            </div>
          </form>
        ))}
      {proposal.exemptions.length === 0 ? (
        <p className="muted">暂无豁免单。</p>
      ) : (
        <ul className="exemption-list">
          {proposal.exemptions.map((ex) => (
            <ExemptionCard key={ex.id} exemption={ex} serverTime={serverTime} canOperate={isOpen} onRefresh={onRefresh} />
          ))}
        </ul>
      )}
    </section>
  );
}
