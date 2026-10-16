import { describe, expect, it } from 'vitest';
import { buildLayout } from '@adorable/graph-core';
import type { CommitInput } from '@adorable/graph-core';
import { branchTipRow } from './useBranchFocus.ts';
import { intersect, searchMatches, stepMatchCursor } from './useSearch.ts';

const commit = (sha: string, parents: string[], hour: number, message = sha): CommitInput => ({
  sha,
  parents,
  message,
  authorName: 'Ada',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

const layout = buildLayout({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits: [
    commit('m3', ['m2', 'f1'], 4, 'Merge feature'),
    commit('f1', ['m1'], 3, 'feat: add search'),
    commit('m2', ['m1'], 2, 'fix: search crash'),
    commit('m1', [], 1, 'init'),
  ],
  refs: [
    { name: 'main', sha: 'm3', kind: 'branch', isDefault: true },
    { name: 'feature', sha: 'f1', kind: 'branch' },
  ],
  truncated: false,
});
const bySha = new Map(layout.nodes.map((n) => [n.sha, n]));

describe('searchMatches', () => {
  it('returns null without a query and matches in row order', () => {
    expect(searchMatches(layout.nodes, '  ', null)).toBeNull();
    expect(searchMatches(layout.nodes, 'search', null)).toEqual(['f1', 'm2']);
    expect(searchMatches(layout.nodes, 'nothing here', null)).toEqual([]);
  });

  it('only counts rows the branch focus keeps', () => {
    expect(searchMatches(layout.nodes, 'search', new Set(['f1', 'm1']))).toEqual(['f1']);
  });
});

describe('stepMatchCursor', () => {
  it('wraps around and starts "previous" from the last match', () => {
    expect(stepMatchCursor(-1, 1, 3)).toBe(0);
    expect(stepMatchCursor(-1, -1, 3)).toBe(2);
    expect(stepMatchCursor(2, 1, 3)).toBe(0);
    expect(stepMatchCursor(0, -1, 3)).toBe(2);
    expect(stepMatchCursor(1, 1, 3)).toBe(2);
  });
});

describe('intersect', () => {
  it('treats null as "no restriction"', () => {
    const a = new Set(['x', 'y']);
    expect(intersect(null, null)).toBeNull();
    expect(intersect(a, null)).toBe(a);
    expect(intersect(null, a)).toBe(a);
    expect([...intersect(a, new Set(['y', 'z']))!]).toEqual(['y']);
  });
});

describe('branchTipRow', () => {
  it('finds the row of a branch tip', () => {
    expect(branchTipRow(layout, bySha, 'feature')).toBe(bySha.get('f1')!.row);
    expect(branchTipRow(layout, bySha, 'main')).toBe(bySha.get('m3')!.row);
    expect(branchTipRow(layout, bySha, 'gone')).toBeUndefined();
    expect(branchTipRow(layout, undefined, 'main')).toBeUndefined();
  });
});
