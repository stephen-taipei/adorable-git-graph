import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import type { LayoutData } from './useViewerLayout';

/** branch 最新 commit 所在的列；branch 不存在或 tip 不在圖上時是 undefined。 */
export function branchTipRow(
  layout: Pick<GraphLayout, 'branches'>,
  bySha: ReadonlyMap<string, Pick<GraphNode, 'row'>> | undefined,
  name: string,
): number | undefined {
  const tip = layout.branches.find((b) => b.name === name)?.sha;
  return tip ? bySha?.get(tip)?.row : undefined;
}

export interface BranchFocusState {
  focusBranch: string | null;
  setFocusBranch: Dispatch<SetStateAction<string | null>>;
  /** 聚焦的 branch 可到達的 commit；沒有聚焦時是 null。 */
  branchSet: ReadonlySet<string> | null;
  /** 工具列切換聚焦：聚焦到某條 branch 時把它的 tip 捲到中間。 */
  onFocusBranch: (name: string | null) => void;
}

/** branch 聚焦（只亮某條 branch 可到達的 commit）。 */
export function useBranchFocus(
  layout: GraphLayout | null,
  derived: LayoutData | null,
  scrollToRow: (row: number, how: 'nearest' | 'center') => void,
): BranchFocusState {
  const [focusBranch, setFocusBranch] = useState<string | null>(null);
  const branchSet = useMemo(
    () => (focusBranch && derived ? (derived.reach.get(focusBranch) ?? null) : null),
    [focusBranch, derived],
  );
  const onFocusBranch = useCallback(
    (name: string | null) => {
      setFocusBranch(name);
      if (!name || !layout) return;
      const row = branchTipRow(layout, derived?.bySha, name);
      if (row !== undefined) scrollToRow(row, 'center');
    },
    [layout, derived, scrollToRow],
  );
  return { focusBranch, setFocusBranch, branchSet, onFocusBranch };
}
