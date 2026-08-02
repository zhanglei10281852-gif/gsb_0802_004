import type { ProposalDetail } from '../api';
import { PROPOSAL_STATUS_LABEL } from '../format';

interface ProposalListProps {
  proposals: ProposalDetail[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProposalList({ proposals, selectedId, onSelect }: ProposalListProps) {
  if (proposals.length === 0) {
    return <div className="empty-hint">暂无提案，请在下方新建。</div>;
  }
  return (
    <ul className="proposal-list">
      {proposals.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className={`proposal-item${p.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <div className="proposal-item-title">{p.title}</div>
            <div className="proposal-item-badges">
              <span className={`badge badge-status-${p.status}`}>{PROPOSAL_STATUS_LABEL[p.status]}</span>
              <span className={`badge ${p.gate.status === 'ready' ? 'badge-ready' : 'badge-blocked'}`}>
                {p.gate.status === 'ready' ? '就绪' : '阻塞'}
              </span>
            </div>
            <div className="proposal-item-meta">
              <span>v{p.version}</span>
              <span className="mono" title={p.candidateDigest}>
                {p.candidateDigest.slice(0, 12)}
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
