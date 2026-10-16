import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { matchesQuery } from '@adorable/graph-core';
import type { GraphNode } from '@adorable/graph-core';

/** 兩個集合的交集；null 代表「不限制」。 */
export function intersect(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (!a) return b;
  if (!b) return a;
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

/**
 * 符合搜尋的 commit（依列的順序）；沒有搜尋字串時是 null。
 * 只算「沒被 branch 聚焦淡化掉」的列：計數、上一筆 / 下一筆、淡化三者一致。
 */
export function searchMatches(
  nodes: readonly GraphNode[],
  query: string,
  branchSet: ReadonlySet<string> | null,
): string[] | null {
  if (!query.trim()) return null;
  return nodes
    .filter((n) => matchesQuery(n, query) && (!branchSet || branchSet.has(n.sha)))
    .map((n) => n.sha);
}

/** 上一筆 / 下一筆之後的游標（循環）；第一次按「上一筆」從最後一筆開始。total 必須大於 0。 */
export function stepMatchCursor(cursor: number, dir: 1 | -1, total: number): number {
  if (cursor === -1 && dir === -1) return total - 1;
  return (cursor + dir + total) % total;
}

export interface SearchState {
  query: string;
  /** 直接改搜尋字串（不重設游標）。 */
  setQuery: Dispatch<SetStateAction<string>>;
  /** 使用者輸入新的搜尋：游標回到「還沒跳過」。 */
  onQuery: (query: string) => void;
  /** 目前跳到第幾筆結果（-1：還沒跳過）。 */
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  matchShas: string[] | null;
  /** 不淡化的列：搜尋結果與 branch 聚焦的交集；兩者都沒有時是 null。 */
  active: ReadonlySet<string> | null;
  /** 跳到上一筆 / 下一筆結果。 */
  stepMatch: (dir: 1 | -1) => void;
}

/** 搜尋（與 branch 聚焦一起決定哪些列要淡化）。 */
export function useSearch(
  nodes: readonly GraphNode[] | undefined,
  branchSet: ReadonlySet<string> | null,
  select: (sha: string, how: 'center') => void,
): SearchState {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(-1);
  const matchShas = useMemo(
    () => (nodes ? searchMatches(nodes, query, branchSet) : null),
    [nodes, query, branchSet],
  );
  const matchSet = useMemo(() => (matchShas ? new Set(matchShas) : null), [matchShas]);
  const active = useMemo(() => intersect(matchSet, branchSet), [matchSet, branchSet]);

  const onQuery = useCallback((q: string) => {
    setQuery(q);
    setCursor(-1);
  }, []);

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (!matchShas || matchShas.length === 0) return;
      const idx = stepMatchCursor(cursor, dir, matchShas.length);
      setCursor(idx);
      select(matchShas[idx]!, 'center');
    },
    [matchShas, cursor, select],
  );

  return { query, setQuery, onQuery, cursor, setCursor, matchShas, active, stepMatch };
}
