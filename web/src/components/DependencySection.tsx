import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, addDependency, concludeRevalidation } from '../api';
import type { ProposalDetail, Revalidation, Verdict } from '../api';
import { REVALIDATION_STATUS_LABEL, formatTime, shortDigest } from '../format';

interface DependencySectionProps {
  proposal: ProposalDetail;
  onRefresh: () => Promise<void>;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.errorMessage ? err.errorMessage : fallback;
}

function RevalidationCard({
  revalidation,
  onRefresh,
}: {
  revalidation: Revalidation;
  onRefresh: () => Promise<void>;
}) {
  const [verdict, setVerdict] = useState<Verdict>('pass');
  const [runId, setRunId] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [by, setBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleConclude(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (runId.trim() === '') {
      setError('请填写运行 ID。');
      return;
    }
    if (idempotencyKey.trim() === '') {
      setError('请填写幂等键。');
      return;
    }
    setBusy(true);
    try {
      const res = await concludeRevalidation(revalidation.id, {
        verdict,
        runId: runId.trim(),
        idempotencyKey: idempotencyKey.trim(),
        by: by.trim() === '' ? undefined : by.trim(),
      });
      if (res.outcome === 'duplicate') {
        setNotice('重复报送已去重。');
      } else if (res.outcome === 'closed') {
        setNotice('已有结论，迟到报送被隔离。');
      }
      setRunId('');
      setIdempotencyKey('');
      await onRefresh();
    } catch (err) {
      setError(errorText(err, '提交再验证结论失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="revalidation-card">
      <div className="revalidation-card-head">
        <span className={`badge badge-revalidation-${revalidation.status}`}>
          {REVALIDATION_STATUS_LABEL[revalidation.status]}
        </span>
        <span className="mono">{revalidation.consumerId}</span>
        <span className="mono muted" title={revalidation.candidateDigest}>
          候选 {shortDigest(revalidation.candidateDigest)}
        </span>
      </div>
      <dl className="summary-grid">
        <div>
          <dt>添加人 / 时间</dt>
          <dd>
            {revalidation.addedBy} · {formatTime(revalidation.addedAt)}
          </dd>
        </div>
        <div>
          <dt>原因</dt>
          <dd>{revalidation.reason ?? '（无）'}</dd>
        </div>
        {revalidation.status !== 'pending' && (
          <>
            <div>
              <dt>结论</dt>
              <dd>
                {revalidation.verdict !== null ? (
                  <span className={`badge ${revalidation.verdict === 'pass' ? 'badge-pass' : 'badge-fail'}`}>
                    {revalidation.verdict === 'pass' ? '通过' : '未通过'}
                  </span>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>结论时间</dt>
              <dd>{revalidation.concludedAt !== null ? formatTime(revalidation.concludedAt) : '—'}</dd>
            </div>
            <div>
              <dt>幂等键</dt>
              <dd className="mono" title={revalidation.evidenceKey ?? undefined}>
                {revalidation.evidenceKey !== null ? shortDigest(revalidation.evidenceKey) : '—'}
              </dd>
            </div>
          </>
        )}
      </dl>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-info">{notice}</div>}
      {revalidation.status === 'pending' && (
        <form
          className="revalidation-actions"
          onSubmit={(e) => {
            void handleConclude(e);
          }}
        >
          <div className="exemption-form-grid">
            <label className="field">
              <span className="field-label">结论</span>
              <select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
                <option value="pass">验证通过</option>
                <option value="fail">验证未通过</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">运行 ID</span>
              <input
                type="text"
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                placeholder="例如：run-20260802-01"
              />
            </label>
            <label className="field">
              <span className="field-label">幂等键（必填）</span>
              <input
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="例如：reval-fraud-0001"
              />
            </label>
            <label className="field">
              <span className="field-label">操作人</span>
              <input
                type="text"
                value={by}
                onChange={(e) => setBy(e.target.value)}
                placeholder="可空，例如：fraud-owner"
              />
            </label>
          </div>
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '提交中…' : '提交再验证结论'}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

export function DependencySection({ proposal, onRefresh }: DependencySectionProps) {
  const canAddDependency = proposal.status === 'open' || proposal.status === 'approved';

  const [consumerId, setConsumerId] = useState('');
  const [by, setBy] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedRevalidations = [...proposal.revalidations].sort((a, b) => a.addedAt - b.addedAt);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (consumerId.trim() === '') {
      setError('请填写消费方 ID。');
      return;
    }
    if (by.trim() === '') {
      setError('请填写操作人。');
      return;
    }
    setBusy(true);
    try {
      await addDependency(proposal.id, {
        consumerId: consumerId.trim(),
        by: by.trim(),
        reason: reason.trim() === '' ? undefined : reason.trim(),
      });
      setConsumerId('');
      setReason('');
      await onRefresh();
    } catch (err) {
      setError(errorText(err, '添加必需依赖失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2 className="panel-title">依赖拓扑与再验证</h2>
      <p className="muted">
        新必需消费方产生覆盖缺口时，尚未开始的波次自动暂停；该消费方针对当前候选的再验证结论在同一提案谱系上可追溯，历史决策快照不受影响。
      </p>

      <h3 className="panel-subtitle">当前必需消费方</h3>
      {proposal.consumers.length === 0 ? (
        <p className="muted">该提案未声明消费方。</p>
      ) : (
        <div className="dependency-consumer-list">
          {proposal.consumers.map((c) => (
            <span key={c} className="badge badge-consumer mono">
              {c}
            </span>
          ))}
        </div>
      )}

      {canAddDependency && (
        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <h3 className="panel-subtitle">添加必需依赖</h3>
          <div className="exemption-form-grid">
            <label className="field">
              <span className="field-label">消费方 ID</span>
              <input
                type="text"
                value={consumerId}
                onChange={(e) => setConsumerId(e.target.value)}
                placeholder="例如：fraud"
              />
            </label>
            <label className="field">
              <span className="field-label">操作人</span>
              <input
                type="text"
                value={by}
                onChange={(e) => setBy(e.target.value)}
                placeholder="例如：release-lead"
              />
            </label>
            <label className="field">
              <span className="field-label">原因</span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="可空，例如：新消费方接入契约"
              />
            </label>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '提交中…' : '添加必需依赖'}
            </button>
          </div>
        </form>
      )}

      <h3 className="panel-subtitle">再验证列表</h3>
      {sortedRevalidations.length === 0 ? (
        <p className="muted">暂无再验证记录。</p>
      ) : (
        <ul className="revalidation-list">
          {sortedRevalidations.map((rv) => (
            <RevalidationCard key={rv.id} revalidation={rv} onRefresh={onRefresh} />
          ))}
        </ul>
      )}
    </section>
  );
}
