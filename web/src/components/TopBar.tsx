import { formatTime } from '../format';

export type SseState = 'connecting' | 'connected' | 'reconnecting';

const SSE_STATE_LABEL: Record<SseState, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
};

interface TopBarProps {
  sseState: SseState;
  serverTime: number | null;
  eventCursor: number | null;
}

export function TopBar({ sseState, serverTime, eventCursor }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-title">契约变更控制中心</div>
      <div className="topbar-meta">
        <span className={`sse-indicator sse-${sseState}`}>
          <span className="sse-dot" />
          <span>{SSE_STATE_LABEL[sseState]}</span>
        </span>
        <span>服务器时间：{serverTime === null ? '—' : formatTime(serverTime)}</span>
        <span>事件游标：{eventCursor === null ? '—' : eventCursor}</span>
      </div>
    </header>
  );
}
