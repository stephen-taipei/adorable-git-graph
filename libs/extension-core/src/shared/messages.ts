import type { DiagnosticRequest, GraphData } from '@adorable/graph-core';

export type BgRequest =
  | { type: 'fetch-graph'; owner: string; repo: string; branchHint?: string; force?: boolean }
  | { type: 'open-options' }
  | { type: 'rate-limit' }
  | { type: 'clear-cache' }
  | { type: 'diagnostic'; owner: string; repo: string; requestId: string; query: DiagnosticRequest }
  | { type: 'diagnostic-cancel'; requestId: string };

export interface BgError {
  code: string;
  message: string;
  resetAt?: number;
}

export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: BgError };

export type FetchGraphResponse = BgResponse<{ graph: GraphData; fromCache: boolean }>;
export type RateLimitResponse = BgResponse<{
  limit: number;
  remaining: number;
  reset: number;
  authenticated: boolean;
}>;

export type TabCommand = { type: 'toggle' } | { type: 'data-invalidated' };

/** content script / options page → background 的簡易 RPC。 */
export function sendToBackground<R extends BgResponse>(req: BgRequest): Promise<R> {
  return chrome.runtime.sendMessage(req) as Promise<R>;
}
