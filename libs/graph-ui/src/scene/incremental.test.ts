import { describe, expect, it } from 'vitest';
import { appendCommits, buildLayout, missingParents } from '@adorable/graph-core';
import type { CommitInput, GraphData, GraphLayout } from '@adorable/graph-core';
import { spawnOrder } from './incremental.ts';

const commit = (sha: string, parents: string[], hour: number): CommitInput => ({
  sha,
  parents,
  message: sha,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

const shas = (l: GraphLayout) => l.nodes.map((n) => n.sha);
const all = (l: GraphLayout) => ({ first: 0, last: l.nodes.length - 1 });

// main 很活躍（每小時一個 commit），feature 很少動：GitHub 每條 branch 各抓一頁時，
// feature 的一頁涵蓋了很長一段時間，main 的下一頁照日期會排在 feature 已經載入的列之間
const history = [
  ...Array.from({ length: 12 }, (_, i) => commit(`m${i}`, [i ? `m${i - 1}` : 'r'], 100 + i)),
  ...[5, 30, 60, 90, 111.5].map((h, i) => commit(`f${i}`, [i ? `f${i - 1}` : 'r'], h)),
  commit('r', [], 0),
];
const bySha = new Map(history.map((c) => [c.sha, c]));
/** GitHub 的 `/commits?sha=<sha>&per_page=<n>`：那個 commit 與它的祖先，日期新→舊取前 n 筆。 */
function page(sha: string, n: number): CommitInput[] {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (seen.has(s) || !bySha.has(s)) continue;
    seen.add(s);
    stack.push(...bySha.get(s)!.parents);
  }
  return [...seen]
    .map((s) => bySha.get(s)!)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, n);
}
const first: GraphData = {
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits: [...page('m11', 3), ...page('f4', 3)],
  refs: [
    { name: 'main', sha: 'm11', kind: 'branch', isDefault: true },
    { name: 'feature', sha: 'f4', kind: 'branch' },
  ],
  truncated: true,
};
const nextBatch = (g: GraphData) =>
  appendCommits(
    g,
    missingParents(g).flatMap((s) => page(s, 3)),
  );

describe('spawnOrder (which commits pop in on an incremental update)', () => {
  it('does not pop in older history that the date order put between the loaded rows', () => {
    const l1 = buildLayout(first);
    const l2 = buildLayout(nextBatch(first));
    const previous = new Set(shas(l1));
    // sanity：沒有 previousOrder 的排版確實把 main 的舊 commit 插在已載入的列之間（舊的作法會讓它們彈出來）
    const lastOld = Math.max(...l2.nodes.filter((n) => previous.has(n.sha)).map((n) => n.row));
    const interleaved = l2.nodes.filter((n) => !previous.has(n.sha) && n.row < lastOld);
    expect(interleaved.map((n) => n.sha)).toEqual(['m8', 'm7', 'm6']);
    expect(spawnOrder(previous, l2, all(l2))).toEqual([]);
  });

  it('does not pop in pages appended below the loaded rows (buildLayout previousOrder)', () => {
    const l1 = buildLayout(first);
    const g2 = nextBatch(first);
    const l2 = buildLayout(g2, { previousOrder: shas(l1) });
    expect(shas(l2).slice(0, l1.nodes.length)).toEqual(shas(l1));
    expect(spawnOrder(new Set(shas(l1)), l2, all(l2))).toEqual([]);
    const l3 = buildLayout(nextBatch(g2), { previousOrder: shas(l2) });
    expect(spawnOrder(new Set(shas(l2)), l3, all(l3))).toEqual([]);
  });

  it('pops in genuinely new commits near the view, oldest first', () => {
    const l1 = buildLayout(first);
    const g = {
      ...first,
      commits: [commit('n2', ['n1'], 130), commit('n1', ['m11'], 129), ...first.commits],
    };
    const l2 = buildLayout(g, { previousOrder: shas(l1) });
    expect(shas(l2).slice(0, 2)).toEqual(['n2', 'n1']);
    expect(spawnOrder(new Set(shas(l1)), l2, all(l2)).map((n) => n.sha)).toEqual(['n1', 'n2']);
    // 不在可視範圍附近（上下各 2 列）的立刻就位
    expect(spawnOrder(new Set(shas(l1)), l2, { first: 5, last: 6 })).toEqual([]);
  });

  it('separates a new commit from older history that arrived in the same update', () => {
    const l1 = buildLayout(first);
    const g = nextBatch(first);
    const both = { ...g, commits: [commit('n1', ['f4'], 140), ...g.commits] };
    const l2 = buildLayout(both);
    expect(spawnOrder(new Set(shas(l1)), l2, all(l2)).map((n) => n.sha)).toEqual(['n1']);
  });

  it('never pops in rows below the last loaded row, even when they are not connected', () => {
    const l1 = buildLayout(first);
    // 沒接到任何已載入 commit 的一段（例如保證顯示的 default branch 片段）
    const g = { ...first, commits: [...first.commits, commit('lone', [], 1)] };
    const l2 = buildLayout(g, { previousOrder: shas(l1) });
    expect(shas(l2).at(-1)).toBe('lone');
    expect(spawnOrder(new Set(shas(l1)), l2, all(l2))).toEqual([]);
  });
});
