import type { DiagnosticAdapter, GraphLayout, GraphNode } from '@adorable/graph-core';

/**
 * sessionStorage（`agg:focus:<來源|標題>`）裡記下的檢視位置：重新整理後恢復選取、branch 聚焦、搜尋與捲動位置。
 * `selected: null` 代表使用者明確取消了選取（不要再自動選 context 的 commit）。
 */
export interface SavedFocus {
  selected?: string | null;
  contextKey?: string;
  viewerStateKey?: string;
  branch?: string | null;
  query?: string;
  anchor?: string;
  frac?: number;
}

export const focusStorageKey = (identity: string) => `agg:focus:${identity}`;

export function readSavedFocus(identity: string): SavedFocus {
  try {
    return JSON.parse(sessionStorage.getItem(focusStorageKey(identity)) ?? '{}');
  } catch {
    /* storage is optional */
    return {};
  }
}

export function writeSavedFocus(identity: string, focus: SavedFocus): void {
  try {
    sessionStorage.setItem(focusStorageKey(identity), JSON.stringify(focus));
  } catch {
    /* optional preference storage */
  }
}

/** 診斷 context（帶著哪個 commit / PR 開啟）與來源的識別：變了就要重新導覽到 context。 */
export const diagnosticsContextKey = (
  sourceKey: string | undefined,
  context: DiagnosticAdapter['context'],
) => JSON.stringify([sourceKey ?? '', context?.commit ?? null, context?.pullRequest ?? null]);

/** 以 sha 開頭（context 可能給短 sha）找 commit；找不到是 null。 */
export const commitByPrefix = (nodes: readonly GraphNode[], prefix: string): string | null =>
  nodes.find((n) => n.sha.startsWith(prefix))?.sha ?? null;

/**
 * 存下的位置是不是同一個檢視情境：沒有剛被 context 導覽過、同一個 viewerStateKey、同一個 context
 * （沒有 context 時，舊版沒存 contextKey 的資料也算）。
 */
export function isSameFocusContext({
  saved,
  contextNavigated,
  viewerStateKey,
  contextKey,
  hasContext,
}: {
  saved: SavedFocus;
  contextNavigated: boolean;
  viewerStateKey: string | undefined;
  contextKey: string;
  hasContext: boolean;
}): boolean {
  return (
    !contextNavigated &&
    (viewerStateKey === undefined || saved.viewerStateKey === viewerStateKey) &&
    (saved.contextKey === contextKey || (!hasContext && saved.contextKey === undefined))
  );
}

/** 從存下的位置恢復的檢視（saved 已經是 {} 代表從頭看）。 */
export interface RestoredFocus {
  /** 存下的捲動位置換算成列號（含列內的比例）；存下的那一列已經不在圖上時是 null（從頭看）。 */
  anchorRow: number | null;
  selected: string | null;
  branch: string | null;
  query: string;
}

/**
 * 換了 repo / 來源後第一次有圖時要恢復成什麼樣子。
 * 選取：同一個情境且使用者明確取消過 → 不選；存下的 commit 還在 → 選它；否則選 context 的 commit。
 */
export function restoreFocus(
  saved: SavedFocus,
  sameContext: boolean,
  layout: Pick<GraphLayout, 'nodes' | 'branches'>,
  contextCommit: string | undefined,
): RestoredFocus {
  const anchor = saved.anchor ? layout.nodes.find((n) => n.sha === saved.anchor) : undefined;
  return {
    anchorRow: anchor ? anchor.row + (saved.frac ?? 0) : null,
    selected:
      sameContext && saved.selected === null
        ? null
        : saved.selected && layout.nodes.some((n) => n.sha === saved.selected)
          ? saved.selected
          : contextCommit
            ? commitByPrefix(layout.nodes, contextCommit)
            : null,
    branch:
      saved.branch && layout.branches.some((b) => b.name === saved.branch) ? saved.branch : null,
    query: typeof saved.query === 'string' ? saved.query : '',
  };
}
