import { describe, expect, it } from 'vitest';
import { buildLayout, classifyCommit, olderHistory, routeEdge } from './layout.ts';
import { createDemoData } from './demo.ts';
import { appendCommits, missingParents } from './history.ts';
import type { CommitInput, GraphData, GraphLayout } from './types.ts';

const commit = (sha: string, parents: string[], hour: number, message = sha): CommitInput => ({
  sha,
  parents,
  message,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

const data = (commits: CommitInput[], head: string): GraphData => ({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits,
  refs: [{ name: 'main', sha: head, kind: 'branch', isDefault: true }],
});

describe('classifyCommit', () => {
  it.each([
    ['feat: a', 1, 'feat'],
    ['fix(core)!: a', 1, 'fix'],
    ['Revert "x"', 1, 'revert'],
    ['whatever', 1, 'normal'],
    ['feat: a', 2, 'merge'],
    ['init', 0, 'root'],
  ])('%s (%i parents) → %s', (msg, n, kind) => {
    expect(classifyCommit(msg, n)).toBe(kind);
  });
});

describe('buildLayout', () => {
  it('puts a linear history on lane 0, newest on the first row', () => {
    const l = buildLayout(
      data([commit('c', ['b'], 3), commit('b', ['a'], 2), commit('a', [], 1)], 'c'),
    );
    expect(l.nodes.map((n) => [n.sha, n.row, n.lane])).toEqual([
      ['c', 0, 0],
      ['b', 1, 0],
      ['a', 2, 0],
    ]);
    expect(l.edges.every((e) => e.kind === 'main')).toBe(true);
    expect(l.edges.every((e) => e.points.length === 2)).toBe(true);
    expect(l.truncated).toBe(false);
    expect(l.laneCount).toBe(1);
    expect(l.nodes[2]!.kind).toBe('root');
    expect(l.nodes[0]!.isHead).toBe(true);
    expect(l.nodes.map((n) => n.children)).toEqual([[], ['c'], ['b']]);
  });

  it('keeps the default branch on lane 0 and moves side branches off it', () => {
    //  a - b - m(merge)
    //   \     /
    //    f1 - f2
    const l = buildLayout(
      data(
        [
          commit('m', ['b', 'f2'], 6),
          commit('f2', ['f1'], 5),
          commit('b', ['a'], 4),
          commit('f1', ['a'], 3),
          commit('a', [], 1),
        ],
        'm',
      ),
    );
    const by = Object.fromEntries(l.nodes.map((n) => [n.sha, n]));
    expect([by.a, by.b, by.m].map((n) => n!.lane)).toEqual([0, 0, 0]);
    expect(by.f1!.lane).toBe(by.f2!.lane);
    expect(by.f1!.lane).not.toBe(0);
    expect(by.m!.kind).toBe('merge');
    expect(by.f1!.colorIndex).not.toBe(by.a!.colorIndex);

    const kinds = Object.fromEntries(l.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(kinds['a>f1']).toBe('fork');
    expect(kinds['f2>m']).toBe('merge');
    expect(kinds['a>b']).toBe('main');
  });

  it('gives every node its own row (row === index) and lists children before parents', () => {
    const l = buildLayout(createDemoData());
    l.nodes.forEach((n, i) => expect(n.row).toBe(i));
    const row = new Map(l.nodes.map((n) => [n.sha, n.row]));
    for (const e of l.edges) expect(row.get(e.to)!).toBeLessThan(row.get(e.from)!);
    expect(l.nodes).toHaveLength(createDemoData().commits.length);
    expect(l.laneCount).toBe(Math.max(...l.nodes.map((n) => n.lane)) + 1);
  });

  it('edge polylines start at the child (top) and end at the parent (bottom), top → bottom', () => {
    const l = buildLayout(createDemoData());
    const by = new Map(l.nodes.map((n) => [n.sha, n]));
    for (const e of l.edges) {
      const first = e.points[0]!;
      const last = e.points[e.points.length - 1]!;
      expect(first).toEqual([by.get(e.to)!.lane, by.get(e.to)!.row]);
      expect(last[0]).toBeCloseTo(by.get(e.from)!.lane);
      expect(last[1]).toBeCloseTo(by.get(e.from)!.row);
      for (let i = 1; i < e.points.length; i++) {
        expect(e.points[i]![1]).toBeGreaterThanOrEqual(e.points[i - 1]![1] - 1e-9);
      }
    }
  });

  it('records children and the checked-out branch tip (local sources)', () => {
    //  a - b - m(merge, main)
    //   \     /
    //    f1 - f2   (current branch: feat)
    const cs = [
      commit('m', ['b', 'f2'], 6),
      commit('f2', ['f1'], 5),
      commit('b', ['a'], 4),
      commit('f1', ['a'], 3),
      commit('a', [], 1),
    ];
    const l = buildLayout({
      repo: { owner: 'o', name: 'r', defaultBranch: 'main', currentBranch: 'feat' },
      commits: cs,
      refs: [
        { name: 'main', sha: 'm', kind: 'branch', isDefault: true },
        { name: 'feat', sha: 'f2', kind: 'branch' },
        { name: 'origin/feat', sha: 'f1', kind: 'branch', remote: 'origin' },
      ],
    });
    const by = Object.fromEntries(l.nodes.map((n) => [n.sha, n]));
    expect(by.a!.children.sort()).toEqual(['b', 'f1']);
    expect(by.m!.isCurrent).toBe(false);
    expect(by.f2!.isCurrent).toBe(true);
    expect(by.f2!.isHead).toBe(false);
    // 圖例：default → 目前 → 其他本機 → remote
    expect(l.branches.map((b) => [b.name, b.isCurrent, b.remote])).toEqual([
      ['main', false, undefined],
      ['feat', true, undefined],
      ['origin/feat', false, 'origin'],
    ]);
  });

  it('flags truncated history when parents are outside the loaded range', () => {
    const l = buildLayout(data([commit('c', ['b'], 3), commit('b', ['zzz'], 2)], 'c'));
    expect(l.truncated).toBe(true);
    expect(l.nodes.find((n) => n.sha === 'b')!.hasHiddenParents).toBe(true);
    expect(l.edges).toHaveLength(1);
  });

  it('survives broken / forged histories: self-parent and cycles never crash the layout', () => {
    const l = buildLayout(
      data(
        [
          commit('c', ['f1', 'b'], 5),
          commit('b', ['a'], 3),
          commit('a', [], 1),
          commit('f1', ['f1'], 4), // 自己是自己的 parent
          commit('x', ['y'], 2),
          commit('y', ['x'], 2), // 互相為 parent 的環
        ],
        'c',
      ),
    );
    expect(l.nodes.map((n) => n.sha).sort()).toEqual(['a', 'b', 'c']);
    for (const e of l.edges) {
      expect(l.nodes.some((n) => n.sha === e.from)).toBe(true);
      expect(l.nodes.some((n) => n.sha === e.to)).toBe(true);
    }
  });

  it('clips to the newest maxCommits', () => {
    const cs = Array.from({ length: 10 }, (_, i) => commit(`c${i}`, i ? [`c${i - 1}`] : [], i));
    const l = buildLayout(data(cs, 'c9'), { maxCommits: 4 });
    expect(l.nodes.map((n) => n.sha)).toEqual(['c9', 'c8', 'c7', 'c6']);
    expect(l.truncated).toBe(true);
  });

  it('keeps the default branch tip (and its recent history) when other branches are much newer', () => {
    // main の tip は 5 本目の古い commit。別 branch が新しい commit を大量に持っていても、clip で main が消えない
    const main = Array.from({ length: 5 }, (_, i) => commit(`m${i}`, i ? [`m${i - 1}`] : [], i));
    const side = Array.from({ length: 30 }, (_, i) =>
      commit(`s${i}`, i ? [`s${i - 1}`] : ['m0'], 100 + i),
    );
    const l = buildLayout(
      {
        repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
        commits: [...main, ...side],
        refs: [
          { name: 'main', sha: 'm4', kind: 'branch', isDefault: true },
          { name: 'feat', sha: 's29', kind: 'branch' },
        ],
      },
      { maxCommits: 10 },
    );
    expect(l.truncated).toBe(true);
    expect(l.nodes.length).toBe(10);
    const head = l.nodes.find((n) => n.isHead);
    expect(head?.sha).toBe('m4');
    expect(head?.lane).toBe(0);
    expect(l.branches.map((b) => b.name)).toContain('main');
  });

  it('survives an empty repo and duplicate commits', () => {
    expect(buildLayout(data([], 'x')).nodes).toEqual([]);
    const c = commit('a', [], 1);
    expect(buildLayout(data([c, c], 'a')).nodes).toHaveLength(1);
  });

  it('lists branches in the legend with the default first and colors from the tip', () => {
    const l = buildLayout(createDemoData());
    expect(l.branches[0]).toMatchObject({ name: 'main', isDefault: true });
    expect(l.branches.map((b) => b.name)).toEqual(['main', 'feat/dark-mode', 'release/v0.1']);
    const head = l.nodes.find((n) => n.isHead)!;
    expect(l.branches[0]!.color).toBe(head.color);
  });
});

// ── 往回載入更早的歷史（infinite scroll）時的排版 ─────────────────────────────

const shas = (l: GraphLayout) => l.nodes.map((n) => n.sha);

/** 每條邊都是 child 在上、parent 在下（row 越大越舊），row 就是索引。 */
function expectTopological(l: GraphLayout) {
  l.nodes.forEach((n, i) => expect(n.row).toBe(i));
  const row = new Map(l.nodes.map((n) => [n.sha, n.row]));
  for (const n of l.nodes) {
    for (const p of n.parents) {
      if (row.has(p)) expect(row.get(p)!, `${n.sha} → ${p}`).toBeGreaterThan(n.row);
    }
  }
}

/** `before` 裡（還在 `after` 裡的）commit 在 `after` 裡的相對順序沒變。 */
function expectRelativeOrderKept(before: readonly string[], after: readonly string[]) {
  const pos = new Map(after.map((s, i) => [s, i]));
  const kept = before.filter((s) => pos.has(s));
  const sorted = [...kept].sort((a, b) => pos.get(a)! - pos.get(b)!);
  expect(sorted).toEqual(kept);
}

/**
 * GitHub 的 `/commits?sha=<sha>&per_page=<n>`：那個 commit 與它的祖先，日期新→舊取前 n 筆
 * （fetchGitHubCommitsFrom 對每個 missing parent 各抓一頁）。
 */
function githubPage(all: Map<string, CommitInput>, sha: string, n: number): CommitInput[] {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (seen.has(s) || !all.has(s)) continue;
    seen.add(s);
    stack.push(...all.get(s)!.parents);
  }
  return [...seen]
    .map((s) => all.get(s)!)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, n);
}

describe('olderHistory', () => {
  it('walks from the previous hidden parents through commits that were not loaded before', () => {
    //  new ← c ← b ← [a ← root]   （a、root 是這次才載入的；new 是剛 commit 的）
    const cs = [
      commit('new', ['c'], 5),
      commit('c', ['b'], 4),
      commit('b', ['a'], 3),
      commit('a', ['root'], 2),
      commit('root', [], 1),
    ];
    expect([...olderHistory(new Set(['c', 'b']), cs)].sort()).toEqual(['a', 'root']);
    // 上一次什麼都沒有 → 沒有「更早的」
    expect(olderHistory(new Set(), cs).size).toBe(0);
    // parent 這次也沒載入：走到那裡就停
    expect([...olderHistory(new Set(['c']), [commit('c', ['b'], 4)])]).toEqual([]);
  });

  it('follows merge parents and the other branch of a merge, never the children', () => {
    //  m = merge(b, f)；上一次只有 m
    const cs = [
      commit('m', ['b', 'f'], 9),
      commit('b', ['a'], 5),
      commit('f', ['a'], 6),
      commit('a', [], 1),
      commit('side', ['a'], 7), // a 的另一個 child（新的 branch），不是誰的 parent
    ];
    expect([...olderHistory(new Set(['m']), cs)].sort()).toEqual(['a', 'b', 'f']);
  });
});

describe('buildLayout previousOrder (infinite scroll)', () => {
  // main 很活躍（每小時一個 commit），feature 很少動：feature 的一頁就涵蓋了很長一段時間
  //   r ← m0 ← m1 ← … ← m19（main，100–119 時）
  //   r ← f0 ← f1 ← f2 ← f3 ← f4（feature，5 / 30 / 60 / 90 / 118.5 時）
  const main = Array.from({ length: 20 }, (_, i) =>
    commit(`m${i}`, [i ? `m${i - 1}` : 'r'], 100 + i),
  );
  const feature = [5, 30, 60, 90, 118.5].map((h, i) => commit(`f${i}`, [i ? `f${i - 1}` : 'r'], h));
  const all = new Map([...main, ...feature, commit('r', [], 0)].map((c) => [c.sha, c]));
  const refs: GraphData['refs'] = [
    { name: 'main', sha: 'm19', kind: 'branch', isDefault: true },
    { name: 'feature', sha: 'f4', kind: 'branch' },
  ];
  const first: GraphData = {
    repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
    commits: [...githubPage(all, 'm19', 3), ...githubPage(all, 'f4', 3)],
    refs,
    truncated: true,
  };
  /** 一批：從每個 missing parent 各抓一頁，接在後面（和 fetchMoreGitHubHistory 一樣）。 */
  const nextBatch = (g: GraphData, perPage = 3) =>
    appendCommits(
      g,
      missingParents(g).flatMap((s) => githubPage(all, s, perPage)),
    );

  it('without previousOrder, older commits of one branch land between the loaded rows of another', () => {
    // 這就是要修的情況：feature 的舊 commit 原本在最底下，main 的下一頁照日期排在它們上面
    const l1 = buildLayout(first);
    expect(shas(l1)).toEqual(['m19', 'f4', 'm18', 'm17', 'f3', 'f2']);
    const l2 = buildLayout(nextBatch(first));
    expect(shas(l2).slice(0, 7)).toEqual(['m19', 'f4', 'm18', 'm17', 'm16', 'm15', 'm14']);
  });

  it('keeps the loaded rows where they are and appends GitHub-style per-branch pages below them', () => {
    const l1 = buildLayout(first);
    const g2 = nextBatch(first);
    const l2 = buildLayout(g2, { previousOrder: shas(l1) });
    // 原本的六列一列都沒動（前綴不變）；main 的 m16–m14、feature 的 f1 → f0 → r 接在後面
    expect(shas(l2)).toEqual([...shas(l1), 'm16', 'm15', 'm14', 'f1', 'f0', 'r']);
    expectTopological(l2);

    // 再一批（main 的 m13–m11），還是接在最後面
    const g3 = nextBatch(g2);
    const l3 = buildLayout(g3, { previousOrder: shas(l2) });
    expect(shas(l3)).toEqual([...shas(l2), 'm13', 'm12', 'm11']);
    expectTopological(l3);
  });

  it('keeps the loaded rows in place through a whole paging session; only a forced move happens', () => {
    let g = first;
    let l = buildLayout(g);
    let batches = 0;
    while (missingParents(g).length > 0 && batches++ < 20) {
      const next = nextBatch(g, 2);
      const nl = buildLayout(next, { previousOrder: shas(l) });
      expectTopological(nl);
      const before = shas(l);
      const after = shas(nl);
      // feature 的頁面早就載到 root；main 最後接回 root（m0）的那一批，root 被迫移到 m0 下面
      const rootForced = before.includes('r') && !before.includes('m0') && after.includes('m0');
      if (rootForced) {
        expectRelativeOrderKept(
          before,
          after.filter((s) => s !== 'r'),
        );
        expect(after.at(-1)).toBe('r');
      } else {
        // 其他每一批：已經顯示的列一列都沒動，新的全部接在後面
        expect(after.slice(0, before.length)).toEqual(before);
      }
      g = next;
      l = nl;
    }
    expect(l.nodes).toHaveLength(all.size);
    expect(l.truncated).toBe(false);
    expect(shas(l).slice(0, 6)).toEqual(shas(buildLayout(first)));
  });

  it('puts older history that descends from an already-loaded commit right above that commit', () => {
    //  main：r ← a ← F ← x1 ← x2 ← x3 ← x4（tip），feature 從 F 分岔：F ← f1（tip，最新）
    //  第一批：main 只載到 x4、x3；feature 的頁面一路載到 F、a
    const cs = [
      commit('r', [], 0),
      commit('a', ['r'], 1),
      commit('F', ['a'], 2),
      commit('x1', ['F'], 3),
      commit('x2', ['x1'], 4),
      commit('x3', ['x2'], 5),
      commit('x4', ['x3'], 6),
      commit('f1', ['F'], 7),
    ];
    const by = new Map(cs.map((c) => [c.sha, c]));
    const pick = (...s: string[]) => s.map((x) => by.get(x)!);
    const g1: GraphData = {
      repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
      commits: pick('x4', 'x3', 'f1', 'F', 'a'),
      refs: [
        { name: 'main', sha: 'x4', kind: 'branch', isDefault: true },
        { name: 'feature', sha: 'f1', kind: 'branch' },
      ],
    };
    const l1 = buildLayout(g1);
    expect(shas(l1)).toEqual(['f1', 'x4', 'x3', 'F', 'a']);
    // main 的下一頁：x2、x1（F 的子孫，一定要在 F 上面）與 r（接在最後面）
    const l2 = buildLayout(appendCommits(g1, pick('x2', 'x1', 'r')), { previousOrder: shas(l1) });
    expect(shas(l2)).toEqual(['f1', 'x4', 'x3', 'x2', 'x1', 'F', 'a', 'r']);
    expectTopological(l2);
  });

  it('still puts genuinely new commits on top by date (a refresh after a commit)', () => {
    const l1 = buildLayout(first);
    // feature 上剛 commit 了一筆（最新），main 上也有一筆，但比 feature 那筆舊
    const g = {
      ...first,
      commits: [commit('m20', ['m19'], 120), commit('f5', ['f4'], 121), ...first.commits],
    };
    const l2 = buildLayout(g, { previousOrder: shas(l1) });
    expect(shas(l2)).toEqual(['f5', 'm20', ...shas(l1)]);
    expectTopological(l2);
    // 沒有 previousOrder 時也是一樣的結果
    expect(shas(buildLayout(g))).toEqual(shas(l2));
  });

  it('merges a new branch with old dates into the old rows by date', () => {
    const l1 = buildLayout(first);
    // 新出現的 branch：tip 在 m18 與 m17 之間，接在已經載入的 f3 上
    const g = { ...first, commits: [...first.commits, commit('h1', ['f3'], 117.5)] };
    const l2 = buildLayout(g, { previousOrder: shas(l1) });
    expect(shas(l2)).toEqual(['m19', 'f4', 'm18', 'h1', 'm17', 'f3', 'f2']);
    expectTopological(l2);
  });

  it('is idempotent: re-laying out with its own order changes nothing (StrictMode re-runs)', () => {
    const demo = createDemoData();
    const l = buildLayout(demo);
    const again = buildLayout(demo, { previousOrder: shas(l) });
    expect(shas(again)).toEqual(shas(l));
    expect(again.nodes.map((n) => n.lane)).toEqual(l.nodes.map((n) => n.lane));
    expect(again.edges).toEqual(l.edges);
  });

  it('ignores unknown / dropped shas, and survives cycles and an order that contradicts the topology', () => {
    const cs = [commit('c', ['b'], 3), commit('b', ['a'], 2), commit('a', [], 1)];
    // 不存在的 sha、重複的 sha、空的順序
    expect(shas(buildLayout(data(cs, 'c'), { previousOrder: ['zzz', 'c', 'c', 'gone'] }))).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(shas(buildLayout(data(cs, 'c'), { previousOrder: [] }))).toEqual(['c', 'b', 'a']);
    // 和 parent 關係矛盾的順序：拓樸優先
    const flipped = buildLayout(data(cs, 'c'), { previousOrder: ['a', 'b', 'c'] });
    expect(shas(flipped)).toEqual(['c', 'b', 'a']);
    expectTopological(flipped);
    // 環（壞掉 / 偽造的歷史）不排、也不會卡住
    const broken = buildLayout(
      data([...cs, commit('x', ['y'], 5), commit('y', ['x'], 5), commit('s', ['s'], 6)], 'c'),
      { previousOrder: ['x', 's', 'c', 'y', 'b', 'a'] },
    );
    expect(shas(broken)).toEqual(['c', 'b', 'a']);
  });
});

describe('routeEdge', () => {
  it('returns a straight segment on the same lane', () => {
    expect(routeEdge({ lane: 0, row: 0 }, { lane: 0, row: 5 }, 0)).toEqual([
      [0, 0],
      [0, 5],
    ]);
  });
  it('runs vertically on the via lane and only bends near the end', () => {
    const pts = routeEdge({ lane: 2, row: 0 }, { lane: 0, row: 6 }, 2);
    expect(pts[0]).toEqual([2, 0]);
    expect(pts[1]).toEqual([2, 5]);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(0);
    expect(last[1]).toBeCloseTo(6);
    for (const [lane] of pts) expect(lane).toBeLessThanOrEqual(2 + 1e-9);
  });
  it('shrinks the curve when parent and child are on adjacent rows', () => {
    const pts = routeEdge({ lane: 0, row: 0 }, { lane: 2, row: 1 }, 0);
    expect(pts[0]).toEqual([0, 0]);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(2);
    expect(last[1]).toBeCloseTo(1);
    for (const [, row] of pts) {
      expect(row).toBeGreaterThanOrEqual(-1e-9);
      expect(row).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('bends at both ends when the via lane differs from both', () => {
    const pts = routeEdge({ lane: 0, row: 0 }, { lane: 1, row: 10 }, 3);
    const lanes = pts.map(([l]) => l);
    expect(Math.max(...lanes)).toBeCloseTo(3);
    expect(lanes[0]).toBe(0);
    expect(lanes[lanes.length - 1]).toBeCloseTo(1);
  });
});
