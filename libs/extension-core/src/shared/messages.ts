import type { CommitInput, DiagnosticRequest, GraphData } from '@adorable/graph-core';

/** 一次「載入更早的歷史」最多從幾個 missing parent 往回抓（每個起點一個 API 請求）。 */
export const FETCH_MORE_MAX_STARTS = 5;
/** 已載入的 commit 到這個數量就不再往回載入（infinite scroll 的上限，和 web app 的 MAX_DEPTH 一致）。 */
export const HISTORY_LIMIT = 5000;

export type BgRequest =
  | { type: 'fetch-graph'; owner: string; repo: string; branchHint?: string; force?: boolean }
  /** infinite scroll：從這些 missing parent（40 位 hex，最多 FETCH_MORE_MAX_STARTS 個）各往回抓一頁。 */
  | {
      type: 'fetch-more';
      owner: string;
      repo: string;
      shas: string[];
      /** 第一批（fetch-graph）回傳的 diagnosticGeneration；設定換過就回 source_changed。 */
      generation: string;
    }
  | { type: 'open-options' }
  | { type: 'rate-limit' }
  | { type: 'clear-cache' }
  | {
      type: 'diagnostic';
      owner: string;
      repo: string;
      requestId: string;
      generation: string;
      query: DiagnosticRequest;
    }
  | { type: 'diagnostic-cancel'; requestId: string };

export interface BgError {
  code: string;
  message: string;
  resetAt?: number;
}

export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: BgError };

export type FetchGraphResponse = BgResponse<{
  graph: GraphData;
  fromCache: boolean;
  /** Opaque background lifetime/auth scope; never a token or its hash. */
  diagnosticGeneration: string;
}>;
export type FetchMoreResponse = BgResponse<{ commits: CommitInput[] }>;
export type RateLimitResponse = BgResponse<{
  limit: number;
  remaining: number;
  reset: number;
  authenticated: boolean;
}>;

export type TabCommand = { type: 'toggle' } | { type: 'data-invalidated' };

/** sendToBackground 用的 port 名稱（background 只回應這個名稱的連線）。 */
export const RPC_PORT = 'agg-rpc';

interface Call {
  req: BgRequest;
  port: chrome.runtime.Port | null;
  resolve: (res: never) => void;
  reject: (err: Error) => void;
}
const pending = new Set<Call>();
let watching = false;

/**
 * content script / options page → background 的簡易 RPC。每個請求一條 port，而不是 runtime.sendMessage：
 * 頁面離開（換頁、進 bfcache）時 sendMessage 的回應會被 Firefox 丟掉並記一筆
 * "Promise resolved while context is inactive"，promise 也永遠不會完成——從 bfcache 回來的頁面會一直停在載入中。
 * port 可以在 pagehide 時主動斷開（回應不會再送進來），回到頁面（pageshow persisted）再把沒完成的請求重送一次。
 */
export function sendToBackground<R extends BgResponse>(req: BgRequest): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    const call: Call = { req, port: null, resolve: resolve as (res: never) => void, reject };
    pending.add(call);
    watchLifecycle();
    connect(call);
  });
}

function connect(call: Call) {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: RPC_PORT });
  } catch (err) {
    // 例如 extension 剛更新：舊 content script 的 context 已失效
    settle(call);
    call.reject(err instanceof Error ? err : new Error(String(err)));
    return;
  }
  call.port = port;
  port.onMessage.addListener((res) => {
    if (call.port !== port) return;
    settle(call);
    call.resolve(res as never);
  });
  port.onDisconnect.addListener(() => {
    if (call.port !== port) return;
    settle(call);
    call.reject(new Error(chrome.runtime.lastError?.message ?? 'Background disconnected'));
  });
  port.postMessage(call.req);
}

function settle(call: Call) {
  pending.delete(call);
  const port = call.port;
  call.port = null;
  try {
    port?.disconnect();
  } catch {
    // 已經斷開
  }
}

function watchLifecycle() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('pagehide', () => {
    for (const call of pending) {
      const port = call.port;
      call.port = null;
      try {
        port?.disconnect();
      } catch {
        // 已經斷開
      }
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const call of [...pending]) if (!call.port) connect(call);
  });
}
