import { useState } from 'react';
import { api, fmtTime, type Proposal, type Rollout, type Wave, type CoverageGap } from '../api';

interface Props {
  proposal: Proposal;
  rollout: Rollout | null;
  onChanged: () => void;
}

const DEFAULT_WAVES = [
  { sequence: 1, environment: 'canary' },
  { sequence: 2, environment: 'staging' },
  { sequence: 3, environment: 'production' },
];

export function RolloutPanel({ proposal, rollout, onChanged }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [wavesText, setWavesText] = useState(JSON.stringify(DEFAULT_WAVES, null, 2));
  const [previousVersion, setPreviousVersion] = useState('v-previous');
  const [reportSeq, setReportSeq] = useState(1);
  const [reportResult, setReportResult] = useState<'success' | 'failure' | 'unknown'>('success');
  const [adapterId, setAdapterId] = useState('deploy-bot');
  const [idemKey, setIdemKey] = useState(() => `receipt-${Math.random().toString(36).slice(2, 8)}`);
  const [message, setMessage] = useState('');
  const [rollbackTarget, setRollbackTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canStart = proposal.status === 'approved' && !rollout;

  const guard = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    await guard(async () => {
      const waves = JSON.parse(wavesText) as Array<{ sequence: number; environment: string }>;
      await api.startRollout(proposal.id, waves, previousVersion || null);
      setShowForm(false);
      onChanged();
    });
  };

  const report = async () => {
    if (!rollout) return;
    await guard(async () => {
      await api.reportReceipt(rollout.id, {
        sequence: reportSeq,
        result: reportResult,
        adapterId,
        idempotencyKey: idemKey,
        message,
      });
      setIdemKey(`receipt-${Math.random().toString(36).slice(2, 8)}`);
      onChanged();
    });
  };

  const pause = async () => {
    if (!rollout) return;
    await guard(async () => {
      await api.pauseRollout(rollout.id, 'manual pause');
      onChanged();
    });
  };

  const resume = async () => {
    if (!rollout) return;
    await guard(async () => {
      await api.resumeRollout(rollout.id);
      onChanged();
    });
  };

  const retry = async (seq: number) => {
    if (!rollout) return;
    await guard(async () => {
      await api.retryWave(rollout.id, seq);
      onChanged();
    });
  };

  const doRollback = async () => {
    if (!rollout) return;
    await guard(async () => {
      await api.rollbackRollout(rollout.id, rollbackTarget || rollout.previousVersion || 'previous', 'manual rollback');
      onChanged();
    });
  };

  const openGaps = rollout?.coverageGaps.filter((g) => g.status === 'open') ?? [];
  const hasOpenGaps = openGaps.length > 0;
  const isCoveragePaused = rollout?.status === 'paused' && rollout.pauseReason === 'coverage_gap';
  const canResume = rollout?.status === 'paused' && !hasOpenGaps;
  const activeWaves = rollout?.status === 'in_progress' || rollout?.status === 'paused' || rollout?.status === 'failed';

  return (
    <div className="card">
      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
        <h2>Phased Rollout</h2>
        {canStart && (
          <button onClick={() => setShowForm((v) => !v)} style={{ padding: '4px 10px' }}>
            {showForm ? 'Cancel' : '+ Start rollout'}
          </button>
        )}
      </div>

      {error && <div className="blocking-list" style={{ marginTop: 8 }}><li>{error}</li></div>}

      {!rollout && proposal.status !== 'approved' && (
        <div className="muted" style={{ fontSize: 12 }}>
          Rollout is available after the proposal is approved.
        </div>
      )}
      {!rollout && proposal.status === 'approved' && !showForm && (
        <div className="muted" style={{ fontSize: 12 }}>Proposal approved. Start a phased rollout to schedule deployment waves.</div>
      )}

      {showForm && (
        <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 6, marginTop: 8 }}>
          <label>
            <span>Waves (JSON array of sequence + environment)</span>
            <textarea
              rows={8}
              value={wavesText}
              onChange={(e) => setWavesText(e.target.value)}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
            />
          </label>
          <label>
            <span>Previous known version (rollback target)</span>
            <input value={previousVersion} onChange={(e) => setPreviousVersion(e.target.value)} />
          </label>
          <button className="primary" onClick={start} disabled={busy}>Start rollout</button>
        </div>
      )}

      {rollout && (
        <>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
            status: <strong>{rollout.status}</strong>
            {rollout.pauseReason && (
              <> · pause: <span className="badge" style={{ fontSize: 10 }}>{rollout.pauseReason}</span></>
            )}
            {' · '}decision <span className="mono">{rollout.decisionId.slice(0, 8)}</span> ·
            candidate <span className="mono">{rollout.candidateHash.slice(0, 10)}</span>
            {rollout.previousVersion && <> · previous: {rollout.previousVersion}</>}
            {rollout.rolledBackTo && <> · rolled back to <strong>{rollout.rolledBackTo}</strong> at {fmtTime(rollout.rolledBackAt!)}</>}
          </div>

          {isCoveragePaused && (
            <div className="blocking-list" style={{ marginTop: 6, marginBottom: 6 }}>
              <li>
                <strong>Auto-paused due to coverage gap.</strong>{' '}
                {hasOpenGaps
                  ? `New consumer(s) joined after the decision was frozen: ${openGaps.map((g) => g.consumerId).join(', ')}. Their re-verification must be recorded before the next wave can start.`
                  : 'All coverage gaps resolved; the rollout can be resumed.'}
              </li>
            </div>
          )}

          {rollout.coverageGaps.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                Coverage gaps (dependency topology changes after the decision snapshot was frozen)
              </div>
              {rollout.coverageGaps.map((g) => (
                <GapRow key={g.id} gap={g} rolloutId={rollout.id} onChanged={onChanged} disabled={busy} setBusy={setBusy} setError={setError} />
              ))}
            </div>
          )}

          <div className="consumer-grid">
            {rollout.waves.map((w) => (
              <WaveRow key={w.id} wave={w} rollout={rollout} onRetry={retry} />
            ))}
          </div>

          {activeWaves && (
            <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 6, marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Adapter receipt (duplicate/out-of-order receipts are idempotent and bound to this decision snapshot)
              </div>
              <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 80 }}>
                  <span>Wave</span>
                  <input type="number" value={reportSeq} min={1} onChange={(e) => setReportSeq(Number(e.target.value))} />
                </label>
                <label style={{ flex: 2, minWidth: 140 }}>
                  <span>Result</span>
                  <select value={reportResult} onChange={(e) => setReportResult(e.target.value as 'success' | 'failure' | 'unknown')}>
                    <option value="success">success</option>
                    <option value="failure">failure</option>
                    <option value="unknown">unknown</option>
                  </select>
                </label>
                <label style={{ flex: 2, minWidth: 140 }}>
                  <span>Adapter ID</span>
                  <input value={adapterId} onChange={(e) => setAdapterId(e.target.value)} />
                </label>
              </div>
              <label style={{ marginTop: 8 }}>
                <span>Message</span>
                <input value={message} onChange={(e) => setMessage(e.target.value)} />
              </label>
              <div className="muted" style={{ fontSize: 11, margin: '4px 0' }}>
                idempotency key: <span className="mono">{idemKey}</span>
              </div>
              <div className="actions">
                <button className="primary" onClick={report} disabled={busy}>Send receipt</button>
                {rollout.status === 'in_progress' && <button onClick={pause} disabled={busy}>Pause</button>}
                {rollout.status === 'paused' && (
                  <button onClick={resume} disabled={busy || !canResume} title={hasOpenGaps ? 'Resolve all coverage gaps first' : ''}>
                    Resume
                  </button>
                )}
                {rollout.status !== 'rolled_back' && (
                  <>
                    <input
                      placeholder="rollback target version"
                      value={rollbackTarget}
                      onChange={(e) => setRollbackTarget(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button className="danger" onClick={doRollback} disabled={busy}>Rollback</button>
                  </>
                )}
              </div>
              {hasOpenGaps && rollout.status === 'paused' && (
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Resume is blocked until {openGaps.length} open coverage gap(s) are resolved below.
                </div>
              )}
            </div>
          )}

          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Rollback points deployment at the previous known version but never changes the contract decision or revives voided exemptions.
            Coverage gaps freeze not-yet-started waves; the already-frozen decision snapshot is never modified.
          </div>
        </>
      )}
    </div>
  );
}

