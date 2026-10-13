import { useEffect, useMemo, useRef } from 'react';
import { buildLayout } from '@adorable/graph-core';
import type { GraphData, GraphLayout, LayoutOptions } from '@adorable/graph-core';

/** 上一次排版的結果與它屬於哪個來源 + repo。 */
export interface PreviousLayout {
  key: string;
  layout: GraphLayout;
}

/**
 * 排版；`previous` 是同一個 `key`（來源 + repo）的上一張圖時，用它的順序當 previousOrder：
 * 已經顯示的列維持相對順序，往回載入的更早歷史接在最後面（不會照日期插進使用者正在看的列之間）。
 * key 不同（換了 repo / 來源）就重新排，不沿用別的 repo 的順序。
 */
export function layoutAfter(
  previous: PreviousLayout | null,
  graph: GraphData,
  key: string,
  options: LayoutOptions = {},
): GraphLayout {
  return buildLayout(graph, {
    ...options,
    previousOrder: previous && previous.key === key ? previous.layout.nodes.map((n) => n.sha) : [],
  });
}

/**
 * `buildLayout` 的 React 版本，給使用端（web app / extension）取代 `useMemo(() => buildLayout(graph), [graph])`：
 * 同一個 `key` 的下一張圖（infinite scroll 接上更早的歷史、重新整理、剛 commit）都以上一張的順序為準（見 layoutAfter）。
 * 上一張記在 ref 裡、畫面確定後才更新，所以中間經過 loading（graph 是 null）也還記得；StrictMode 重跑結果相同。
 */
export function useStableLayout(
  graph: GraphData | null,
  key: string,
  options: LayoutOptions = {},
): GraphLayout | null {
  const previous = useRef<PreviousLayout | null>(null);
  const { maxCommits } = options;
  const layout = useMemo(
    () =>
      graph
        ? layoutAfter(previous.current, graph, key, maxCommits === undefined ? {} : { maxCommits })
        : null,
    [graph, key, maxCommits],
  );
  useEffect(() => {
    if (layout) previous.current = { key, layout };
  }, [layout, key]);
  return layout;
}
