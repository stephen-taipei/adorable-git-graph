import { describe, expect, it } from 'vitest';
import { appendCommits, buildLayout } from '@adorable/graph-core';
import type { CommitInput, GraphData, GraphLayout } from '@adorable/graph-core';
import { scopedValue } from './useSelection.ts';
import { deriveLayoutData, nextRelativeNow } from './useViewerLayout.ts';

const commit = (sha: string, parents: string[], hour: number): CommitInput => ({
  sha,
  parents,
  message: sha,
  authorName: 'Ada',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

const data: GraphData = {
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits: [
    commit('f2', ['f1'], 5),
    commit('m2', ['m1'], 4),
    commit('f1', ['m1'], 3),
    commit('m1', ['m0'], 2),
  ],
  refs: [
    { name: 'main', sha: 'm2', kind: 'branch', isDefault: true },
    { name: 'feature', sha: 'f2', kind: 'branch' },
  ],
  truncated: true,
};
const layout = buildLayout(data);
const complete = (l: GraphLayout) =>
  ({ ...l, coverage: { ...l.coverage, commits: { status: 'complete' } } }) as GraphLayout;

describe('deriveLayoutData', () => {
  it('indexes nodes and counts commits per branch', () => {
    const d = deriveLayoutData(layout);
    expect([...d.bySha.keys()].sort()).toEqual(['f1', 'f2', 'm1', 'm2']);
    expect(d.defaultName).toBe('main');
    expect(d.commitsOn.get('main')).toBe(2);
    expect(d.commitsOn.get('feature')).toBe(3);
    expect(d.stats.commits).toBe(4);
  });

  it('only reports ahead counts when the whole history is loaded', () => {
    expect(deriveLayoutData(layout).ahead.size).toBe(0);
    const d = deriveLayoutData(complete(layout));
    expect(d.ahead.get('feature')).toBe(2);
    expect(d.ahead.has('main')).toBe(false);
  });
});

describe('nextRelativeNow', () => {
  it('keeps "now" for the same layout and for older history appended below', () => {
    const first = nextRelativeNow(null, layout, 100);
    expect(first).toEqual({ layout, now: 100 });
    expect(nextRelativeNow(first, layout, 200)).toBe(first);
    const older = buildLayout(appendCommits(data, [commit('m0', [], 1)]), {
      previousOrder: layout.nodes.map((n) => n.sha),
    });
    expect(nextRelativeNow(first, older, 300)).toEqual({ layout: older, now: 100 });
  });

  it('moves "now" for fresh data or no data', () => {
    const first = nextRelativeNow(null, layout, 100);
    const refreshed = buildLayout({ ...data, commits: [commit('m3', ['m2'], 6), ...data.commits] });
    expect(nextRelativeNow(first, refreshed, 200).now).toBe(200);
    expect(nextRelativeNow(first, null, 300)).toEqual({ layout: null, now: 300 });
  });
});

describe('scopedValue (useSelection)', () => {
  it('reads the value only while the scope is current', () => {
    const scope = {};
    expect(scopedValue({ scope, value: 'a' }, scope, null)).toBe('a');
    expect(scopedValue({ scope, value: 'a' }, {}, null)).toBeNull();
  });
});
