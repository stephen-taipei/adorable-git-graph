import { useMemo, useRef } from 'react';
import { aheadCount, buildReachability, computeStats, recolorLayout } from '@adorable/graph-core';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import type { ThemeAppearance } from '../themes/config';
import { isAppendOnly } from './history';

/** 由 layout 衍生、整張圖共用的資料（統計、可到達性、ahead 數）。 */
export interface LayoutData {
  bySha: Map<string, GraphNode>;
  reach: ReturnType<typeof buildReachability>;
  stats: ReturnType<typeof computeStats>;
  defaultName: string | undefined;
  /** 每條非預設 branch 比預設 branch 多幾筆；只有讀到完整歷史時才算（否則數字不可信）。 */
  ahead: Map<string, number>;
  /** 每條 branch 可到達（已載入）的 commit 數。 */
  commitsOn: Map<string, number>;
}

export function deriveLayoutData(layout: GraphLayout): LayoutData {
  const bySha = new Map(layout.nodes.map((n) => [n.sha, n]));
  const reach = buildReachability(layout);
  const defaultName = layout.branches.find((b) => b.isDefault)?.name;
  const ahead = new Map<string, number>();
  const commitsOn = new Map<string, number>();
  for (const b of layout.branches) {
    commitsOn.set(b.name, reach.get(b.name)?.size ?? 0);
    if (layout.coverage?.commits.status === 'complete' && defaultName && b.name !== defaultName)
      ahead.set(b.name, aheadCount(reach, b.name, defaultName));
  }
  return { bySha, reach, stats: computeStats(layout), defaultName, ahead, commitsOn };
}

/** 相對時間的「現在」與它對應的 layout。 */
export interface RelativeNow {
  layout: GraphLayout | null;
  now: number;
}

/**
 * 相對時間的「現在」：每次拿到新資料（重新整理、剛 commit）就更新；
 * 只是在後面接上更早的歷史時沿用，既有的幾千列不用因為 now 變了而整批重繪。
 * 同一個 layout 直接回傳 previous（同一個物件）。
 */
export function nextRelativeNow(
  previous: RelativeNow | null,
  layout: GraphLayout | null,
  now: number,
): RelativeNow {
  if (previous && previous.layout === layout) return previous;
  const keep = previous && isAppendOnly(previous.layout, layout);
  return { layout, now: keep ? previous.now : now };
}

export interface ViewerLayout {
  /** 套上主題配色的 layout；還沒有圖時是 null。 */
  layout: GraphLayout | null;
  derived: LayoutData | null;
  hasRows: boolean;
  /** 相對時間的基準（見 nextRelativeNow）。 */
  now: number;
}

/** viewer 要畫的 layout（換主題配色）與由它衍生的資料。 */
export function useViewerLayout(
  sourceLayout: GraphLayout | null,
  appearance: ThemeAppearance,
): ViewerLayout {
  const layout = useMemo(
    () => (sourceLayout ? recolorLayout(sourceLayout, appearance.palette) : null),
    [sourceLayout, appearance],
  );
  const derived = useMemo(() => (layout ? deriveLayoutData(layout) : null), [layout]);
  const nowRef = useRef<RelativeNow | null>(null);
  // 在 render 中更新 ref：與 layout 同一次 render 就決定好，列與詳情面板拿到的是同一個 now
  nowRef.current = nextRelativeNow(nowRef.current, layout, Date.now());
  return {
    layout,
    derived,
    hasRows: Boolean(layout && layout.nodes.length > 0),
    now: nowRef.current.now,
  };
}
