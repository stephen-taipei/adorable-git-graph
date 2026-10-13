import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiagnosticAdapter, GraphData } from '@adorable/graph-core';
import { createExtensionAdapter } from './diagnostics';
import { useStableLayout } from '@adorable/graph-ui';
import type { HistoryState, ViewerState } from '@adorable/graph-ui';
import { historyErrorCode, mergeBatch, nextStarts } from '../shared/history';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT, sendToBackground } from '../shared/messages';
import type { FetchGraphResponse, FetchMoreResponse } from '../shared/messages';
import type { RepoRef } from '../shared/repo';

type Fetched =
  | { kind: 'loading' }
  | { kind: 'error'; sourceIdentity: string; code: string; message?: string; resetAt?: number }
  | {
      kind: 'ready';
      sourceIdentity: string;
      graph: GraphData;
      diagnosticGeneration: string;
      /** GitHub 已經不認得、不再往回抓的 missing parent（見 mergeOlder）。 */
      dead: ReadonlySet<string>;
    };

const NO_DEAD: ReadonlySet<string> = new Set();
/**
 * 排版時保留的 commit 上限：一批最多 FETCH_MORE_MAX_STARTS × 100 筆，所以就算在 HISTORY_LIMIT 附近又載入一批，
 * buildLayout 也不會把中間的 commit 截掉（預設的 400 筆會讓往回載入的 commit 全被裁掉）。
 */
const LAYOUT_MAX_COMMITS = HISTORY_LIMIT + FETCH_MORE_MAX_STARTS * 100;

export interface UseGraph {
  state: ViewerState;
  refresh: () => void;
  diagnostics: DiagnosticAdapter;
  diagnosticGeneration?: string;
  /** infinite scroll：從目前的 missing parent 往回再載入一批（已在載入中 / 沒有更多時什麼都不做）。 */
  loadMore: () => void;
  /** 給 GitGraphViewer 的 `history`（圖還沒好時是 undefined）。 */
  history: HistoryState | undefined;
}

