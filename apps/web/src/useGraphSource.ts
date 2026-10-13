import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import snapshot from 'virtual:git-snapshot';
import {
  GitHubError,
  fetchGitHubGraph,
  fetchMoreGitHubHistory,
  missingParents,
  createGitHubDiagnostics,
  cacheDiagnostics,
} from '@adorable/graph-core';
import type { DiagnosticAdapter } from '@adorable/graph-core';
import { createLocalAdapter } from './diagnostics';
import type { GraphData } from '@adorable/graph-core';
import { useStableLayout } from '@adorable/graph-ui';
import type { HistoryState, ViewerState } from '@adorable/graph-ui';
import { DEFAULT_REPO, isRepoId, snapshotKey } from './protocol';
import type { GitSnapshot, SnapshotEvent } from './protocol';
import type { Source } from './source';
import { LOCAL_ONLY, fetchLocalSnapshot } from './localRepos';
import { subscribeSnapshots } from './live';
import { HAS_SERVER } from './runtime';
import { hasMore, localHistoryError, nextDepth, settled } from './history';
import type { PagingState } from './history';
import { t } from './i18n';

const GH_CACHE_MS = 10 * 60_000;
const GH_CACHE_PREFIX = 'agg:gh:';
const API_BASE: string | undefined = import.meta.env['VITE_GITHUB_API_BASE'];
const KEEPALIVE_MS = 2 * 60_000;

type Missing = 'unknown' | 'offline' | typeof LOCAL_ONLY;

/**
 * 本機：預設 repo 是啟動 / 建置當下的快照；dev 時可以切到 dev server 清單裡的其他 repo，
 * 每個 repo 的更新都由 HMR 推送（payload 帶 repo id）。
 * 監聽器一律註冊（不隨目前顯示的來源開關）：切到別處期間發生的 commit，切回來時才不會是舊圖。
 */
