import { describe, expect, it } from 'vitest';
import { buildLayout } from '@adorable/graph-core';
import type { CommitInput } from '@adorable/graph-core';
import {
  commitByPrefix,
  diagnosticsContextKey,
  isSameFocusContext,
  restoreFocus,
} from './viewerSession.ts';

const sha = (c: string) => c.repeat(40);
const commit = (s: string, parents: string[], hour: number): CommitInput => ({
  sha: s,
  parents,
  message: s,
  authorName: 'Ada',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});
const layout = buildLayout({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits: [
    commit(sha('c'), [sha('b')], 3),
    commit(sha('b'), [sha('a')], 2),
    commit(sha('a'), [], 1),
  ],
  refs: [{ name: 'main', sha: sha('c'), kind: 'branch', isDefault: true }],
  truncated: false,
});
const rowOf = (s: string) => layout.nodes.find((n) => n.sha === s)!.row;

describe('diagnosticsContextKey / commitByPrefix', () => {
  it('identifies the source + context and resolves short shas', () => {
    expect(diagnosticsContextKey(undefined, undefined)).toBe('["",null,null]');
    expect(diagnosticsContextKey('github', { commit: 'bbb' })).toBe('["github","bbb",null]');
    expect(commitByPrefix(layout.nodes, 'bbbb')).toBe(sha('b'));
    expect(commitByPrefix(layout.nodes, 'ffff')).toBeNull();
  });
});

describe('isSameFocusContext', () => {
  const base = {
    contextNavigated: false,
    viewerStateKey: undefined,
    contextKey: 'k',
    hasContext: true,
  };
  it('requires the same context key and viewer state key', () => {
    expect(isSameFocusContext({ ...base, saved: { contextKey: 'k' } })).toBe(true);
    expect(isSameFocusContext({ ...base, saved: { contextKey: 'other' } })).toBe(false);
    expect(isSameFocusContext({ ...base, saved: {} })).toBe(false);
    expect(isSameFocusContext({ ...base, viewerStateKey: 'v', saved: { contextKey: 'k' } })).toBe(
      false,
    );
    expect(
      isSameFocusContext({
        ...base,
        viewerStateKey: 'v',
        saved: { contextKey: 'k', viewerStateKey: 'v' },
      }),
    ).toBe(true);
  });
  it('accepts data saved without a context key when there is no context', () => {
    expect(isSameFocusContext({ ...base, hasContext: false, saved: {} })).toBe(true);
  });
  it('never restores right after navigating to a context', () => {
    expect(
      isSameFocusContext({ ...base, contextNavigated: true, saved: { contextKey: 'k' } }),
    ).toBe(false);
  });
});

describe('restoreFocus', () => {
  it('starts over from an empty record (selecting the context commit)', () => {
    expect(restoreFocus({}, false, layout, undefined)).toEqual({
      anchorRow: null,
      selected: null,
      branch: null,
      query: '',
    });
    expect(restoreFocus({}, false, layout, 'bbb').selected).toBe(sha('b'));
  });

  it('restores selection, branch, query and scroll anchor that still exist', () => {
    const r = restoreFocus(
      { selected: sha('a'), branch: 'main', query: 'fix', anchor: sha('b'), frac: 0.5 },
      true,
      layout,
      'ccc',
    );
    expect(r).toEqual({
      anchorRow: rowOf(sha('b')) + 0.5,
      selected: sha('a'),
      branch: 'main',
      query: 'fix',
    });
  });

  it('drops what is gone and keeps an explicit deselect in the same context', () => {
    const gone = restoreFocus(
      { selected: sha('f'), branch: 'gone', anchor: sha('f'), query: 3 as unknown as string },
      true,
      layout,
      'ccc',
    );
    expect(gone).toEqual({ anchorRow: null, selected: sha('c'), branch: null, query: '' });
    expect(restoreFocus({ selected: null }, true, layout, 'ccc').selected).toBeNull();
    expect(restoreFocus({ selected: null }, false, layout, 'ccc').selected).toBe(sha('c'));
  });
});