function GapRow({
  gap,
  rolloutId,
  onChanged,
  disabled,
  setBusy,
  setError,
}: {
  gap: CoverageGap;
  rolloutId: string;
  onChanged: () => void;
  disabled: boolean;
  setBusy: (v: boolean) => void;
  setError: (e: string | null) => void;
}) {
  const [verdict, setVerdict] = useState<'compatible' | 'incompatible' | 'error'>('compatible');
  const [details, setDetails] = useState('');
  const [vKey] = useState(() => `verify-${Math.random().toString(36).slice(2, 8)}`);
  const isOpen = gap.status === 'open';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.verifyCoverageGap(rolloutId, {
        consumerId: gap.consumerId,
        verdict,
        details,
        idempotencyKey: vKey,
      });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="consumer-row" style={{ borderColor: isOpen ? 'var(--warn, #b58105)' : 'var(--ok, #389e0d)' }}>
      <div>
        <div className="name">
          {gap.consumerId}
          <span className={`badge ${isOpen ? 'paused' : gap.status === 'resolved_compatible' ? 'succeeded' : 'failed'}`} style={{ marginLeft: 8 }}>
            {gap.status}
          </span>
        </div>
        <div className="cid mono">
          detected {fmtTime(gap.detectedAt)}
          {gap.verdict && <> · verdict: {gap.verdict}</>}
        </div>
        {gap.details && <div className="cid">{gap.details}</div>}
      </div>
      {isOpen && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)} style={{ fontSize: 12 }}>
            <option value="compatible">compatible</option>
            <option value="incompatible">incompatible</option>
            <option value="error">error</option>
          </select>
          <input
            placeholder="details"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            style={{ width: 160, fontSize: 12 }}
          />
          <button onClick={submit} disabled={disabled} style={{ padding: '2px 10px' }}>Verify</button>
        </div>
      )}
    </div>
  );
}

