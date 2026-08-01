import React, { useEffect, useState, useCallback } from 'react';
import {
  fetchSnapshot,
  fetchEvents,
  decide,
  requestWaiver,
  confirmWaiver,
  rejectWaiver,
  revokeWaiver,
  type Snapshot,
  type ProposalView,
  type Waiver
} from './api';

/**
 * Release manager's workbench.
 *
 * Shows, per subject: the current candidate, its static compatibility result,
 * the dependency (required-consumer) readiness with evidence freshness, and
 * the concrete blocking reasons. The Approve control is enabled ONLY when the
 * gate reports canApprove for the exact candidate on screen, and every
 * decision is sent with the candidate digest + the fingerprint the manager saw
 * so the server can refuse to act on a stale view.
 *
 * The view is a periodic pull of the consistent snapshot endpoint, so a reload
 * or reconnect always reflects durable state.
 */
const STATUS_COLORS: Record<string, string> = {
  READY: '#137333',
  COLLECTING: '#a56300',
  BLOCKED: '#b3261e',
  APPROVED: '#137333',
  REJECTED: '#b3261e',
  OPEN: '#1a56db',
  SUPERSEDED: '#5f6368'
};

const CONSUMER_COLORS: Record<string, string> = {
  PASS: '#137333',
  FAIL: '#b3261e',
  STALE: '#a56300',
  MISSING: '#5f6368',
  WAIVED: '#6a1b9a'
};

const WAIVER_COLORS: Record<string, string> = {
  REQUESTED: '#a56300',
  ACTIVE: '#6a1b9a',
  REJECTED: '#b3261e',
  REVOKED: '#5f6368',
  EXPIRED: '#5f6368'
};

