import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLayout } from '@adorable/graph-core';
import type { DiagnosticAdapter, GraphData } from '@adorable/graph-core';
import { createExtensionAdapter } from './diagnostics';
import type { ViewerState } from '@adorable/graph-ui';
import { sendToBackground } from '../shared/messages';
import type { FetchGraphResponse } from '../shared/messages';
import type { RepoRef } from '../shared/repo';

type Fetched =
  | { kind: 'loading' }
  | { kind: 'error'; sourceIdentity: string; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; sourceIdentity: string; graph: GraphData; diagnosticGeneration: string };

/** 向 background 取得 repo 的 git 歷史，並轉成 viewer 要用的 state。 */
export function useGraph(
  repo: RepoRef,
  epoch = 0,
): { state: ViewerState; refresh: () => void; diagnostics: DiagnosticAdapter } {
  const [fetched, setFetched] = useState<Fetched>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ code: string; message?: string } | null>(null);
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

  useEffect(() => {
    let alive = true;
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
        if (res?.ok)
          setFetched({
            kind: 'ready',
            sourceIdentity,
            graph: res.data.graph,
            diagnosticGeneration: res.data.diagnosticGeneration,
          });
        else fail(res?.error ?? { code: 'unknown' });
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
  }, [repo.owner, repo.repo, repo.branchHint, epoch, nonce, sourceIdentity]);

  const generation = current.kind === 'ready' ? current.diagnosticGeneration : undefined;
  const diagnostics = useMemo(
    () => createExtensionAdapter(repo, generation),
    [repo.owner, repo.repo, repo.commit, repo.pullRequest, generation],
  );

  const layout = useMemo(
    () => (current.kind === 'ready' ? buildLayout(current.graph) : null),
    [current],
  );

  const state: ViewerState = layout
    ? { kind: 'ready', layout, refreshing, refreshError: refreshError ?? undefined }
    : current.kind === 'ready'
      ? { kind: 'loading' }
      : current;

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { state, refresh, diagnostics };
}
