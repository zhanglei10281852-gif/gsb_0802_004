import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  api,
  shortHash,
  timeAgo,
  type CausalEvent,
  type Consumer,
  type ProposalDetail,
  type Snapshot,
} from './api';
import { ProposalDetailView } from './components/ProposalDetailView';
import { EventLog } from './components/EventLog';
import { Composer } from './components/Composer';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<CausalEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const refreshSnapshot = useCallback(async () => {
    try {
      const snap = await api.snapshot();
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      const res = await api.causalEvents();
      setEvents(res.events);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const connect = () => {
      const es = new EventSource('/api/stream');
      esRef.current = es;
      es.onopen = () => !cancelled && setConnected(true);
      es.onerror = () => {
        if (!cancelled) setConnected(false);
      };
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string; data?: unknown; event?: CausalEvent };
          if (msg.type === 'snapshot') {
            setSnapshot(msg.data as Snapshot);
            setError(null);
          } else if (msg.type === 'event') {
            setEvents((prev) => {
              if (msg.event && !prev.some((e) => e.id === msg.event!.id)) {
                return [...prev, msg.event].sort((a, b) => a.id - b.id);
              }
              return prev;
            });
            void refreshSnapshot();
          }
        } catch {
          /* ignore malformed */
        }
      };
    };
    connect();
    void refreshEvents();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      esRef.current?.close();
    };
  }, [refreshSnapshot, refreshEvents]);

  const selected = useMemo(
    () => snapshot?.proposals.find((p) => p.proposal.id === selectedId) ?? null,
    [snapshot, selectedId],
  );

  const proposals = snapshot?.proposals ?? [];
  const consumers = snapshot?.consumers ?? [];

  const handleDecision = async (action: 'approve' | 'reject', reason: string) => {
    if (!selected) return;
    try {
      await api.decide(selected.proposal.id, action, reason);
      await refreshSnapshot();
      await refreshEvents();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Data Contract Control Center</h1>
        <div className="flex-row">
          {error && <span className="badge rejected">{error}</span>}
          <div className="conn">
            <span className={`dot ${connected ? 'live' : ''}`} />
            {connected ? 'live' : 'reconnecting…'}
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <div className="flex-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <p className="section-title" style={{ margin: 0 }}>
            Proposals ({proposals.length})
          </p>
          <button onClick={() => setShowComposer((v) => !v)} style={{ padding: '4px 10px' }}>
            + New
          </button>
        </div>

        {showComposer && (
          <Composer
            consumers={consumers}
            onCreated={async () => {
              setShowComposer(false);
              await refreshSnapshot();
              await refreshEvents();
            }}
          />
        )}

        {proposals.length === 0 && <div className="empty">No proposals yet</div>}
        {proposals.map((p) => (
          <div
            key={p.proposal.id}
            className={`proposal-item ${selectedId === p.proposal.id ? 'active' : ''}`}
            onClick={() => setSelectedId(p.proposal.id)}
          >
            <div className="hash">
              {shortHash(p.proposal.candidateHash)}
              {p.proposal.revision > 1 && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>rev {p.proposal.revision}</span>}
            </div>
            <div className="meta">
              <span className={`badge ${p.proposal.status}`}>{p.proposal.status}</span>
              <span>
                {p.evidence.length}/{p.requiredConsumerIds.length} evidence
              </span>
              <span>{timeAgo(p.proposal.createdAt, now)}</span>
            </div>
          </div>
        ))}

        <div className="mt16">
          <p className="section-title">Consumers ({consumers.length})</p>
          {consumers.map((c) => (
            <div key={c.id} className="consumer-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <div className="name">{c.name}</div>
                <div className="cid mono">{c.id}</div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="detail">
        {selected ? (
          <ProposalDetailView
            detail={selected}
            consumers={consumers}
            now={now}
            onDecide={handleDecision}
            onSelectProposal={setSelectedId}
            onExemptionChange={() => {
              void refreshSnapshot();
              void refreshEvents();
            }}
            onLineageChanged={() => {
              void refreshSnapshot();
              void refreshEvents();
            }}
          />
        ) : (
          <div className="empty">Select a proposal to inspect evidence and make a decision</div>
        )}
      </main>

      <aside className="events">
        <p className="section-title">Causal Log ({events.length})</p>
        <EventLog events={events} />
      </aside>
    </div>
  );
}
