import type { CausalEvent } from '../api';

export function EventLog({ events }: { events: CausalEvent[] }) {
  const sorted = [...events].sort((a, b) => b.id - a.id);
  return (
    <div>
      {sorted.length === 0 && <div className="empty">No events yet</div>}
      {sorted.map((e) => (
        <div key={e.id} className={`event-item ${e.type}`}>
          <div className="flex-row" style={{ justifyContent: 'space-between' }}>
            <span className="et">{e.type}</span>
            <span className="ec">#{e.id} · clock {e.clock}</span>
          </div>
          <pre>{JSON.stringify(e.payload, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