export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [decidedBy, setDecidedBy] = useState('release-manager');
  // Two distinct reviewer identities so dual control can be exercised from the
  // workbench: one applies for a waiver, the other confirms it.
  const [reviewerA, setReviewerA] = useState('reviewer-A');
  const [reviewerB, setReviewerB] = useState('reviewer-B');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [snap, ev] = await Promise.all([fetchSnapshot(), fetchEvents(0)]);
      setSnapshot(snap);
      setEvents(ev.events.slice(-30).reverse());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [refresh]);

  const onDecide = async (view: ProposalView, type: 'APPROVE' | 'REJECT') => {
    setBusy(view.proposal.proposalId + type);
    try {
      const r = await decide(view.proposal.proposalId, {
        expectedDigest: view.proposal.candidateDigest,
        expectedFingerprint: view.gate.evidenceFingerprint,
        environment: view.gate.environment,
        type,
        decidedBy
      });
      if (r.status !== 201) {
        setError(`${type} rejected: ${r.body?.reason ?? r.body?.status ?? r.status}`);
      } else {
        setError(null);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const runWaiverAction = async (key: string, fn: () => Promise<{ status: number; body: any }>) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r.status !== 201) setError(`豁免操作被拒绝: ${r.body?.reason ?? r.body?.status ?? r.status}`);
      else setError(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onRequestWaiver = (view: ProposalView, consumerId: string, reason: string, ttlMs: number) =>
    runWaiverAction(`req-${consumerId}`, () =>
      requestWaiver({
        subjectId: view.proposal.subjectId,
        candidateDigest: view.proposal.candidateDigest,
        consumerId,
        environment: view.gate.environment,
        compatDirection: view.proposal.compat.result,
        reason,
        requestedBy: reviewerA,
        ttlMs
      })
    );

  const onConfirmWaiver = (w: Waiver) => runWaiverAction(`conf-${w.waiverId}`, () => confirmWaiver(w.waiverId, reviewerB));
  const onRejectWaiver = (w: Waiver) => runWaiverAction(`rej-${w.waiverId}`, () => rejectWaiver(w.waiverId, reviewerB, 'rejected from workbench'));
  const onRevokeWaiver = (w: Waiver) => runWaiverAction(`rev-${w.waiverId}`, () => revokeWaiver(w.waiverId, reviewerB, 'revoked from workbench'));

  return (
    <div style={{ fontFamily: 'Segoe UI, system-ui, sans-serif', maxWidth: 1100, margin: '0 auto', padding: 24, color: '#202124' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ fontSize: 22 }}>数据契约变更控制中心</h1>
        <div style={{ fontSize: 13, color: '#5f6368' }}>
          环境 {snapshot?.environment ?? '—'} · 快照时刻 t={snapshot?.at ?? '—'} · 事件序号 {snapshot?.eventSeq ?? 0}
        </div>
      </header>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 16px' }}>
        <label style={{ fontSize: 13 }}>
          发布负责人：
          <input value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)} style={{ marginLeft: 6, padding: '2px 6px' }} />
        </label>
        <label style={{ fontSize: 13 }}>
          复核人 A（申请）：
          <input value={reviewerA} onChange={(e) => setReviewerA(e.target.value)} style={{ marginLeft: 6, padding: '2px 6px', width: 90 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          复核人 B（确认）：
          <input value={reviewerB} onChange={(e) => setReviewerB(e.target.value)} style={{ marginLeft: 6, padding: '2px 6px', width: 90 }} />
        </label>
        <button onClick={refresh} style={btn}>手动刷新</button>
      </div>

      {error && (
        <div style={{ background: '#fce8e6', color: '#b3261e', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!snapshot && <p>加载中…</p>}
      {snapshot?.subjects.length === 0 && <p style={{ color: '#5f6368' }}>暂无契约主题。使用代理模拟器或 API 提交候选。</p>}

      {snapshot?.subjects.map((s) => (
        <section key={s.subject.subjectId} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: 18, margin: 0 }}>{s.subject.subjectId}</h2>
            <span style={{ fontSize: 12, color: '#5f6368' }}>
              新鲜度窗口 {s.subject.freshnessWindowMs}ms · 依赖消费方 {s.subject.requiredConsumers.join(', ')}
            </span>
          </div>

          {!s.current && <p style={{ color: '#5f6368', fontSize: 14 }}>没有进行中的候选契约。</p>}

          {s.current && (
            <CandidatePanel
              view={s.current}
              onDecide={onDecide}
              onRequestWaiver={onRequestWaiver}
              onConfirmWaiver={onConfirmWaiver}
              onRejectWaiver={onRejectWaiver}
              onRevokeWaiver={onRevokeWaiver}
              busy={busy}
            />
          )}

          {s.history.length > 1 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#5f6368' }}>历史候选（{s.history.length}）</summary>
              <ul style={{ fontSize: 12, color: '#5f6368' }}>
                {s.history.map((h) => (
                  <li key={h.proposalId}>
                    #{h.seq} <code>{h.digest.slice(0, 20)}</code> — <Badge text={h.state} />
                    {h.decision && ` by ${h.decision.decidedBy}`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}

      <section style={{ ...card, marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>因果事件日志（最近）</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#5f6368' }}>
              <th style={th}>seq</th><th style={th}>t</th><th style={th}>type</th><th style={th}>subject</th><th style={th}>payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.seq} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{e.seq}</td>
                <td style={td}>{e.at}</td>
                <td style={td}><code>{e.type}</code></td>
                <td style={td}>{e.subjectId ?? '—'}</td>
                <td style={{ ...td, color: '#5f6368' }}>{JSON.stringify(e.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CandidatePanel({
  view,
  onDecide,
  onRequestWaiver,
  onConfirmWaiver,
  onRejectWaiver,
  onRevokeWaiver,
  busy
}: {
  view: ProposalView;
  onDecide: (v: ProposalView, t: 'APPROVE' | 'REJECT') => void;
  onRequestWaiver: (v: ProposalView, consumerId: string, reason: string, ttlMs: number) => void;
  onConfirmWaiver: (w: Waiver) => void;
  onRejectWaiver: (w: Waiver) => void;
  onRevokeWaiver: (w: Waiver) => void;
  busy: string | null;
}): JSX.Element {
  const { proposal, gate, decision, waivers } = view;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge text={`门禁 ${gate.status}`} color={STATUS_COLORS[gate.status]} />
        <Badge text={`静态兼容性 ${proposal.compat.result}`} color={proposal.compat.result === 'COMPATIBLE' ? '#137333' : proposal.compat.result === 'BREAKING' ? '#b3261e' : '#a56300'} />
        <Badge text={`环境 ${gate.environment}`} color="#1a56db" />
        <code style={{ fontSize: 12 }}>{proposal.candidateDigest.slice(0, 26)}…</code>
        <span style={{ fontSize: 12, color: '#5f6368' }}>提交人 {proposal.submittedBy}</span>
      </div>

      <div style={{ fontSize: 11, color: '#5f6368', marginTop: 4 }}>
        证据指纹 <code>{gate.evidenceFingerprint.slice(0, 26)}…</code>
      </div>

      <h4 style={{ margin: '12px 0 4px', fontSize: 13 }}>依赖消费方与证据新鲜度</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5f6368' }}>
            <th style={th}>消费方</th><th style={th}>状态</th><th style={th}>report</th><th style={th}>产出时刻</th><th style={th}>证据年龄</th><th style={th}>豁免</th>
          </tr>
        </thead>
        <tbody>
          {gate.consumers.map((c) => (
            <tr key={c.consumerId} style={{ borderTop: '1px solid #eee' }}>
              <td style={td}>{c.consumerId}</td>
              <td style={td}><Badge text={c.status} color={CONSUMER_COLORS[c.status]} /></td>
              <td style={td}>{c.reportId ? <code>{c.reportId}</code> : '—'}</td>
              <td style={td}>{c.producedAt ?? '—'}</td>
              <td style={td}>{c.ageMs != null ? `${c.ageMs}ms` : '—'}</td>
              <td style={td}>
                {c.status === 'WAIVED' ? (
                  <span title={c.waiverId}>豁免至 t={c.waiverExpiresAt}</span>
                ) : (c.status === 'MISSING' || c.status === 'STALE') ? (
                  <button
                    disabled={busy != null}
                    onClick={() => onRequestWaiver(view, c.consumerId, `${c.consumerId} 在发布窗口内暂时离线`, 5_000)}
                    style={{ ...btn, padding: '2px 8px', fontSize: 11 }}
                  >
                    申请豁免
                  </button>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <WaiverList
        waivers={waivers}
        busy={busy}
        onConfirm={onConfirmWaiver}
        onReject={onRejectWaiver}
        onRevoke={onRevokeWaiver}
      />

      {gate.blockingReasons.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>阻塞原因：</strong>
          <ul style={{ margin: '4px 0', fontSize: 13, color: '#b3261e' }}>
            {gate.blockingReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {gate.advisories.length > 0 && (
        <ul style={{ margin: '4px 0', fontSize: 12, color: '#a56300' }}>
          {gate.advisories.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      {decision ? (
        <div style={{ marginTop: 12, padding: 10, background: '#e6f4ea', borderRadius: 6, fontSize: 13 }}>
          已决策：<strong>{decision.type}</strong> · 环境 {decision.environment} · 由 {decision.decidedBy} 于 t={decision.decidedAt}。
          {decision.gateSnapshot?.appliedWaivers?.length > 0 && (
            <> 依据的豁免：{decision.gateSnapshot.appliedWaivers.map((w) => w.waiverId.slice(0, 8)).join(', ')}。</>
          )}
          该结论已冻结于不可变快照，此后到达的证据或豁免到期/撤销都不会改变它。
        </div>
      ) : (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            disabled={!gate.canApprove || busy != null}
            onClick={() => onDecide(view, 'APPROVE')}
            title={gate.canApprove ? '证据齐备（或已豁免），可以批准' : '证据未齐备，无法批准'}
            style={{ ...btn, background: gate.canApprove ? '#137333' : '#c8c8c8', color: '#fff', cursor: gate.canApprove ? 'pointer' : 'not-allowed' }}
          >
            批准（仅证据齐备时可用）
          </button>
          <button disabled={busy != null} onClick={() => onDecide(view, 'REJECT')} style={{ ...btn, background: '#b3261e', color: '#fff' }}>
            驳回
          </button>
        </div>
      )}
    </div>
  );
}

function WaiverList({
  waivers,
  busy,
  onConfirm,
  onReject,
  onRevoke
}: {
  waivers: Waiver[];
  busy: string | null;
  onConfirm: (w: Waiver) => void;
  onReject: (w: Waiver) => void;
  onRevoke: (w: Waiver) => void;
}): JSX.Element | null {
  if (waivers.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <h4 style={{ margin: '4px 0', fontSize: 13 }}>限时豁免（双人复核）</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5f6368' }}>
            <th style={th}>消费方</th><th style={th}>状态</th><th style={th}>方向/环境</th><th style={th}>申请人</th><th style={th}>确认人</th><th style={th}>到期</th><th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {waivers.map((w) => (
            <tr key={w.waiverId} style={{ borderTop: '1px solid #eee' }}>
              <td style={td}>{w.consumerId}</td>
              <td style={td}><Badge text={w.status} color={WAIVER_COLORS[w.status]} /></td>
              <td style={td}>{w.compatDirection}/{w.environment}</td>
              <td style={td}>{w.requestedBy}</td>
              <td style={td}>{w.confirmedBy ?? '—'}</td>
              <td style={td}>t={w.expiresAt}{w.endReason ? ` (${w.endReason})` : ''}</td>
              <td style={td}>
                {w.status === 'REQUESTED' && (
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button disabled={busy != null} onClick={() => onConfirm(w)} style={{ ...btn, padding: '2px 6px', fontSize: 11, background: '#6a1b9a', color: '#fff' }}>确认</button>
                    <button disabled={busy != null} onClick={() => onReject(w)} style={{ ...btn, padding: '2px 6px', fontSize: 11 }}>拒绝</button>
                  </span>
                )}
                {w.status === 'ACTIVE' && (
                  <button disabled={busy != null} onClick={() => onRevoke(w)} style={{ ...btn, padding: '2px 6px', fontSize: 11 }}>撤销</button>
                )}
                {['REJECTED', 'REVOKED', 'EXPIRED'].includes(w.status) && '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: '#5f6368', margin: '4px 0' }}>
        豁免仅覆盖“缺席/证据陈旧”，不覆盖 FAIL；确认人必须不同于申请人；过期或撤销后立即停止参与新决策。
      </p>
    </div>
  );
}

function Badge({ text, color = '#5f6368' }: { text: string; color?: string }): JSX.Element {
  return (
    <span style={{ background: color, color: '#fff', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
      {text}
    </span>
  );
}

const card: React.CSSProperties = { border: '1px solid #e0e0e0', borderRadius: 10, padding: 16, marginBottom: 12 };
const btn: React.CSSProperties = { border: '1px solid #dadce0', borderRadius: 6, padding: '6px 12px', background: '#fff', cursor: 'pointer', fontSize: 13 };
const th: React.CSSProperties = { padding: '4px 6px', fontWeight: 600 };
const td: React.CSSProperties = { padding: '4px 6px' };
