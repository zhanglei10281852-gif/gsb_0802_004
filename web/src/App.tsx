import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSnapshot } from './api';
import type { ProposalDetail, Snapshot } from './api';
import { TopBar } from './components/TopBar';
import type { SseState } from './components/TopBar';
import { ProposalList } from './components/ProposalList';
import { CreateProposalForm } from './components/CreateProposalForm';
import { ProposalDetailView } from './components/ProposalDetailView';

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sseState, setSseState] = useState<SseState>('connecting');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<Snapshot | null> => {
    try {
      const snap = await fetchSnapshot();
      setSnapshot(snap);
      setLoadError(null);
      return snap;
    } catch {
      setLoadError('快照加载失败，将在连接恢复后自动重试。');
      return null;
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let timer: number | undefined;

    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh();
      }, 200);
    };

    void (async () => {
      const initial = await refresh();
      if (closed) {
        return;
      }
      const since = initial ? initial.eventCursor : 0;
      es = new EventSource(`/api/events?since=${since}`);
      // 每次（重）建立连接都全量替换快照，保证重连后状态一致
      es.onopen = () => {
        setSseState('connected');
        void refresh();
      };
      es.onerror = () => {
        setSseState('reconnecting');
      };
      es.onmessage = () => {
        scheduleRefresh();
      };
    })();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      if (es) {
        es.close();
      }
    };
  }, [refresh]);

  const selected = useMemo<ProposalDetail | null>(() => {
    if (!snapshot) {
      return null;
    }
    if (selectedId) {
      const found = snapshot.proposals.find((p) => p.id === selectedId);
      if (found) {
        return found;
      }
    }
    return snapshot.proposals.length > 0 ? snapshot.proposals[0] : null;
  }, [snapshot, selectedId]);

  const handleRefresh = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const handleCreated = useCallback(
    (created: ProposalDetail) => {
      setSelectedId(created.id);
      void refresh();
    },
    [refresh],
  );

  return (
    <div className="app">
      <TopBar
        sseState={sseState}
        serverTime={snapshot ? snapshot.serverTime : null}
        eventCursor={snapshot ? snapshot.eventCursor : null}
      />
      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <h2 className="panel-title">提案列表</h2>
            {loadError && <div className="alert alert-error">{loadError}</div>}
            <ProposalList
              proposals={snapshot ? snapshot.proposals : []}
              selectedId={selected ? selected.id : null}
              onSelect={setSelectedId}
            />
          </section>
          <section className="panel">
            <h2 className="panel-title">新建提案</h2>
            <CreateProposalForm onCreated={handleCreated} />
          </section>
        </aside>
        <main className="content">
          {selected && snapshot ? (
            <ProposalDetailView
              key={selected.id}
              proposal={selected}
              serverTime={snapshot.serverTime}
              onRefresh={handleRefresh}
            />
          ) : (
            <div className="panel empty-detail">{snapshot ? '暂无提案，请在左侧新建。' : '正在加载快照…'}</div>
          )}
        </main>
      </div>
    </div>
  );
}
