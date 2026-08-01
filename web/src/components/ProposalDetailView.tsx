import { useState } from 'react';
import { shortHash, timeAgo, type Consumer, type ProposalDetail } from '../api';
import { ExemptionsPanel } from './ExemptionsPanel';

interface Props {
  detail: ProposalDetail;
  consumers: Consumer[];
  now: number;
  onDecide: (action: 'approve' | 'reject', reason: string) => void;
  onExemptionChange: () => void;
}

export function ProposalDetailView({ detail, consumers, now, onDecide, onExemptionChange }: Props) {
  const {
    proposal,
    evidence,
    exemptions,
    requiredConsumerIds,
    missingConsumerIds,
    exemptedConsumerIds,
    blockingReasons,
    gateReady,
    decision,
  } = detail;
  const [reason, setReason] = useState('');
  const [tab, setTab] = useState<'candidate' | 'baseline'>('candidate');

  const evidenceByConsumer = new Map(evidence.map((e) => [e.consumerId, e]));
  const consumerName = (id: string) => consumers.find((c) => c.id === id)?.name ?? id;
  const consumerNames = new Map(consumers.map((c) => [c.id, c.name]));

  return (
    <div>
      <div className="card">
        <div className="detail-header">
          <div>
            <h2 style={{ marginBottom: 4 }}>Proposal {shortHash(proposal.candidateHash)}</h2>
            <div className="hash-full">{proposal.candidateHash}</div>
            <div className="muted mt8">
              created {timeAgo(proposal.createdAt, now)} · environment: <strong>{proposal.environment}</strong>
            </div>
          </div>
          <div className="flex-row">
            <span className={`badge ${proposal.status}`}>{proposal.status}</span>
            <span className={`badge ${gateReady ? 'ready' : 'blocked'}`}>
              {gateReady ? 'gate ready' : 'blocked'}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>System Compatibility</h2>
        <span className={`badge ${proposal.systemCompatibility.compatible ? 'compatible' : 'incompatible'}`}>
          {proposal.systemCompatibility.compatible ? 'backward compatible' : 'breaking change'}
        </span>
        {proposal.systemCompatibility.issues.length > 0 && (
          <ul className="blocking-list mt8">
            {proposal.systemCompatibility.issues.map((issue, i) => (
              <li key={i}>
                <strong>[{issue.code}]</strong> {issue.message} <span className="muted">at {issue.path}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          The system compatibility check is never waived by an exemption; it is recomputed from the immutable
          candidate summary.
        </div>
      </div>

      <div className="card">
        <h2>
          Consumer Evidence ({evidence.length}/{requiredConsumerIds.length})
          {exemptedConsumerIds.length > 0 && (
            <span className="badge exempt" style={{ marginLeft: 8 }}>
              {exemptedConsumerIds.length} exempted
            </span>
          )}
        </h2>
        <div className="consumer-grid">
          {requiredConsumerIds.map((cid) => {
            const e = evidenceByConsumer.get(cid);
            const isMissing = missingConsumerIds.includes(cid);
            const isExempted = exemptedConsumerIds.includes(cid);
            return (
              <div key={cid} className="consumer-row">
                <div>
                  <div className="name">{consumerName(cid)}</div>
                  <div className="cid mono">{cid}</div>
                </div>
                <div>
                  {e ? (
                    <span className={`badge ${e.verdict}`}>{e.verdict}</span>
                  ) : isExempted ? (
                    <span className="badge exempt">exempted</span>
                  ) : (
                    <span className="badge missing">awaiting</span>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {e && (
                    <>
                      <div className="fresh">
                        {timeAgo(e.recordedAt, now)} · {shortHash(e.candidateHash)}
                      </div>
                      {e.details && <div className="cid">{e.details}</div>}
                    </>
                  )}
                  {isExempted && <div className="fresh">offline; waived by active exemption</div>}
                  {isMissing && <div className="fresh">no evidence</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ExemptionsPanel
        proposal={proposal}
        exemptions={exemptions}
        consumerNames={consumerNames}
        onChange={onExemptionChange}
      />

      <div className="card">
        <h2>Gate Evaluation</h2>
        {blockingReasons.length === 0 ? (
          <ul className="blocking-list">
            <li className="ok">
              All evidence collected and compatible (or covered by active exemptions); proposal is eligible for
              approval.
            </li>
          </ul>
        ) : (
          <ul className="blocking-list">
            {blockingReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}

        {proposal.status === 'pending' && (
          <div className="actions">
            <input
              placeholder="Decision reason (optional)..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={!gateReady} onClick={() => onDecide('approve', reason)}>
              Approve
            </button>
            <button className="danger" onClick={() => onDecide('reject', reason)}>
              Reject
            </button>
          </div>
        )}

        {decision && (
          <div className="mt16">
            <h2 style={{ fontSize: 13 }}>Immutable Decision Snapshot</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              decided {timeAgo(decision.decidedAt, now)} · gate was{' '}
              <span className={decision.snapshot.gateReady ? '' : 'muted'}>
                {decision.snapshot.gateReady ? 'ready' : 'not ready'}
              </span>{' '}
              · {decision.snapshot.evidence.length} evidence frozen ·{' '}
              {decision.snapshot.appliedExemptions.length} exemption(s) frozen
            </div>
            <div className="schema-box">
              {JSON.stringify(
                {
                  decision: decision.decision,
                  reason: decision.reason,
                  decidedAt: decision.decidedAt,
                  gateReady: decision.snapshot.gateReady,
                  blockingReasons: decision.snapshot.blockingReasons,
                  evidence: decision.snapshot.evidence.map((e) => ({
                    consumer: e.consumerId,
                    verdict: e.verdict,
                    hash: e.candidateHash,
                    recordedAt: e.recordedAt,
                  })),
                  appliedExemptions: decision.snapshot.appliedExemptions.map((ex) => ({
                    consumer: ex.consumerId,
                    environment: ex.environment,
                    direction: ex.direction,
                    requester: ex.requesterId,
                    confirmer: ex.confirmerId,
                    validFrom: ex.validFrom,
                    validUntil: ex.validUntil,
                    reason: ex.reason,
                  })),
                },
                null,
                2,
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="tabs">
          <button className={tab === 'candidate' ? 'active' : ''} onClick={() => setTab('candidate')}>
            Candidate Schema
          </button>
          <button className={tab === 'baseline' ? 'active' : ''} onClick={() => setTab('baseline')}>
            Baseline Schema
          </button>
        </div>
        <div className="schema-box">
          {JSON.stringify(tab === 'candidate' ? proposal.candidateSchema : proposal.baselineSchema, null, 2)}
        </div>
      </div>
    </div>
  );
}
