import { appendCommits, isValidRepoSegment, missingParents } from '@adorable/graph-core';
import type { CommitInput, GitHubErrorCode, GraphData } from '@adorable/graph-core';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT } from './messages';
import type { BgRequest } from './messages';

type FetchMoreRequest = Extract<BgRequest, { type: 'fetch-more' }>;

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * background 收到的 fetch-more 請求是否合法：owner / repo 是合法的 repo 名稱、shas 是 1–FETCH_MORE_MAX_STARTS 個
 * 40 位 hex。不合法回傳 null（不碰網路）。回傳值是新建的物件，不帶任何多餘的欄位。
 */
export function parseFetchMore(raw: unknown): FetchMoreRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'fetch-more') return null;
  const { owner, repo, shas, generation } = r;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (typeof generation !== 'string' || generation.length === 0 || generation.length > 64)
    return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  if (!Array.isArray(shas) || shas.length === 0 || shas.length > FETCH_MORE_MAX_STARTS) return null;
  if (!shas.every((s): s is string => typeof s === 'string' && SHA_RE.test(s))) return null;
  return { type: 'fetch-more', owner, repo, shas: [...shas], generation };
}

/**
 * 下一批要從哪些 missing parent 往回抓：去掉已經確認抓不到的（`dead`），最多 FETCH_MORE_MAX_STARTS 個；
 * 已載入的數量到 HISTORY_LIMIT 就不再抓（回傳空陣列 = 沒有更多可以載入）。
 */
export function nextStarts(graph: GraphData, dead: ReadonlySet<string>): string[] {
  if (graph.commits.length >= HISTORY_LIMIT) return [];
  return missingParents(graph)
    .filter((sha) => !dead.has(sha))
    .slice(0, FETCH_MORE_MAX_STARTS);
}

/**
 * 把一批更早的 commit 併進來。請求過、回來之後卻仍然不在圖裡的起點（GitHub 已經不認得，例如 force push 後被回收）
 * 記進 `dead`，之後不再從它往回抓，否則「還有更早的」永遠不會結束。沒有任何變化時回傳原本的物件。
 */
export function mergeOlder(
  graph: GraphData,
  dead: ReadonlySet<string>,
  requested: readonly string[],
  older: readonly CommitInput[],
): { graph: GraphData; dead: ReadonlySet<string> } {
  const next = appendCommits(graph, older);
  const have = new Set(next.commits.map((c) => c.sha));
  const gone = requested.filter((sha) => !have.has(sha) && !dead.has(sha));
  return { graph: next, dead: gone.length > 0 ? new Set([...dead, ...gone]) : dead };
}

/** 已載入的歷史：圖本身 + 已經確認抓不到的起點（見 mergeOlder）。 */
export interface LoadedHistory {
  graph: GraphData;
  dead: ReadonlySet<string>;
}

/**
 * 一批 fetch-more 回來時，把它併進「目前的」歷史。`from` 是送出請求時的圖：之後圖已經被換掉了
 * （重新整理的第一批先回來、換了 repo）就回傳 null，整批丟掉。那批是從舊圖的 missing parent 抓的，
 * 併進新的第一批會變成一段斷開的歷史（force push 之後甚至是永遠接不上的孤兒）。
 * 沒有任何變化時回傳 `current` 本身（React 那邊就不會重新排版）。
 */
export function mergeBatch<T extends LoadedHistory>(
  current: T | null,
  from: GraphData,
  requested: readonly string[],
  older: readonly CommitInput[],
): T | LoadedHistory | null {
  if (!current || current.graph !== from) return null;
  const next = mergeOlder(current.graph, current.dead, requested, older);
  return next.graph === current.graph && next.dead === current.dead ? current : next;
}

const GITHUB_ERROR_CODES: Record<GitHubErrorCode, true> = {
  invalid_repo: true,
  not_found: true,
  unauthorized: true,
  rate_limited: true,
  empty_repo: true,
  network: true,
  unknown: true,
};

/**
 * GitGraphViewer 的 `history.error`：一律給 GitHub 的錯誤代碼（graph-ui 的 `Messages.errors` 的 key），
 * viewer 會翻譯它，並在前面加上「更早的歷史載入失敗」。background 自己的代碼（例如 'invalid'）或看不懂的值
 * 一律當成 'unknown'，不會把代碼原文顯示給使用者。
 */
export function historyErrorCode(code: unknown): GitHubErrorCode {
  return typeof code === 'string' && Object.hasOwn(GITHUB_ERROR_CODES, code)
    ? (code as GitHubErrorCode)
    : 'unknown';
}
