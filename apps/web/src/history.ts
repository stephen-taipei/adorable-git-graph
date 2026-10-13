import { MAX_DEPTH } from './protocol';
import { LOCAL_ONLY } from './localRepos';
import { t } from './i18n';

/**
 * 更早的歷史（infinite scroll）的共用規則：本機（向 dev server 要更深的快照）與 GitHub（從缺的 parent 往回抓）都用。
 */

/** 一次多要幾筆 */
export const HISTORY_PAGE = 300;

/** 下一次要讀到多深：已載入 + 一頁，最多 MAX_DEPTH。 */
export const nextDepth = (loaded: number): number =>
  Math.min(MAX_DEPTH, Math.max(1, Math.floor(loaded)) + HISTORY_PAGE);

export interface PagingState {
  loading: boolean;
  /**
   * 上一次載入失敗的原因：graph-ui 認得的錯誤代碼（'network'、'rate_limited'…）或簡短的原因（localHistoryError），
   * 不含「更早的歷史載入失敗」的前綴。有值時 viewer 顯示「再試一次」，不自動重試
   */
  error?: string;
  /**
   * 上一次載入完 commit 數沒有變多（shallow clone 的邊界、GitHub 回來的全是已有的）：
   * 這個數量就是盡頭了，不要再顯示「還有更早的」。之後 commit 數變了（有新 commit）就重新判斷。
   */
  exhaustedAt?: number;
}

/** 還能不能往前載入：來源說被截斷了、還沒到上限、上一次也不是白跑。 */
export function hasMore(
  truncated: boolean | undefined,
  loaded: number,
  paging: PagingState | undefined,
): boolean {
  if (!truncated || loaded >= MAX_DEPTH) return false;
  return paging?.exhaustedAt === undefined || loaded > paging.exhaustedAt;
}

/**
 * 本機的更早歷史載入失敗時交給 viewer 的 `history.error`：只有原因（viewer 自己會在前面加上
 * 「更早的歷史載入失敗 · 」，見 graph-ui 的 historyErrorText），不要再給完整的句子，否則前綴會重複。
 * `result`：fetchLocalSnapshot 失敗時的回傳值。
 */
export function localHistoryError(result: 'unknown' | typeof LOCAL_ONLY | null): string {
  if (result === 'unknown') return t.historyErrors.unknown;
  if (result === LOCAL_ONLY) return t.historyErrors.localOnly;
  return t.historyErrors.offline;
}

/** 載入完成：commit 數沒變多就記下盡頭。 */
export const settled = (before: number, after: number): PagingState =>
  after <= before ? { loading: false, exhaustedAt: after } : { loading: false };
