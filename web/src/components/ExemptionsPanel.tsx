import { useState } from 'react';
import { api, fmtTime, shortHash, type Exemption, type Proposal } from '../api';

interface Props {
  proposal: Proposal;
  exemptions: Exemption[];
  consumerNames: Map<string, string>;
  onChange: () => void;
}

export function ExemptionsPanel({ proposal, exemptions, consumerNames, onChange }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [consumerId, setConsumerId] = useState('');
  const [direction, setDirection] = useState<'compatible' | 'incompatible'>('compatible');
  const [reason, setReason] = useState('consumer offline during release window');
  const [requesterId, setRequesterId] = useState('');
  const [confirmerId, setConfirmerId] = useState('');
  const [durationMin, setDurationMin] = useState(60);
  const [actionReviewer, setActionReviewer] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const name = (id: string) => consumerNames.get(id) ?? id;
  const now = Date.now();

  const request = async () => {
    if (!consumerId || !requesterId) {
      setError('consumer and requester are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = Date.now();
      await api.requestExemption({
        candidateHash: proposal.candidateHash,
        consumerId,
        environment: proposal.environment,
        direction,
        reason,
        requesterId,
        validFrom: t,
        validUntil: t + durationMin * 60_000,
      });
      setShowForm(false);
      setConsumerId('');
      setReason('consumer offline during release window');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (id: string) => {
    if (!confirmerId) {
      setError('confirmer id is required (must differ from requester)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.confirmExemption(id, confirmerId);
      setConfirmerId('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.rejectExemption(id, actionReviewer || 'reviewer', actionNote);
      setActionReviewer('');
      setActionNote('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!actionReviewer) {
      setError('reviewer id is required to revoke');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.revokeExemption(id, actionReviewer, actionNote);
      setActionReviewer('');
      setActionNote('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
        <h2>Time-limited Exemptions ({exemptions.length})</h2>
        <button onClick={() => setShowForm((v) => !v)} style={{ padding: '4px 10px' }}>
          {showForm ? 'Cancel' : '+ Request'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        An exemption requires confirmation by a <strong>different</strong> reviewer than the requester. It only
        covers this candidate, one consumer, the environment <strong>{proposal.environment}</strong>, and the
        chosen compatibility direction. Expired or revoked exemptions stop participating in new decisions; frozen
        decision snapshots are never altered.
      </div>

      {error && <div className="blocking-list"><li>{error}</li></div>}

      {showForm && (
        <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 6, marginBottom: 12 }}>
          <label>
            <span>Consumer</span>
            <select value={consumerId} onChange={(e) => setConsumerId(e.target.value)}>
              <option value="">select consumer...</option>
              {Array.from(consumerNames.entries()).map(([id, n]) => (
                <option key={id} value={id}>{n} ({id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Compatibility direction</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'compatible' | 'incompatible')}>
              <option value="compatible">expected compatible (waives missing evidence)</option>
              <option value="incompatible">acknowledged incompatible (does NOT unblock approval)</option>
            </select>
          </label>
          <label>
            <span>Reason</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            <span>Requester (reviewer A)</span>
            <input value={requesterId} onChange={(e) => setRequesterId(e.target.value)} placeholder="alice" />
          </label>
          <label>
            <span>Validity duration (minutes from now)</span>
            <input type="number" value={durationMin} min={1} onChange={(e) => setDurationMin(Number(e.target.value))} />
          </label>
          <button className="primary" onClick={request} disabled={busy}>Submit request (needs second reviewer)</button>
        </div>
      )}

      {exemptions.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No exemptions for this candidate.</div>}

      {exemptions.map((ex) => {
        const expired = ex.status === 'expired' || (ex.status === 'active' && now > ex.validUntil);
        return (
          <div key={ex.id} style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            marginBottom: 10,
            background: 'var(--panel-2)',
          }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <div>
                <strong>{name(ex.consumerId)}</strong>
                <span className="cid mono" style={{ marginLeft: 8 }}>{ex.consumerId}</span>
              </div>
              <span className={`badge ${ex.status}`}>{expired && ex.status === 'active' ? 'expired' : ex.status}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {ex.environment} &middot; {ex.direction} &middot; {shortHash(ex.candidateHash)}
            </div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{ex.reason}</div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              requester: {ex.requesterId}
              {ex.confirmerId ? ` · confirmer: ${ex.confirmerId}` : ' · awaiting a different confirmer'}
              <br />
              valid: {fmtTime(ex.validFrom)} → {fmtTime(ex.validUntil)}
              {ex.closedBy && (
                <>
                  <br />
                  {ex.status} by {ex.closedBy}: {ex.closeNote}
                </>
              )}
            </div>

            {ex.status === 'pending' && (
              <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  placeholder="confirmer id (different from requester)"
                  value={confirmerId}
                  onChange={(e) => setConfirmerId(e.target.value)}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <button className="primary" onClick={() => confirm(ex.id)} disabled={busy}>Confirm (2nd reviewer)</button>
                <input
                  placeholder="reviewer id"
                  value={actionReviewer}
                  onChange={(e) => setActionReviewer(e.target.value)}
                  style={{ flex: 1, minWidth: 120 }}
                />
                <button onClick={() => reject(ex.id)} disabled={busy}>Reject</button>
              </div>
            )}
            {ex.status === 'active' && (
              <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  placeholder="reviewer id"
                  value={actionReviewer}
                  onChange={(e) => setActionReviewer(e.target.value)}
                  style={{ flex: 1, minWidth: 120 }}
                />
                <input
                  placeholder="revoke note"
                  value={actionNote}
                  onChange={(e) => setActionNote(e.target.value)}
                  style={{ flex: 2, minWidth: 160 }}
                />
                <button className="danger" onClick={() => revoke(ex.id)} disabled={busy}>Revoke</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
