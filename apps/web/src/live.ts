import { EVENTS_ENDPOINT, HMR_EVENT } from './protocol';
import type { SnapshotEvent } from './protocol';
import { HAS_SERVER } from './runtime';

/**
 * 訂閱本機 repo 的更新：dev server 用 HMR，npm CLI 的 server 用 SSE（EventSource 斷線會自己重連；
 * server 在每次連上時先送一份預設 repo 的快照，重新啟動後畫面也會跟上）。靜態建置沒有更新。
 */
export function subscribeSnapshots(
  listener: (event: SnapshotEvent | undefined) => void,
): () => void {
  const hot = import.meta.hot;
  if (hot) {
    hot.on(HMR_EVENT, listener);
    return () => hot.off(HMR_EVENT, listener);
  }
  if (!HAS_SERVER || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(EVENTS_ENDPOINT);
  const onMessage = (e: MessageEvent<string>) => {
    let event: unknown;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    listener(event && typeof event === 'object' ? (event as SnapshotEvent) : undefined);
  };
  source.addEventListener('message', onMessage);
  return () => {
    source.removeEventListener('message', onMessage);
    source.close();
  };
}
