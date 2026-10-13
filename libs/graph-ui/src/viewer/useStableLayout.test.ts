import { describe, expect, it } from 'vitest';
import { appendCommits } from '@adorable/graph-core';
import type { CommitInput, GraphData, GraphLayout } from '@adorable/graph-core';
import { layoutAfter } from './useStableLayout.ts';

const commit = (sha: string, parents: string[], hour: number): CommitInput => ({
  sha,
  parents,
  message: sha,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});
const shas = (l: GraphLayout) => l.nodes.map((n) => n.sha);

// main：每小時一筆（m3…m1 已載入，m0 是下一頁）；feature 很少動，一頁就載到很舊的 f0
const first: GraphData = {
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits: [
    commit('m3', ['m2'], 103),
    commit('m2', ['m1'], 102),
    commit('m1', ['m0'], 101),
    commit('f1', ['f0'], 102.5),
    commit('f0', ['r'], 10),
  ],
  refs: [{ name: 'main', sha: 'm3', kind: 'branch', isDefault: true }],
  truncated: true,
};
const older = appendCommits(first, [commit('m0', ['r'], 100), commit('r', [], 0)]);

describe('layoutAfter (useStableLayout)', () => {
  it('keeps the previous order for the same source + repo', () => {
    const l1 = layoutAfter(null, first, 'github|o/r');
    expect(shas(l1)).toEqual(['m3', 'f1', 'm2', 'm1', 'f0']);
    const l2 = layoutAfter({ key: 'github|o/r', layout: l1 }, older, 'github|o/r');
    // m0 照日期會排在 f0 上面；沿用上一次的順序時接在最後面
    expect(shas(l2)).toEqual(['m3', 'f1', 'm2', 'm1', 'f0', 'm0', 'r']);
  });

  it('starts over for another repo / source and passes the layout options through', () => {
    const l1 = layoutAfter(null, first, 'github|o/r');
    const other = layoutAfter({ key: 'local|x', layout: l1 }, older, 'github|o/r');
    expect(shas(other)).toEqual(['m3', 'f1', 'm2', 'm1', 'm0', 'f0', 'r']);
    expect(layoutAfter(null, older, 'k', { maxCommits: 3 }).nodes).toHaveLength(3);
  });
});
