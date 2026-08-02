import React, { useEffect, useState, useCallback } from 'react';
import {
  fetchSnapshot,
  fetchEvents,
  decide,
  requestWaiver,
  confirmWaiver,
  rejectWaiver,
  revokeWaiver,
  createRollout,
  startNextWave,
  pauseRollout,
  resumeRollout,
  retryWave,
  rollback,
  resolveRevalidation,
  type Snapshot,
  type ProposalView,
  type Waiver,
  type RolloutDetail
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
  EXPIRED: '#5f6368',
  LAPSED: '#5f6368'
};

const ROLLOUT_COLORS: Record<string, string> = {
  PENDING: '#5f6368',
  IN_PROGRESS: '#1a56db',
  PAUSED: '#a56300',
  COMPLETED: '#137333',
  FAILED: '#b3261e',
  ROLLED_BACK: '#6a1b9a'
};

const WAVE_COLORS: Record<string, string> = {
  PENDING: '#5f6368',
  IN_PROGRESS: '#1a56db',
  SUCCEEDED: '#137333',
  FAILED: '#b3261e'
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

  const runRolloutAction = async (key: string, fn: () => Promise<{ status: number; body: any }>, okStatuses = [200, 201]) => {
    setBusy(key);
    try {
      const r = await fn();
      if (!okStatuses.includes(r.status)) setError(`发布操作被拒绝: ${r.body?.reason ?? r.body?.status ?? r.status}`);
      else setError(null);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onCreateRollout = (view: ProposalView, waves: string[]) => {
    if (!view.decision) return;
    return runRolloutAction(`ro-create-${view.proposal.proposalId}`, () =>
      createRollout({ decisionId: view.decision!.decisionId, waves, createdBy: decidedBy })
    );
  };
  const onStartWave = (rolloutId: string) => runRolloutAction(`ro-start-${rolloutId}`, () => startNextWave(rolloutId));
  const onPause = (rolloutId: string) => runRolloutAction(`ro-pause-${rolloutId}`, () => pauseRollout(rolloutId));
  const onResume = (rolloutId: string) => runRolloutAction(`ro-resume-${rolloutId}`, () => resumeRollout(rolloutId));
  const onRetryWave = (rolloutId: string, waveId: string) => runRolloutAction(`ro-retry-${waveId}`, () => retryWave(rolloutId, waveId));
  const onRollback = (subjectId: string, environment: string, targetDigest: string, waves: string[]) =>
    runRolloutAction(`ro-rollback-${subjectId}`, () =>
      rollback({ subjectId, environment, targetDigest, waves, createdBy: decidedBy })
    );
  const onResolveRevalidation = (revalidationId: string, resolution: 'RESUMED' | 'HELD') =>
    runRolloutAction(`ro-reval-${revalidationId}`, () => resolveRevalidation(revalidationId, resolution, decidedBy));

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

          <RolloutSection
            subjectId={s.subject.subjectId}
            environment={snapshot?.environment ?? 'production'}
            current={s.current}
            rollouts={s.rollouts ?? []}
            onCreateRollout={onCreateRollout}
            onStartWave={onStartWave}
            onPause={onPause}
            onResume={onResume}
            onRetryWave={onRetryWave}
            onRollback={onRollback}
            onResolveRevalidation={onResolveRevalidation}
            busy={busy}
          />

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

      {(view.lineage.predecessorId || view.lineage.successorId) && (
        <div style={{ fontSize: 11, color: '#5f6368', marginTop: 4 }}>
          谱系：
          {view.lineage.predecessorId && (
            <> 后继自 <code title={view.lineage.predecessorId}>{view.lineage.predecessorDigest?.slice(0, 16)}…</code>（前序提案，证据/豁免不沿用）</>
          )}
          {view.lineage.successorId && (
            <> · 已被后继替代 <code title={view.lineage.successorId}>{view.lineage.successorDigest?.slice(0, 16)}…</code></>
          )}
        </div>
      )}

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

function RolloutSection({
  subjectId,
  environment,
  current,
  rollouts,
  onCreateRollout,
  onStartWave,
  onPause,
  onResume,
  onRetryWave,
  onRollback,
  onResolveRevalidation,
  busy
}: {
  subjectId: string;
  environment: string;
  current: ProposalView | null;
  rollouts: RolloutDetail[];
  onCreateRollout: (v: ProposalView, waves: string[]) => void;
  onStartWave: (rolloutId: string) => void;
  onPause: (rolloutId: string) => void;
  onResume: (rolloutId: string) => void;
  onRetryWave: (rolloutId: string, waveId: string) => void;
  onRollback: (subjectId: string, environment: string, targetDigest: string, waves: string[]) => void;
  onResolveRevalidation: (revalidationId: string, resolution: 'RESUMED' | 'HELD') => void;
  busy: string | null;
}): JSX.Element {
  const [waveText, setWaveText] = useState('canary, half, full');
  const canStartRollout =
    current?.decision?.type === 'APPROVE' &&
    current.decision.environment === environment &&
    !rollouts.some((r) => ['PENDING', 'IN_PROGRESS', 'PAUSED'].includes(r.rollout.status));

  // Rollback targets: digests that were approved for this environment before.
  const rollbackTargets = rollouts
    .filter((r) => r.rollout.kind === 'RELEASE')
    .map((r) => r.rollout.candidateDigest);

  return (
    <div style={{ marginTop: 14, borderTop: '1px dashed #e0e0e0', paddingTop: 10 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>分阶段发布（环境 {environment}）</h4>

      {canStartRollout && current?.decision && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#5f6368' }}>波次（逗号分隔）：</span>
          <input value={waveText} onChange={(e) => setWaveText(e.target.value)} style={{ padding: '2px 6px', fontSize: 12, width: 220 }} />
          <button
            disabled={busy != null}
            onClick={() => onCreateRollout(current, waveText.split(',').map((w) => w.trim()).filter(Boolean))}
            style={{ ...btn, padding: '4px 10px', fontSize: 12, background: '#1a56db', color: '#fff' }}
          >
            按环境安排连续波次
          </button>
        </div>
      )}

      {rollouts.length === 0 && <p style={{ fontSize: 12, color: '#5f6368', margin: 0 }}>该环境暂无发布流程。批准候选后可安排波次。</p>}

      {rollouts.map((r) => (
        <div key={r.rollout.rolloutId} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge text={r.rollout.kind} color={r.rollout.kind === 'ROLLBACK' ? '#6a1b9a' : '#1a56db'} />
            <Badge text={r.rollout.status} color={ROLLOUT_COLORS[r.rollout.status]} />
            <code style={{ fontSize: 11 }} title={r.rollout.candidateDigest}>{r.rollout.candidateDigest.slice(0, 20)}…</code>
            <span style={{ fontSize: 11, color: '#5f6368' }}>指纹 <code>{r.rollout.evidenceFingerprint.slice(0, 16)}…</code></span>
            {r.rollout.supersedesRolloutId && (
              <span style={{ fontSize: 11, color: '#5f6368' }}>回退自 <code>{r.rollout.supersedesRolloutId.slice(0, 8)}</code></span>
            )}
          </div>

          {r.rollout.holdReason && (
            <div style={{ marginTop: 6, background: '#fef7e0', border: '1px solid #f9d67a', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: '#a56300' }}>
              ⏸ 已因依赖拓扑变化自动暂停后续波次：{r.rollout.holdReason}
            </div>
          )}

          {r.revalidations.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <h5 style={{ margin: '4px 0', fontSize: 12 }}>拓扑变化再验证（同一提案谱系，历史决策不可改）</h5>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#5f6368' }}>
                    <th style={th}>新增依赖</th><th style={th}>状态</th><th style={th}>因果依据</th><th style={th}>结论</th><th style={th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {r.revalidations.map((rv) => (
                    <tr key={rv.revalidationId} style={{ borderTop: '1px solid #eee' }}>
                      <td style={td}>{rv.addedConsumers.join(', ')}</td>
                      <td style={td}><Badge text={rv.status} color={rv.status === 'OPEN' ? '#a56300' : '#137333'} /></td>
                      <td style={{ ...td, color: '#5f6368' }}>{rv.reason}</td>
                      <td style={td}>{rv.resolution ? `${rv.resolution}${rv.resolvedBy ? ` by ${rv.resolvedBy}` : ''}` : '—'}</td>
                      <td style={td}>
                        {rv.status === 'OPEN' ? (
                          <span style={{ display: 'flex', gap: 4 }}>
                            <button disabled={busy != null} onClick={() => onResolveRevalidation(rv.revalidationId, 'RESUMED')} style={{ ...btn, padding: '2px 6px', fontSize: 11, background: '#137333', color: '#fff' }} title="缺口已由新消费方的新鲜 PASS 或匹配豁免覆盖后，继续发布">继续</button>
                            <button disabled={busy != null} onClick={() => onResolveRevalidation(rv.revalidationId, 'HELD')} style={{ ...btn, padding: '2px 6px', fontSize: 11 }} title="记录一条继续保持暂停的可追溯结论">保持暂停</button>
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 6 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#5f6368' }}>
                <th style={th}>#</th><th style={th}>波次</th><th style={th}>状态</th><th style={th}>尝试</th><th style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {r.waves.map((w) => (
                <tr key={w.waveId} style={{ borderTop: '1px solid #eee' }}>
                  <td style={td}>{w.ordinal}</td>
                  <td style={td}>{w.name}</td>
                  <td style={td}><Badge text={w.status} color={WAVE_COLORS[w.status]} /></td>
                  <td style={td}>{w.attempt}</td>
                  <td style={td}>
                    {(w.status === 'FAILED' || w.status === 'IN_PROGRESS') && ['IN_PROGRESS', 'PAUSED'].includes(r.rollout.status) && (
                      <button disabled={busy != null} onClick={() => onRetryWave(r.rollout.rolloutId, w.waveId)} style={{ ...btn, padding: '2px 6px', fontSize: 11 }}>重试</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {['PENDING', 'IN_PROGRESS'].includes(r.rollout.status) && (
              <button disabled={busy != null} onClick={() => onStartWave(r.rollout.rolloutId)} style={{ ...btn, padding: '3px 8px', fontSize: 11 }}>启动下一波次</button>
            )}
            {['PENDING', 'IN_PROGRESS'].includes(r.rollout.status) && (
              <button disabled={busy != null} onClick={() => onPause(r.rollout.rolloutId)} style={{ ...btn, padding: '3px 8px', fontSize: 11 }}>暂停</button>
            )}
            {r.rollout.status === 'PAUSED' && (
              <button disabled={busy != null} onClick={() => onResume(r.rollout.rolloutId)} style={{ ...btn, padding: '3px 8px', fontSize: 11 }}>恢复</button>
            )}
            {r.rollout.kind === 'RELEASE' && ['IN_PROGRESS', 'PAUSED', 'FAILED'].includes(r.rollout.status) && rollbackTargets.length > 0 && (
              <button
                disabled={busy != null}
                onClick={() => onRollback(subjectId, environment, rollbackTargets[0], ['rollback'])}
                style={{ ...btn, padding: '3px 8px', fontSize: 11, background: '#6a1b9a', color: '#fff' }}
                title="回退到上一个已知版本（仅部署，不改写契约决策，不复活已失效豁免）"
              >
                回退到上一个已知版本
              </button>
            )}
          </div>

          {r.receipts.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#5f6368' }}>部署回执（{r.receipts.length}）</summary>
              <ul style={{ fontSize: 11, color: '#5f6368', margin: '4px 0' }}>
                {r.receipts.map((rc) => (
                  <li key={rc.receiptId}>
                    <code>{rc.receiptId}</code> {rc.result} · attempt {rc.attempt} · {rc.applied ? '已推进' : `未推进（${rc.ignoredReason ?? '重复'}）`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
      <p style={{ fontSize: 11, color: '#5f6368', margin: '4px 0' }}>
        回执只推进绑定同一决策快照与波次尝试的当前波次；重复/乱序/指纹不匹配的回执被记录但不生效。回退仅重新部署，不改写原契约决策，也不复活已失效豁免。
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
