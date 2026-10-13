import { describe, expect, it } from 'vitest';
import type { CommitInput, GraphData } from '@adorable/graph-core';
import { historyErrorCode, mergeBatch, mergeOlder, nextStarts, parseFetchMore } from './history';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT } from './messages';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, parents: number[]): CommitInput => ({
  sha: sha(n),
  parents: parents.map(sha),
  message: `c${n}`,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
});
const graph = (commits: CommitInput[]): GraphData => ({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits,
  refs: [],
  truncated: true,
});

describe('parseFetchMore', () => {
  const ok = {
    type: 'fetch-more',
    owner: 'o',
    repo: 'r',
    shas: [sha(1), sha(2).toUpperCase()],
    generation: 'gen-1',
  };

  it('accepts a well-formed request and returns a clean copy', () => {
    const parsed = parseFetchMore({ ...ok, extra: 'x' });
    expect(parsed).toEqual(ok);
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed?.shas).not.toBe(ok.shas);
  });

  it('rejects bad repos, bad shas and too many starts', () => {
    const bad = [
      null,
      'fetch-more',
      { ...ok, type: 'fetch-graph' },
      { ...ok, owner: '../x' },
      { ...ok, repo: 'a/b' },
      { ...ok, owner: 1 },
      { ...ok, shas: [] },
      { ...ok, shas: 'abc' },
      { ...ok, shas: ['main'] },
      { ...ok, shas: [`${sha(1)}&per_page=100`] },
      { ...ok, shas: [sha(1).slice(1)] },
      { ...ok, shas: [42] },
      { ...ok, shas: Array.from({ length: FETCH_MORE_MAX_STARTS + 1 }, (_, i) => sha(i + 1)) },
      { ...ok, generation: undefined },
      { ...ok, generation: '' },
      { ...ok, generation: 7 },
      { ...ok, generation: 'x'.repeat(65) },
    ];
    for (const raw of bad) expect(parseFetchMore(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('nextStarts', () => {
  it('returns the missing parents minus the dead ones, capped', () => {
    // 10 ← 9（8 沒載入）；merge 20 的第二個 parent 15 也沒載入
    const g = graph([commit(20, [10, 15]), commit(10, [9]), commit(9, [8])]);
    expect(nextStarts(g, new Set())).toEqual([sha(15), sha(8)]);
    expect(nextStarts(g, new Set([sha(15)]))).toEqual([sha(8)]);
    expect(nextStarts(g, new Set([sha(15), sha(8)]))).toEqual([]);

    const wide = graph(Array.from({ length: 9 }, (_, i) => commit(100 + i, [i + 1])));
    expect(nextStarts(wide, new Set())).toHaveLength(FETCH_MORE_MAX_STARTS);
  });

  it('stops at the history limit and at the root', () => {
    expect(nextStarts(graph([commit(2, [1]), commit(1, [])]), new Set())).toEqual([]);
    const many = graph(Array.from({ length: HISTORY_LIMIT }, (_, i) => commit(i + 2, [i + 1])));
    expect(nextStarts(many, new Set())).toEqual([]);
  });
});

describe('mergeOlder', () => {
  it('appends the older commits and remembers starts that never came back', () => {
    const g = graph([commit(20, [10, 15]), commit(10, [9])]);
    // 9 的那一頁回來了，15 的沒有（GitHub 已經不認得）
    const r = mergeOlder(g, new Set(), [sha(9), sha(15)], [commit(9, [8]), commit(8, [])]);
    expect(r.graph.commits.map((c) => c.sha)).toEqual([20, 10, 9, 8].map(sha));
    expect([...r.dead]).toEqual([sha(15)]);
    expect(nextStarts(r.graph, r.dead)).toEqual([]);
    expect(r.graph.truncated).toBe(true); // 15 仍然缺：歷史確實是被截斷的
  });

  it('returns the same objects when nothing changed', () => {
    const g = graph([commit(10, [9])]);
    const dead = new Set([sha(9)]);
    const r = mergeOlder(g, dead, [sha(9)], []);
    expect(r.graph).toBe(g);
    expect(r.dead).toBe(dead);
  });
});

describe('mergeBatch', () => {
  it('merges a batch that was requested from the current graph', () => {
    const g = graph([commit(20, [10]), commit(10, [9])]);
    const cur = { kind: 'ready' as const, graph: g, dead: new Set<string>() };
    const r = mergeBatch(cur, g, [sha(9)], [commit(9, [8])]);
    expect(r).not.toBeNull();
    expect(r!.graph.commits.map((c) => c.sha)).toEqual([20, 10, 9].map(sha));
    // 沒有任何變化時回傳原本的物件
    expect(mergeBatch(cur, g, [], [])).toBe(cur);
  });

  it('drops a batch whose graph was replaced while it was in flight (refresh landed first)', () => {
    // 舊圖：已經往回載入到 30；送出的這批是從 30 的 parent 29 往回抓的
    const old = graph([commit(50, [40]), commit(40, [30]), commit(30, [29])]);
    // 重新整理的第一批先回來了（force push 之後：50 不見了，新的 51 接在 40 上）
    const refreshed = graph([commit(51, [40]), commit(40, [39])]);
    const cur = { graph: refreshed, dead: new Set<string>() };
    // 從舊圖抓的 29 ← 28 不能接進新圖：會變成斷開的一段
    expect(mergeBatch(cur, old, [sha(29)], [commit(29, [28]), commit(28, [27])])).toBeNull();
    // 換了 repo、回到 loading（沒有目前的圖）也一樣丟掉
    expect(mergeBatch(null, old, [sha(29)], [commit(29, [28])])).toBeNull();
    // 只比圖本身：內容相同但是另一張圖（重新整理回來的新物件）也算換掉了
    const same = graph([...old.commits]);
    expect(mergeBatch({ graph: same, dead: new Set() }, old, [sha(29)], [commit(29, [])])).toBe(
      null,
    );
  });
});

describe('historyErrorCode', () => {
  it('passes GitHub error codes through (the viewer translates them)', () => {
    for (const code of [
      'invalid_repo',
      'not_found',
      'unauthorized',
      'rate_limited',
      'empty_repo',
      'network',
      'unknown',
    ]) {
      expect(historyErrorCode(code)).toBe(code);
    }
  });

  it("maps the background's own codes and anything else to 'unknown'", () => {
    for (const code of ['invalid', 'toString', '__proto__', 'Not Found', '', undefined, null, 42]) {
      expect(historyErrorCode(code), String(code)).toBe('unknown');
    }
  });
});
