import { useState } from 'react';
import { api, shortHash, type Proposal, type ProposalDetail } from '../api';

interface Props {
  detail: ProposalDetail;
  onSelectProposal: (id: string) => void;
  onChanged: () => void;
}

export function LineagePanel({ detail, onSelectProposal, onChanged }: Props) {
  const { proposal, lineage, successors, parent } = detail;
  const [showForm, setShowForm] = useState(false);
  const [candidate, setCandidate] = useState(JSON.stringify(proposal.candidateSchema, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canRevise = proposal.status === 'pending' && successors.length === 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const schema = JSON.parse(candidate);
      const res = await api.createSuccessor(proposal.id, schema);
      setShowForm(false);
      onChanged();
      onSelectProposal(res.successor.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
        <h2>Proposal Lineage (revision {proposal.revision})</h2>
        {canRevise && (
          <button onClick={() => setShowForm((v) => !v)} style={{ padding: '4px 10px' }}>
            {showForm ? 'Cancel' : '+ Create revised proposal'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        {parent && (
          <>
            <button className="lineage-node" onClick={() => onSelectProposal(parent.id)}>
              <span className="muted" style={{ fontSize: 11 }}>rev {parent.revision}</span>
              <span className="mono">{shortHash(parent.candidateHash)}</span>
              <span className={`badge ${parent.status}`}>{parent.status}</span>
            </button>
            <span className="muted">→</span>
          </>
        )}
        <div className="lineage-node current">
          <span className="muted" style={{ fontSize: 11 }}>rev {proposal.revision} (current)</span>
          <span className="mono">{shortHash(proposal.candidateHash)}</span>
          <span className={`badge ${proposal.status}`}>{proposal.status}</span>
        </div>
        {successors.length > 0 && (
          <>
            <span className="muted">→</span>
            {successors.map((s) => (
              <button key={s.id} className="lineage-node" onClick={() => onSelectProposal(s.id)}>
                <span className="muted" style={{ fontSize: 11 }}>rev {s.revision}</span>
                <span className="mono">{shortHash(s.candidateHash)}</span>
                <span className={`badge ${s.status}`}>{s.status}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {proposal.status === 'superseded' && successors.length > 0 && (
        <ul className="blocking-list">
          <li>
            This revision was superseded by revision {successors[0]!.revision}. Its evidence and exemptions were
            not carried over; decide on the latest revision.
          </li>
        </ul>
      )}

      {showForm && (
        <div style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 6, marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Submit a corrected candidate. A new candidate hash is computed, this proposal is marked superseded,
            its open exemptions are voided, and the successor starts with <strong>zero evidence</strong>.
          </div>
          <textarea
            rows={10}
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          {error && <div className="blocking-list" style={{ marginTop: 8 }}><li>{error}</li></div>}
          <div className="actions">
            <button className="primary" onClick={submit} disabled={busy}>Create successor</button>
          </div>
        </div>
      )}
    </div>
  );
}
