import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, submitDecision, submitRevision } from '../api';
import type { Blocker, EvidenceRecord, ProposalDetail, WaivedBlocker } from '../api';
import {
  BLOCKER_CODE_LABEL,
  COMPAT_STATUS_LABEL,
  DECISION_ACTION_LABEL,
  EVENT_TYPE_LABEL,
  PROPOSAL_STATUS_LABEL,
  formatTime,
  shortDigest,
} from '../format';
import { ExemptionSection } from './ExemptionSection';

interface ProposalDetailViewProps {
  proposal: ProposalDetail;
  serverTime: number;
  onRefresh: () => Promise<void>;
}

function BlockerList({ blockers }: { blockers: Blocker[] }) {
  return (
    <ul className="blocker-list">
      {blockers.map((b, i) => (
        <li key={`${b.code}-${b.consumer ?? ''}-${i}`} className="blocker-item">
          <code className="blocker-code">{b.code}</code>
          <span className="blocker-label">{BLOCKER_CODE_LABEL[b.code]}</span>
          {b.consumer && <span className="blocker-consumer">{b.consumer}</span>}
          <span className="blocker-message">{b.message}</span>
        </li>
      ))}
    </ul>
  );
}

function WaivedList({ waived }: { waived: WaivedBlocker[] }) {
  return (
    <ul className="blocker-list">
      {waived.map((b, i) => (
        <li key={`${b.exemptionId}-${b.code}-${b.consumer ?? ''}-${i}`} className="blocker-item waived-item">
          <code className="blocker-code waived-code">{b.code}</code>
          <span className="blocker-label">{BLOCKER_CODE_LABEL[b.code]}</span>
          {b.consumer && <span className="blocker-consumer">{b.consumer}</span>}
          <span className="badge badge-waived">已豁免</span>
          <span className="blocker-message">{b.message}</span>
          <span className="waived-cover">
            由豁免单 <span className="mono" title={b.exemptionId}>{shortDigest(b.exemptionId)}</span> 覆盖，复核人：
            {b.confirmedBy.join('、')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ProposalDetailView({ proposal, serverTime, onRefresh }: ProposalDetailViewProps) {
  const [decidedBy, setDecidedBy] = useState('');
  const [rationale, setRationale] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  const [decisionBlockers, setDecisionBlockers] = useState<Blocker[]>([]);

  const [revisionText, setRevisionText] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionNotice, setRevisionNotice] = useState<string | null>(null);

  const gateReady = proposal.gate.status === 'ready';
  const isBreaking = proposal.compat.status === 'breaking';
  const isOpen = proposal.status === 'open';

  const approveDisabled = decisionBusy || !gateReady || (isBreaking && !acknowledged);
  const rejectBlockers = proposal.gate.blockers.filter(
    (b) => b.code === 'missing_evidence' || b.code === 'stale_evidence',
  );
  const rejectDisabled = decisionBusy || rejectBlockers.length > 0;

  let approveHint: string | null = null;
  if (!gateReady) {
    approveHint = '门禁未就绪，暂不可批准，请先解决下方阻塞原因。';
  } else if (isBreaking && !acknowledged) {
    approveHint = '存在破坏性变更，需勾选「我已知晓破坏性变更」后方可批准。';
  }
  const rejectHint = rejectBlockers.length > 0 ? '存在缺少证据或证据过期的阻塞项，暂不可驳回。' : null;

  // 证据矩阵：仅取针对当前候选且适用的最新一条
  const currentEvidence = new Map<string, EvidenceRecord>();
  const nonApplicable: EvidenceRecord[] = [];
  for (const ev of proposal.evidence) {
    if (!ev.appliesToCurrent || ev.candidateDigest !== proposal.candidateDigest) {
      nonApplicable.push(ev);
      continue;
    }
    const prev = currentEvidence.get(ev.consumerId);
    if (!prev || ev.recordedAt > prev.recordedAt || (ev.recordedAt === prev.recordedAt && ev.id > prev.id)) {
      currentEvidence.set(ev.consumerId, ev);
    }
  }

  const sortedEvents = [...proposal.events].sort((a, b) => a.id - b.id);

  async function handleDecision(action: 'approve' | 'reject') {
    setDecisionError(null);
    setDecisionNotice(null);
    setDecisionBlockers([]);
    if (decidedBy.trim() === '') {
      setDecisionError('请填写决策人。');
      return;
    }
    setDecisionBusy(true);
    try {
      await submitDecision(proposal.id, {
        action,
        decidedBy: decidedBy.trim(),
        expectedVersion: proposal.version,
        rationale: rationale.trim() === '' ? undefined : rationale.trim(),
        acknowledgeBreaking: isBreaking ? acknowledged : undefined,
      });
      setDecisionNotice('决策已提交。');
      await onRefresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDecisionNotice('版本冲突或已有决策，已刷新。');
        await onRefresh();
      } else if (err instanceof ApiError && err.status === 422) {
        setDecisionError(err.errorMessage ?? '门禁未通过，决策被阻止。');
        setDecisionBlockers(err.blockers);
      } else {
        setDecisionError('提交决策失败，请稍后重试。');
      }
    } finally {
      setDecisionBusy(false);
    }
  }

  async function handleRevisionSubmit(e: FormEvent) {
    e.preventDefault();
    setRevisionError(null);
    setRevisionNotice(null);
    let candidate: unknown;
    try {
      candidate = JSON.parse(revisionText);
    } catch {
      setRevisionError('候选 JSON 非法，请检查后再提交。');
      return;
    }
    setRevisionBusy(true);
    try {
      await submitRevision(proposal.id, { candidate, expectedVersion: proposal.version });
      setRevisionText('');
      setRevisionNotice('新修订已提交。');
      await onRefresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRevisionNotice('版本冲突，已刷新。');
        await onRefresh();
      } else {
        setRevisionError(
          err instanceof ApiError && err.errorMessage ? err.errorMessage : '提交修订失败，请稍后重试。',
        );
      }
    } finally {
      setRevisionBusy(false);
    }
  }

  return (
    <div className="detail">
      <header className="detail-header">
        <h1 className="detail-title">{proposal.title}</h1>
        <div className="detail-header-badges">
          <span className={`badge badge-status-${proposal.status}`}>{PROPOSAL_STATUS_LABEL[proposal.status]}</span>
          <span className={`badge ${gateReady ? 'badge-ready' : 'badge-blocked'}`}>{gateReady ? '就绪' : '阻塞'}</span>
        </div>
      </header>

      <section className="panel">
        <h2 className="panel-title">摘要</h2>
        <dl className="summary-grid">
          <div>
            <dt>状态</dt>
            <dd>{PROPOSAL_STATUS_LABEL[proposal.status]}</dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>v{proposal.version}</dd>
          </div>
          <div>
            <dt>基线摘要</dt>
            <dd className="mono" title={proposal.baselineDigest}>
              {shortDigest(proposal.baselineDigest)}
            </dd>
          </div>
          <div>
            <dt>候选摘要</dt>
            <dd className="mono" title={proposal.candidateDigest}>
              {shortDigest(proposal.candidateDigest)}
            </dd>
          </div>
          <div>
            <dt>环境</dt>
            <dd>{proposal.environment}</dd>
          </div>
          <div>
            <dt>证据 TTL</dt>
            <dd>{proposal.evidenceTtlMs} 毫秒</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatTime(proposal.createdAt)}</dd>
          </div>
          <div>
            <dt>更新时间</dt>
            <dd>{formatTime(proposal.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2 className="panel-title">兼容性结果</h2>
        <p>
          <span className={`badge ${isBreaking ? 'badge-breaking' : 'badge-compatible'}`}>
            {COMPAT_STATUS_LABEL[proposal.compat.status]}
          </span>
        </p>
        {proposal.compat.findings.length === 0 ? (
          <p className="muted">无兼容性发现。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>路径</th>
                <th>规则</th>
                <th>破坏性</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {proposal.compat.findings.map((f, i) => (
                <tr key={`${f.path}-${f.rule}-${i}`}>
                  <td className="mono">{f.path}</td>
                  <td className="mono">{f.rule}</td>
                  <td>{f.breaking ? <span className="badge badge-breaking">是</span> : '否'}</td>
                  <td>{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">消费方证据矩阵</h2>
        {proposal.consumers.length === 0 ? (
          <p className="muted">该提案未声明消费方。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>消费方</th>
                <th>判定</th>
                <th>报送时间</th>
                <th>新鲜度</th>
                <th>运行 ID</th>
                <th>幂等键</th>
              </tr>
            </thead>
            <tbody>
              {proposal.consumers.map((consumer) => {
                const ev = currentEvidence.get(consumer);
                if (!ev) {
                  return (
                    <tr key={consumer}>
                      <td className="mono">{consumer}</td>
                      <td colSpan={5} className="muted">
                        未报送
                      </td>
                    </tr>
                  );
                }
                const fresh = serverTime - ev.recordedAt <= proposal.evidenceTtlMs;
                return (
                  <tr key={consumer}>
                    <td className="mono">{consumer}</td>
                    <td>
                      <span className={`badge ${ev.verdict === 'pass' ? 'badge-pass' : 'badge-fail'}`}>
                        {ev.verdict === 'pass' ? '通过' : '未通过'}
                      </span>
                    </td>
                    <td>{formatTime(ev.recordedAt)}</td>
                    <td>
                      <span className={`badge ${fresh ? 'badge-fresh' : 'badge-stale'}`}>{fresh ? '新鲜' : '过期'}</span>
                    </td>
                    <td className="mono">{ev.runId}</td>
                    <td className="mono">{ev.idempotencyKey}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {nonApplicable.length > 0 && (
          <div>
            <h3 className="panel-subtitle">不适用证据（不影响当前门禁）</h3>
            <p className="muted">以下证据针对旧候选或已关闭，不参与当前门禁判定。</p>
            <table className="table table-dim">
              <thead>
                <tr>
                  <th>消费方</th>
                  <th>候选摘要</th>
                  <th>判定</th>
                  <th>报送时间</th>
                  <th>运行 ID</th>
                </tr>
              </thead>
              <tbody>
                {nonApplicable.map((ev) => (
                  <tr key={ev.id}>
                    <td className="mono">{ev.consumerId}</td>
                    <td className="mono" title={ev.candidateDigest}>
                      {shortDigest(ev.candidateDigest)}
                    </td>
                    <td>{ev.verdict === 'pass' ? '通过' : '未通过'}</td>
                    <td>{formatTime(ev.recordedAt)}</td>
                    <td className="mono">{ev.runId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(!gateReady || proposal.gate.waived.length > 0) && (
        <section className="panel">
          <h2 className="panel-title">阻塞原因</h2>
          {proposal.gate.blockers.length > 0 && <BlockerList blockers={proposal.gate.blockers} />}
          {proposal.gate.waived.length > 0 && (
            <div>
              <h3 className="panel-subtitle">已豁免</h3>
              <p className="muted">以下阻塞项被生效中的豁免抵消，不再参与当前门禁判定。</p>
              <WaivedList waived={proposal.gate.waived} />
            </div>
          )}
        </section>
      )}

      <ExemptionSection proposal={proposal} serverTime={serverTime} onRefresh={onRefresh} />

      {isOpen && (
        <section className="panel">
          <h2 className="panel-title">决策</h2>
          <label className="field">
            <span className="field-label">决策人</span>
            <input
              type="text"
              value={decidedBy}
              onChange={(e) => setDecidedBy(e.target.value)}
              placeholder="例如：release-lead"
            />
          </label>
          <label className="field">
            <span className="field-label">理由</span>
            <input
              type="text"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="可空"
            />
          </label>
          {isBreaking && (
            <label className="field field-checkbox">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>我已知晓破坏性变更</span>
            </label>
          )}
          <div className="button-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={approveDisabled}
              onClick={() => void handleDecision('approve')}
            >
              批准
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={rejectDisabled}
              onClick={() => void handleDecision('reject')}
            >
              驳回
            </button>
          </div>
          {approveHint && <p className="muted">{approveHint}</p>}
          {rejectHint && <p className="muted">{rejectHint}</p>}
          {decisionNotice && <div className="alert alert-info">{decisionNotice}</div>}
          {decisionError && <div className="alert alert-error">{decisionError}</div>}
          {decisionBlockers.length > 0 && <BlockerList blockers={decisionBlockers} />}
        </section>
      )}

      {proposal.decision && (
        <section className="panel">
          <h2 className="panel-title">不可变决策快照</h2>
          <dl className="summary-grid">
            <div>
              <dt>动作</dt>
              <dd>{DECISION_ACTION_LABEL[proposal.decision.action]}</dd>
            </div>
            <div>
              <dt>决策人</dt>
              <dd>{proposal.decision.decidedBy}</dd>
            </div>
            <div>
              <dt>决策时间</dt>
              <dd>{formatTime(proposal.decision.decidedAt)}</dd>
            </div>
            <div>
              <dt>理由</dt>
              <dd>{proposal.decision.rationale ?? '（无）'}</dd>
            </div>
          </dl>
          <p className="muted">该快照在决策时固化，之后到达的证据不会改变该快照。</p>
          <pre className="json-view">{JSON.stringify(proposal.decision.snapshot, null, 2)}</pre>
        </section>
      )}

      {isOpen && (
        <section className="panel">
          <h2 className="panel-title">修订候选</h2>
          <form
            onSubmit={(e) => {
              void handleRevisionSubmit(e);
            }}
          >
            <label className="field">
              <span className="field-label">新候选 JSON</span>
              <textarea
                rows={8}
                value={revisionText}
                onChange={(e) => setRevisionText(e.target.value)}
                placeholder='{"type":"object","properties":{}}'
              />
            </label>
            {revisionNotice && <div className="alert alert-info">{revisionNotice}</div>}
            {revisionError && <div className="alert alert-error">{revisionError}</div>}
            <div className="button-row">
              <button type="submit" className="btn" disabled={revisionBusy}>
                {revisionBusy ? '提交中…' : '提交新修订'}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">事件时间线</h2>
        {sortedEvents.length === 0 ? (
          <p className="muted">暂无事件。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>时间</th>
                <th>类型</th>
                <th>负载</th>
              </tr>
            </thead>
            <tbody>
              {sortedEvents.map((ev) => {
                const payloadText = JSON.stringify(ev.payload);
                return (
                  <tr key={ev.id}>
                    <td className="mono">{ev.id}</td>
                    <td>{formatTime(ev.ts)}</td>
                    <td className="mono" title={ev.type}>
                      {EVENT_TYPE_LABEL[ev.type] ?? ev.type}
                    </td>
                    <td className="mono payload-cell" title={payloadText}>
                      {payloadText.length > 120 ? `${payloadText.slice(0, 120)}…` : payloadText}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