/** `selection`：每次導覽（含再選一次同一個 repo）都是新的物件，用來在同一個 id 上也重抓一次。 */
function useLocalSnapshot(id: string, selection: unknown) {
  // npm CLI 的建置沒有烤進去的快照：預設 repo 一開始也向 server 要（見下方）
  const [snaps, setSnaps] = useState<Record<string, GitSnapshot>>(() => {
    const initial: Record<string, GitSnapshot> = {};
    if (snapshot) initial[DEFAULT_REPO] = snapshot;
    return initial;
  });
  /** 'unknown'：dev server 不認得這個 id；'offline'：連不上；LOCAL_ONLY：不是從這台電腦開的畫面 */
  const [missing, setMissing] = useState<Record<string, Missing>>({});
  /** 更早的歷史（infinite scroll）的載入狀態，每個 repo 各自記 */
  const [paging, setPaging] = useState<Record<string, PagingState>>({});
  /** 每個 repo 要過的深度（commit 數）：之後的每一次讀取都帶著，dev server 忘了（閒置被停掉、重新啟動）也補得回來 */
  const wanted = useRef<Record<string, number>>({});
  const snapsRef = useRef(snaps);
  snapsRef.current = snaps;
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const current = useRef(id);
  current.current = id;

  const forget = useCallback((repo: string) => {
    setMissing((prev) => {
      if (!(repo in prev)) return prev;
      const next = { ...prev };
      delete next[repo];
      return next;
    });
  }, []);

  // 內容沒變就保留舊物件：不重算 layout，場景也就不會被重播、捲動位置不會被重設
  const accept = useCallback(
    (repo: string, next: GitSnapshot) => {
      setSnaps((prev) => {
        const cur = prev[repo];
        return cur && snapshotKey(cur) === snapshotKey(next) ? prev : { ...prev, [repo]: next };
      });
      forget(repo);
    },
    [forget],
  );

  const load = useCallback(
    async (repo: string) => {
      const result = await fetchLocalSnapshot(repo, wanted.current[repo]);
      if (result === 'unknown' || result === LOCAL_ONLY) {
        setMissing((prev) => ({ ...prev, [repo]: result }));
      } else if (result === null) setMissing((prev) => ({ ...prev, [repo]: 'offline' }));
      else accept(repo, result);
    },
    [accept],
  );

  /** 這個快照比畫面要過的還淺（dev server 忘了深度）：不要拿它把已經載入的更早歷史截掉 */
  const tooShallow = useCallback((repo: string, snap: GitSnapshot): boolean => {
    const graph = snap.graph;
    const want = wanted.current[repo];
    if (!graph || !want) return false;
    const count = graph.commits.length;
    return count < want && hasMore(graph.truncated, count, pagingRef.current[repo]);
  }, []);

  const setRepoPaging = useCallback((repo: string, next: PagingState) => {
    setPaging((prev) => ({ ...prev, [repo]: next }));
  }, []);

  /** 往前多讀一頁：向 dev server 要更深的快照（同一個 repo 之後的讀取與 HMR 推送也都會是這個深度） */
  const loadMore = useCallback(
    async (repo: string) => {
      const graph = snapsRef.current[repo]?.graph;
      if (!graph || pagingRef.current[repo]?.loading) return;
      const before = graph.commits.length;
      const depth = nextDepth(before);
      wanted.current[repo] = Math.max(wanted.current[repo] ?? 0, depth);
      pagingRef.current = { ...pagingRef.current, [repo]: { loading: true } };
      setRepoPaging(repo, { loading: true });
      const result = await fetchLocalSnapshot(repo, depth);
      if (result && typeof result === 'object') {
        accept(repo, result);
        setRepoPaging(repo, settled(before, result.graph?.commits.length ?? before));
        return;
      }
      if (result === 'unknown' || result === LOCAL_ONLY)
        setMissing((prev) => ({ ...prev, [repo]: result }));
      // 只給原因：viewer 會自己加上「更早的歷史載入失敗 · 」
      setRepoPaging(repo, { loading: false, error: localHistoryError(result) });
    },
    [accept, setRepoPaging],
  );

  useEffect(() => {
    const onEvent = (e: SnapshotEvent | undefined) => {
      if (!e || typeof e.repo !== 'string' || !isRepoId(e.repo)) return;
      // 預設 repo 直接帶著快照；其他 repo 只通知有變，正在看的才去拿（其他的切回來時本來就會重抓）
      // 帶著的快照比畫面要過的淺（dev server 重新啟動、忘了深度）：帶著深度重抓，不要先縮回去再長回來
      if (e.snapshot) {
        if (tooShallow(e.repo, e.snapshot)) void load(e.repo);
        else accept(e.repo, e.snapshot);
      } else if (e.repo === current.current && e.repo !== DEFAULT_REPO) void load(e.repo);
    };
    return subscribeSnapshots(onEvent);
  }, [accept, load, tooShallow]);

  // 沒有烤進 bundle 的預設快照（npm CLI）：啟動時向 server 要一次，之後的更新由 SSE 推送
  useEffect(() => {
    if (HAS_SERVER && !snapshot) void load(DEFAULT_REPO);
  }, [load]);

  // 非預設 repo：每次選到（包含切回來）都向 dev server 要最新快照——它也會因此（重新）開始監看這個 repo。
  // 顯示期間每 2 分鐘、以及分頁回到前景時再抓一次：dev server 會停掉 10 分鐘沒人要的 repo，這也是漏掉通知時的安全網。
  useEffect(() => {
    if (!HAS_SERVER || id === DEFAULT_REPO) return;
    forget(id);
    void load(id);
    const again = () => {
      if (!document.hidden) void load(id);
    };
    const timer = setInterval(again, KEEPALIVE_MS);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', again);
    };
  }, [id, selection, load, forget]);

  const refresh = useCallback(() => load(id), [id, load]);
  const more = useCallback(() => void loadMore(id), [id, loadMore]);
  return { snap: snaps[id], missing: missing[id], refresh, loadMore: more, paging: paging[id] };
}