/** 向 background 取得 repo 的 git 歷史，並轉成 viewer 要用的 state。 */
export function useGraph(repo: RepoRef, epoch = 0): UseGraph {
  const [fetched, setFetched] = useState<Fetched>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ code: string; message?: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const hintRef = useRef(repo.branchHint);
  hintRef.current = repo.branchHint;
  const force = useRef(false);
  const sourceIdentity = JSON.stringify([
    repo.owner.toLowerCase(),
    repo.repo.toLowerCase(),
    repo.branchHint ?? '',
    epoch,
  ]);
  const current =
    fetched.kind === 'loading' || fetched.sourceIdentity === sourceIdentity
      ? fetched
      : ({ kind: 'loading' } as const);
  // 每次（重新）抓第一批、以及第一批回來換掉圖的時候都換一代：上一代還沒回來的「更早的歷史」結果直接丟掉
  // （不會併進別的 repo / 新抓的圖）。loadMore 另外還會比對圖本身（見 mergeBatch）。
  const moreEpoch = useRef(0);
  const loadingMoreRef = useRef(false);

  /** 作廢還在路上的「更早的歷史」請求（它的結果會被丟掉），頁尾回到可以載入的狀態。 */
  const resetMore = useCallback(() => {
    moreEpoch.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setMoreError(undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    resetMore();
    // 使用者按「重新整理」且已經有這個 repo 的圖：留著舊圖（捲動位置、選取、詳情都不動），背景重抓；
    // 換 repo 或第一次載入才回到 loading（絕不顯示別的 repo 的舊圖）。
    const forced =
      force.current &&
      fetchedRef.current.kind === 'ready' &&
      fetchedRef.current.sourceIdentity === sourceIdentity;
    force.current = false;
    setFetched((prev) =>
      forced && prev.kind === 'ready' && prev.sourceIdentity === sourceIdentity
        ? prev
        : { kind: 'loading' },
    );
    setRefreshing(forced);
    setRefreshError(null);
    // 背景重新抓取失敗時保留原本的圖，只回報錯誤（不要讓使用者的捲動位置與選取跟著消失）
    const fail = (err: { code: string; message?: string; resetAt?: number }) => {
      if (
        forced &&
        fetchedRef.current.kind === 'ready' &&
        fetchedRef.current.sourceIdentity === sourceIdentity
      )
        setRefreshError(err);
      else setFetched({ kind: 'error', sourceIdentity, ...err });
    };
    sendToBackground<FetchGraphResponse>({
      type: 'fetch-graph',
      owner: repo.owner,
      repo: repo.repo,
      branchHint: hintRef.current,
      force: forced,
    })
      .then((res) => {
        if (!alive) return;
        setRefreshing(false);
        // 重新整理 = 回到第一批（之前往回載入的更早歷史不保留）。背景重新整理時使用者可能在這段時間內又捲到底、
        // 從舊圖的 missing parent 開始載入更早的歷史：圖換掉了，那批作廢（不能併進新的第一批），頁尾立刻可以重新載入
        if (res?.ok) {
          resetMore();
          setFetched({
            kind: 'ready',
            sourceIdentity,
            graph: res.data.graph,
            diagnosticGeneration: res.data.diagnosticGeneration,
            dead: NO_DEAD,
          });
        } else fail(res?.error ?? { code: 'unknown' });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setRefreshing(false);
        // 例如 extension 剛更新、舊 content script 失去 background 連線
        fail({ code: 'unknown', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
  }, [repo.owner, repo.repo, repo.branchHint, epoch, nonce, sourceIdentity, resetMore]);

  const generation = current.kind === 'ready' ? current.diagnosticGeneration : undefined;
  const diagnostics = useMemo(
    () => createExtensionAdapter(repo, generation),
    [repo.owner, repo.repo, repo.commit, repo.pullRequest, generation],
  );

  // 同一個來源的下一張圖（往回載入更早的歷史、重新整理）沿用上一張的列順序：已經顯示的列不會因為另一條 branch
  // 的舊 commit 依日期插進來而移動，更早的歷史接在最後面（見 graph-ui 的 useStableLayout / graph-core 的 previousOrder）
  const layout = useStableLayout(current.kind === 'ready' ? current.graph : null, sourceIdentity, {
    maxCommits: LAYOUT_MAX_COMMITS,
  });

  const hasMore = useMemo(
    () => current.kind === 'ready' && nextStarts(current.graph, current.dead).length > 0,
    [current],
  );

  const state: ViewerState = layout
    ? { kind: 'ready', layout, refreshing, refreshError: refreshError ?? undefined }
    : current.kind === 'ready'
      ? { kind: 'loading' }
      : current;

  const history = useMemo<HistoryState | undefined>(
    () => (layout ? { more: hasMore, loading: loadingMore, error: moreError } : undefined),
    [layout, hasMore, loadingMore, moreError],
  );

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  const loadMore = useCallback(() => {
    const cur = fetchedRef.current;
    if (cur.kind !== 'ready' || loadingMoreRef.current) return;
    const shas = nextStarts(cur.graph, cur.dead);
    if (shas.length === 0) return;
    const gen = moreEpoch.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(undefined);
    const done = (error?: string) => {
      if (moreEpoch.current !== gen) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setMoreError(error);
    };
    sendToBackground<FetchMoreResponse>({
      type: 'fetch-more',
      owner: repo.owner,
      repo: repo.repo,
      shas,
      generation: cur.diagnosticGeneration,
    })
      .then((res) => {
        if (moreEpoch.current !== gen) return;
        // 送出之後圖被換掉了：這批（成功或失敗）都屬於舊圖，丟掉
        const now = fetchedRef.current;
        if (now.kind !== 'ready' || now.graph !== cur.graph) return done();
        // history.error 給錯誤代碼：viewer 會翻譯，並加上「更早的歷史載入失敗」的前綴
        if (!res?.ok) return done(historyErrorCode(res?.error?.code));
        setFetched((prev) => {
          // 在 updater 裡再比一次：真正決定併進哪張圖的是這裡（ref 可能還沒跟上同一批 render 裡的更新）
          if (prev.kind !== 'ready') return prev;
          const next = mergeBatch(prev, cur.graph, shas, res.data.commits);
          return next === null || next === prev ? prev : { ...prev, ...next };
        });
        done();
      })
      .catch(() => done('unknown'));
  }, [repo.owner, repo.repo]);

  return { state, refresh, diagnostics, diagnosticGeneration: generation, loadMore, history };
}