function WaveRow({ wave, rollout, onRetry }: { wave: Wave; rollout: Rollout; onRetry: (seq: number) => void }) {
  const isCurrent = wave.status === 'in_progress';
  const canRetry = wave.status === 'failed' && rollout.status === 'failed';
  return (
    <div className="consumer-row" style={{ borderColor: isCurrent ? 'var(--accent)' : undefined }}>
      <div>
        <div className="name">Wave {wave.sequence} — {wave.environment}</div>
        <div className="cid mono">
          {wave.attempts} attempt(s)
          {wave.lastAdapterId && ` · ${wave.lastAdapterId}`}
          {wave.lastResult && ` · ${wave.lastResult}`}
        </div>
      </div>
      <div>
        <span className={`badge ${wave.status}`}>{wave.status}</span>
        {canRetry && (
          <button style={{ marginLeft: 8, padding: '2px 8px' }} onClick={() => onRetry(wave.sequence)}>Retry</button>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        {wave.startedAt && <div className="fresh">started {fmtTime(wave.startedAt)}</div>}
        {wave.finishedAt && <div className="fresh">finished {fmtTime(wave.finishedAt)}</div>}
        {wave.lastMessage && <div className="cid">{wave.lastMessage}</div>}
      </div>
    </div>
  );
}