type Remote =
  | { kind: 'loading' }
  | { kind: 'error'; sourceIdentity: object; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; sourceIdentity: object; graph: GraphData };

interface GhCacheEntry {
  savedAt: number;
  graph: GraphData;
  /** Private credential fingerprint; old boolean-only entries are not trusted. */
  credentialScope: string;
}

async function githubCredentialScope(token: string): Promise<string | null> {
  // Non-secure static hosts can still query; disable caching when WebCrypto is unavailable.
  if (!globalThis.crypto?.subtle) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
function readGhCache(key: string, scope: string | null): GraphData | null {
  if (!scope) return null;
  try {
    const raw = sessionStorage.getItem(GH_CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as GhCacheEntry;
    if (Date.now() - entry.savedAt >= GH_CACHE_MS) return null;
    if (entry.credentialScope !== scope) return null;
    return entry.graph;
  } catch {
    return null;
  }
}

/** token 變更（含清除）時呼叫：認證後抓到的私有 repo 資料不該在 token 移除後還留在 sessionStorage。 */
export function clearGitHubCache(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(GH_CACHE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

function writeGhCache(key: string, graph: GraphData, scope: string | null) {
  if (!scope) return;
  try {
    const entry: GhCacheEntry = { savedAt: Date.now(), graph, credentialScope: scope };
    sessionStorage.setItem(GH_CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* 容量不足等：略過 */
  }
}

/** 任意 GitHub repo：直接從瀏覽器呼叫 REST API（CORS 允許），結果快取 10 分鐘。 */
function useGitHubGraph(source: Source, token: string) {
  const [remote, setRemote] = useState<Remote>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ code: string; message?: string } | null>(null);
  const key = source.kind === 'github' ? (source.owner + '/' + source.repo).toLowerCase() : '';
  // Opaque render identity: no credential value or fingerprint reaches the viewer.
  const identity = useMemo(() => ({}), [source.kind, key, token]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const current =
    remote.kind === 'loading' || remote.sourceIdentity === identity
      ? remote
      : ({ kind: 'loading' } as const);
  const remoteRef = useRef(current);
  remoteRef.current = current;
  const force = useRef(false);
  /** 更早的歷史（從缺的 parent 往回抓）：換 repo / token、重新整理時重設 */
  const [paging, setPaging] = useState<PagingState | undefined>(undefined);
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const moreCtrl = useRef<AbortController | null>(null);

  useEffect(() => {
    // 載入中的更早歷史是針對舊的圖：換 repo / token、重新整理都放掉
    moreCtrl.current?.abort();
    moreCtrl.current = null;
    setPaging(undefined);
    if (source.kind !== 'github') return;
    const forced =
      force.current &&
      remoteRef.current.kind === 'ready' &&
      remoteRef.current.sourceIdentity === identity;
    force.current = false;
    const ctrl = new AbortController();
    const active = () => !ctrl.signal.aborted && identityRef.current === identity;
    setRemote((prev) =>
      forced && prev.kind === 'ready' && prev.sourceIdentity === identity
        ? prev
        : { kind: 'loading' },
    );
    setRefreshing(forced);
    setRefreshError(null);
    const fail = (err: { code: string; message?: string; resetAt?: number }) => {
      if (!active()) return;
      setRefreshing(false);
      if (
        forced &&
        remoteRef.current.kind === 'ready' &&
        remoteRef.current.sourceIdentity === identity
      )
        setRefreshError(err);
      else setRemote({ kind: 'error', sourceIdentity: identity, ...err });
    };
    void (async () => {
      // Cache scopes are private to this module/storage, never part of UI or diagnostic data.
      const scope = await githubCredentialScope(token);
      if (!active()) return;
      if (!forced) {
        const hit = readGhCache(key, scope);
        if (hit && active()) {
          setRefreshing(false);
          setRemote({ kind: 'ready', sourceIdentity: identity, graph: hit });
          return;
        }
      }
      const graph = await fetchGitHubGraph(source.owner, source.repo, {
        token: token || undefined,
        apiBase: API_BASE,
        signal: ctrl.signal,
      });
      if (!active()) return;
      writeGhCache(key, graph, scope);
      setRefreshing(false);
      setRemote({ kind: 'ready', sourceIdentity: identity, graph });
    })().catch((err: unknown) => {
      if (err instanceof GitHubError)
        fail({ code: err.code, message: err.message, resetAt: err.resetAt });
      else fail({ code: 'unknown', message: err instanceof Error ? err.message : String(err) });
    });
    return () => ctrl.abort();
  }, [source.kind, key, token, nonce, identity]);

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => () => moreCtrl.current?.abort(), []);

  const owner = source.kind === 'github' ? source.owner : '';
  const name = source.kind === 'github' ? source.repo : '';
  const loadMore = useCallback(() => {
    const cur = remoteRef.current;
    if (cur.kind !== 'ready' || pagingRef.current?.loading || !owner) return;
    const ctrl = new AbortController();
    moreCtrl.current?.abort();
    moreCtrl.current = ctrl;
    const before = cur.graph.commits.length;
    // 送出時的來源（repo + token）：之後換掉了就整批丟掉，不用新的 credential 補舊的圖
    const sourceIdentity = cur.sourceIdentity;
    const active = () => !ctrl.signal.aborted && identityRef.current === sourceIdentity;
    pagingRef.current = { loading: true };
    setPaging({ loading: true });
    void (async () => {
      const graph = await fetchMoreGitHubHistory(owner, name, cur.graph, {
        token: token || undefined,
        apiBase: API_BASE,
        signal: ctrl.signal,
      });
      const scope = await githubCredentialScope(token);
      if (!active()) return;
      moreCtrl.current = null;
      // 等待期間圖換掉了（重新整理完成）：這批是接在舊圖後面的，丟掉
      const now = remoteRef.current;
      if (now.kind !== 'ready' || now.graph !== cur.graph) return setPaging(undefined);
      writeGhCache(key, graph, scope);
      if (graph !== cur.graph) setRemote({ kind: 'ready', sourceIdentity, graph });
      setPaging(settled(before, graph.commits.length));
    })().catch((err: unknown) => {
      if (!active()) return;
      moreCtrl.current = null;
      // 錯誤代碼（rate_limited、network…）：viewer 會顯示翻譯過的說明與「再試一次」
      setPaging({ loading: false, error: err instanceof GitHubError ? err.code : 'unknown' });
    });
  }, [owner, name, key, token]);

  return {
    remote: current,
    refresh,
    refreshing: current.kind === 'ready' && refreshing,
    refreshError: current.kind === 'ready' ? refreshError : null,
    loadMore,
    paging: current.kind === 'ready' ? paging : undefined,
  };
}

export interface GraphSource {
  diagnostics?: DiagnosticAdapter;
  state: ViewerState;
  /** 沒有後端可重讀時（靜態建置的本機快照）為 undefined，UI 不顯示重新整理。 */
  refresh: (() => void) | undefined;
  /** 標題列顯示用 */
  repoName?: { owner: string; name: string };
  /** 更早的歷史（infinite scroll）。靜態建置的本機快照沒有（只有建置當下的那一份）。 */
  loadMore?: () => void;
  history?: HistoryState;
}

export function useGraphSource(source: Source, token: string): GraphSource {
  // 靜態建置只有預設 repo 的快照（沒有 dev server 可以問）
  const localId =
    HAS_SERVER && source.kind === 'local' ? (source.id ?? DEFAULT_REPO) : DEFAULT_REPO;
  const local = useLocalSnapshot(localId, source);
  const gh = useGitHubGraph(source, token);
  const diagnostics = useMemo(
    () =>
      source.kind === 'github'
        ? cacheDiagnostics({
            ...createGitHubDiagnostics(source.owner, source.repo, {
              token: token || undefined,
              apiBase: API_BASE,
            }),
            context: { commit: source.commit, pullRequest: source.pullRequest },
          })
        : HAS_SERVER
          ? cacheDiagnostics(createLocalAdapter(localId))
          : undefined,
    [
      source.kind,
      source.kind === 'github' ? source.owner : '',
      source.kind === 'github' ? source.repo : '',
      source.kind === 'github' ? source.commit : '',
      source.kind === 'github' ? source.pullRequest : '',
      localId,
      token,
    ],
  );
  // dev server 說不認得 / 不給看這個 repo 時，不要繼續顯示快取的舊圖（它不會再更新了）
  const localSnap =
    local.missing === 'unknown' || local.missing === LOCAL_ONLY ? undefined : local.snap;

  const graph: GraphData | null =
    source.kind === 'local'
      ? (localSnap?.graph ?? null)
      : gh.remote.kind === 'ready'
        ? gh.remote.graph
        : null;
  // 取得階段已經限制過筆數（AGG_MAX_COMMITS / API 上限），這裡不要再用 buildLayout 預設的 400 偷偷截掉。
  // 同一個來源 + repo 的下一張圖以上一張的順序為準：往回載入的更早歷史接在最後面，
  // 不會照日期插進使用者正在看的列之間（GitHub 是每個 branch 各自往回抓）
  const layoutKey =
    source.kind === 'github'
      ? `github|${source.owner}/${source.repo}`.toLowerCase()
      : `local|${localId}`;
  const layout = useStableLayout(graph, layoutKey, {
    maxCommits: Math.max(graph?.commits.length ?? 0, 1),
  });

  // 還有沒有更早的：本機看 dev server 說的 truncated；GitHub 還要真的有「被引用、但沒載入」的 parent
  const ghMissing = useMemo(
    () => (source.kind === 'github' && graph ? missingParents(graph).length : 0),
    [source.kind, graph],
  );
  const paging = source.kind === 'github' ? gh.paging : local.paging;
  const count = graph?.commits.length ?? 0;
  const canPage =
    Boolean(graph) && (source.kind === 'github' || (HAS_SERVER && Boolean(localSnap)));
  const more =
    canPage &&
    hasMore(graph?.truncated, count, paging) &&
    (source.kind !== 'github' || ghMissing > 0);
  const loading = Boolean(paging?.loading);
  const pagingError = paging?.error;
  // 同樣的狀態就給同一個物件：viewer 的頁尾不必因為 App 重繪而跟著重算
  const history = useMemo<HistoryState | undefined>(
    () => (canPage ? { more, loading, ...(pagingError ? { error: pagingError } : {}) } : undefined),
    [canPage, more, loading, pagingError],
  );

  let state: ViewerState;
  if (layout) {
    state = {
      kind: 'ready',
      layout,
      refreshing: source.kind === 'github' && gh.refreshing,
      refreshError: (source.kind === 'github' && gh.refreshError) || undefined,
    };
  } else if (source.kind === 'local') {
    // 'local_git' 不在 i18n 錯誤表內，viewer 會直接顯示 message
    const message =
      local.missing === 'unknown'
        ? t.localUnknown
        : local.missing === LOCAL_ONLY
          ? t.localOnly
          : localSnap
            ? ((localSnap.code && t.snapshotErrors[localSnap.code]) ??
              localSnap.error ??
              t.localFailed)
            : local.missing === 'offline'
              ? t.localOffline
              : undefined;
    state = message ? { kind: 'error', code: 'local_git', message } : { kind: 'loading' };
  } else if (gh.remote.kind === 'error') {
    state = gh.remote;
  } else {
    state = { kind: 'loading' };
  }

  return {
    state,
    diagnostics,
    refresh:
      source.kind === 'github' ? gh.refresh : HAS_SERVER ? () => void local.refresh() : undefined,
    repoName: graph ? { owner: graph.repo.owner, name: graph.repo.name } : undefined,
    loadMore: canPage ? (source.kind === 'github' ? gh.loadMore : local.loadMore) : undefined,
    history,
  };
}
