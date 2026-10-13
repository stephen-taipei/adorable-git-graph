import { colorAt } from './palette.ts';
import type {
  CommitInput,
  CommitKind,
  EdgeKind,
  GraphBranch,
  GraphData,
  GraphEdge,
  GraphLayout,
  GraphNode,
  LayoutOptions,
  RefInput,
} from './types.ts';

const DEFAULT_MAX_COMMITS = 400;
/** 換 lane 時，S 型曲線佔用的列數（grid unit）。 */
const CURVE_LEN = 1;
const CURVE_SAMPLES = 10;

export function classifyCommit(message: string, parentCount: number): CommitKind {
  if (parentCount === 0) return 'root';
  if (parentCount > 1) return 'merge';
  const head = message.trimStart().slice(0, 40).toLowerCase();
  if (/^revert\b/.test(head)) return 'revert';
  const m = /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style)(\([^)]*\))?!?:/.exec(head);
  switch (m?.[1]) {
    case 'feat':
      return 'feat';
    case 'fix':
      return 'fix';
    case 'docs':
      return 'docs';
    case 'chore':
    case 'build':
    case 'ci':
    case 'style':
      return 'chore';
    default:
      return 'normal';
  }
}

interface PendingEdge {
  parent: string;
  child: string;
  kind: 'first' | 'other';
  childLane: number;
  viaLane: number;
  colorIndex: number;
}

/** 超過上限時，保證 default / 目前 branch 的 tip 與它們最近的祖先一定留下（其餘依日期新→舊補滿）。 */
const KEEP_TIP_HISTORY = 40;

function clipToNewest(list: CommitInput[], data: GraphData, maxCommits: number): CommitInput[] {
  const bySha = new Map(list.map((c) => [c.sha, c]));
  const keep = new Set<string>();
  const tips = new Set<string>();
  const defaultRef = data.refs.find((r) => r.kind === 'branch' && r.isDefault);
  if (defaultRef) tips.add(defaultRef.sha);
  const cur = data.repo.currentBranch;
  const currentRef = cur
    ? data.refs.find((r) => r.kind === 'branch' && !r.remote && r.name === cur)
    : undefined;
  if (currentRef) tips.add(currentRef.sha);
  // 保留的筆數不能吃掉整個上限（maxCommits 還是上限）：每個 tip 至多佔上限的一半 / tip 數
  const perTip = Math.max(
    1,
    Math.min(KEEP_TIP_HISTORY, Math.floor(maxCommits / (2 * Math.max(1, tips.size)))),
  );
  for (const tip of tips) {
    // 沿 first parent 往回
    let sha: string | undefined = tip;
    for (let i = 0; i < perTip && sha && bySha.has(sha) && !keep.has(sha); i++) {
      keep.add(sha);
      sha = bySha.get(sha)!.parents[0];
    }
  }
  const budget = maxCommits;
  const newest = [...list].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const out = newest.filter((c) => keep.has(c.sha));
  for (const c of newest) {
    if (out.length >= budget) break;
    if (!keep.has(c.sha)) out.push(c);
  }
  return out;
}

/** 每個 commit 的時間（ms）：排序時會比較很多次，先 parse 好。 */
function timesOf(commits: Map<string, CommitInput>): Map<string, number> {
  const time = new Map<string, number>();
  for (const [sha, c] of commits) time.set(sha, Date.parse(c.date) || 0);
  return time;
}

/** `pool` 裡日期最新（同一時間比 sha）的索引；空的時候是 -1。 */
function newestIndex(pool: readonly string[], time: ReadonlyMap<string, number>): number {
  let best = -1;
  let bestTime = 0;
  for (let i = 0; i < pool.length; i++) {
    const sha = pool[i]!;
    const t = time.get(sha) ?? 0;
    if (best < 0 || t > bestTime || (t === bestTime && sha > pool[best]!)) {
      best = i;
      bestTime = t;
    }
  }
  return best;
}

/** 每個 commit 還有幾個（範圍內的）child、以及 child 的清單。 */
function childIndex(commits: Map<string, CommitInput>) {
  const left = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  for (const sha of commits.keys()) left.set(sha, 0);
  for (const [sha, c] of commits) {
    for (const p of new Set(c.parents)) {
      if (!commits.has(p)) continue;
      left.set(p, left.get(p)! + 1);
      const arr = childrenOf.get(p);
      if (arr) arr.push(sha);
      else childrenOf.set(p, [sha]);
    }
  }
  return { left, childrenOf };
}

/** children-first 的拓樸排序；同層以日期新→舊為先。 */
function topoOrder(commits: Map<string, CommitInput>): string[] {
  const { left } = childIndex(commits);
  const time = timesOf(commits);
  const ready: string[] = [];
  for (const [sha, n] of left) if (n === 0) ready.push(sha);

  const order: string[] = [];
  while (ready.length > 0) {
    const sha = ready.splice(newestIndex(ready, time), 1)[0]!;
    order.push(sha);
    for (const p of new Set(commits.get(sha)!.parents)) {
      if (!commits.has(p)) continue;
      const n = left.get(p)! - 1;
      left.set(p, n);
      if (n === 0) ready.push(p);
    }
  }
  return order;
}

/**
 * 往回載入的「更早的歷史」：不在 `previous`（上一次已經載入的 sha）裡、
 * 從上一次「被引用但沒載入」的 parent 沿著 parent 一路走得到的 commit。
 * 剛 commit / pull 進來的新 commit 是既有 commit 的 child（不是誰的 parent），走不到，所以不會被算進來。
 */
export function olderHistory(
  previous: ReadonlySet<string>,
  commits: Iterable<{ sha: string; parents: readonly string[] }>,
): Set<string> {
  const parentsOf = new Map<string, readonly string[]>();
  for (const c of commits) parentsOf.set(c.sha, c.parents);
  const stack: string[] = [];
  for (const [sha, parents] of parentsOf) {
    if (!previous.has(sha)) continue;
    for (const p of parents) if (!previous.has(p)) stack.push(p);
  }
  const out = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (out.has(sha)) continue;
    const parents = parentsOf.get(sha);
    // 這次也還沒載入
    if (!parents) continue;
    out.add(sha);
    for (const p of parents) if (!previous.has(p) && !out.has(p)) stack.push(p);
  }
  return out;
}

/**
 * 有上一次的順序時的拓樸排序（children-first）：已經顯示過的 commit 維持彼此的相對順序，
 * 使用者正在看的列不會因為接上更早的歷史而重新洗牌。
 *   - 新的 commit（剛 commit / pull、新的 branch）：照日期插進舊的順序裡（通常就是最上面），和沒有 previousOrder 時一樣
 *   - 往回載入的更早歷史（olderHistory）：放在拓樸允許的最低處。沒有接到任何舊 commit 的接在最後面；
 *     是某個舊 commit 的子孫的（例如另一條 branch 的頁面早就載到它們的分岔點），就排在那個舊 commit 的正上方
 * 拓樸限制永遠優先：上一次的順序和現在的 parent 關係衝突時（例如更早的歷史把兩段接起來），被迫的那幾列才會移動。
 */
function stableOrder(
  commits: Map<string, CommitInput>,
  previousOrder: readonly string[],
): string[] {
  const was = new Set(previousOrder);
  const old: string[] = [];
  const isOld = new Set<string>();
  for (const sha of previousOrder) {
    if (!commits.has(sha) || isOld.has(sha)) continue;
    isOld.add(sha);
    old.push(sha);
  }
  if (old.length === 0) return topoOrder(commits);

  const older = olderHistory(was, commits.values());
  const time = timesOf(commits);
  const { left, childrenOf } = childIndex(commits);
  const order: string[] = [];
  const placed = new Set<string>();
  // child 都排好了、可以排的 commit（舊的 commit 不放這裡，照上一次的順序一個一個來）。
  // 在某個舊 commit 正上方一起排掉的會留在這裡：取用前先清掉
  const readyNew: string[] = [];
  const readyOlder: string[] = [];
  const poolOf = (sha: string) => (older.has(sha) ? readyOlder : readyNew);
  for (const [sha, n] of left) if (n === 0 && !isOld.has(sha)) poolOf(sha).push(sha);

  const place = (sha: string) => {
    placed.add(sha);
    order.push(sha);
    for (const p of new Set(commits.get(sha)!.parents)) {
      if (!commits.has(p)) continue;
      const n = left.get(p)! - 1;
      left.set(p, n);
      if (n === 0 && !isOld.has(p)) poolOf(p).push(p);
    }
  };
  const newestReady = (pool: string[]): number => {
    let w = 0;
    for (const sha of pool) if (!placed.has(sha)) pool[w++] = sha;
    pool.length = w;
    return newestIndex(pool, time);
  };
  // `sha` 還有沒排的 child（往回載入的更早歷史接在它上面）：把它所有還沒排的子孫排在它正上方（新→舊、children-first）
  const placeAbove = (sha: string) => {
    const group = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      for (const ch of childrenOf.get(stack.pop()!) ?? []) {
        if (placed.has(ch) || group.has(ch)) continue;
        group.add(ch);
        stack.push(ch);
      }
    }
    const ready = [...group].filter((s) => left.get(s) === 0);
    while (ready.length > 0) {
      const s = ready.splice(newestIndex(ready, time), 1)[0]!;
      place(s);
      for (const p of new Set(commits.get(s)!.parents)) {
        if (group.has(p) && left.get(p) === 0) ready.push(p);
      }
    }
  };

  let k = 0;
  for (;;) {
    while (k < old.length && placed.has(old[k]!)) k++;
    const next = old[k];
    const nextReady = next !== undefined && left.get(next) === 0;
    const i = newestReady(readyNew);
    if (i >= 0 && (!nextReady || time.get(readyNew[i]!)! >= time.get(next!)!)) {
      place(readyNew.splice(i, 1)[0]!);
      continue;
    }
    if (next === undefined) break;
    if (!nextReady) placeAbove(next);
    // 還是排不了＝卡在環裡（壞掉 / 偽造的歷史），和 topoOrder 一樣不排
    if (left.get(next) === 0) place(next);
    k++;
  }
  // 剩下的：更早的歷史（沒有接到任何舊 commit 的）接在最後面，彼此照原本的拓樸 + 日期順序
  for (;;) {
    const i = newestReady(readyNew);
    if (i >= 0) {
      place(readyNew.splice(i, 1)[0]!);
      continue;
    }
    const j = newestReady(readyOlder);
    if (j < 0) break;
    place(readyOlder.splice(j, 1)[0]!);
  }
  return order;
}

/** (lane0,row0) → (lane1,row1) 的 S 型三次貝茲曲線（垂直切線）；取樣點不含起點。 */
function bezier(
  lane0: number,
  row0: number,
  lane1: number,
  row1: number,
  out: Array<[number, number]>,
): void {
  const dr = (row1 - row0) * 0.5;
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    const pl =
      u * u * u * lane0 + 3 * u * u * t * lane0 + 3 * u * t * t * lane1 + t * t * t * lane1;
    const pr =
      u * u * u * row0 +
      3 * u * u * t * (row0 + dr) +
      3 * u * t * t * (row1 - dr) +
      t * t * t * row1;
    out.push([pl, pr]);
  }
}

/**
 * child（上）→ parent（下）的折線，座標 [lane, row]。換 lane 的 S 曲線只佔兩端各 CURVE_LEN 列，
 * 中間沿 `viaLane` 垂直走（和 `git log --graph` 一樣：先垂直、到 parent 附近才轉進它的 lane）。
 */
export function routeEdge(
  child: { lane: number; row: number },
  parent: { lane: number; row: number },
  viaLane: number,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [[child.lane, child.row]];
  const dr = parent.row - child.row;
  const needStart = Math.abs(child.lane - viaLane) > 1e-9;
  const needEnd = Math.abs(viaLane - parent.lane) > 1e-9;
  const curves = (needStart ? 1 : 0) + (needEnd ? 1 : 0);
  const len = curves === 0 ? 0 : Math.min(CURVE_LEN, dr / curves);

  if (needStart) bezier(child.lane, child.row, viaLane, child.row + len, raw);
  if (needEnd) {
    raw.push([viaLane, parent.row - len]);
    bezier(viaLane, parent.row - len, parent.lane, parent.row, raw);
  } else {
    raw.push([parent.lane, parent.row]);
  }

  // 去除重複點（零長度線段會讓 ribbon 法線退化）
  const pts: Array<[number, number]> = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
  }
  return pts;
}

/** buildLayout 的選項。 */
export interface BuildLayoutOptions extends LayoutOptions {
  /**
   * 上一次排版的順序（`layout.nodes.map((n) => n.sha)`），只在同一個來源 + repo 的下一張圖時給（換 repo 不要給）。
   * 給了就讓已經顯示的列維持相對順序：往回載入的更早歷史（infinite scroll）放在拓樸允許的最低處（通常就是最後面），
   * 不會照日期插進使用者正在看的列之間；新的 commit 照日期插進去（通常在最上面）。
   * 拿同一張圖的順序再排一次會得到一樣的結果（React StrictMode 重跑也沒關係）。
   */
  previousOrder?: readonly string[];
}

export function buildLayout(data: GraphData, options: BuildLayoutOptions = {}): GraphLayout {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;

  // 1. 去重並截取最新 N 筆
  let list = [...new Map(data.commits.map((c) => [c.sha, c])).values()];
  let clipped = false;
  if (list.length > maxCommits) {
    list = clipToNewest(list, data, maxCommits);
    clipped = true;
  }
  const commits = new Map(list.map((c) => [c.sha, c]));

  const order =
    options.previousOrder && options.previousOrder.length > 0
      ? stableOrder(commits, options.previousOrder)
      : topoOrder(commits);
  // 循環 / 自己を parent に持つ（壊れた or 偽造された）commit は topoOrder に出てこない。
  // それらを parent とする辺を作ると後段で未配置ノードを参照して落ちるので、配置済みのものだけを辺の対象にする。
  const placed = new Set(order);

  // 2. lane 配置（git log --graph 演算法）
  const defaultRef = data.refs.find((r) => r.kind === 'branch' && r.isDefault);
  const defaultHead = defaultRef && commits.has(defaultRef.sha) ? defaultRef.sha : undefined;

  const lanes: Array<string | null> = [];
  const laneColor: number[] = [];
  let nextColor = 1;
  if (defaultHead) {
    lanes[0] = defaultHead;
    laneColor[0] = 0;
  }
  const firstFree = (): number => {
    let i = 0;
    while (lanes[i] != null) i++;
    return i;
  };

  const nodeLane = new Map<string, number>();
  const nodeColorIndex = new Map<string, number>();
  const pending: PendingEdge[] = [];
  const hidden = new Set<string>();

  for (const sha of order) {
    const c = commits.get(sha)!;
    const waiting: number[] = [];
    lanes.forEach((s, i) => {
      if (s === sha) waiting.push(i);
    });

    if (waiting.length === 0) {
      const lane = firstFree();
      lanes[lane] = sha;
      laneColor[lane] = nextColor++;
      waiting.push(lane);
    }
    const lane = waiting[0]!;
    nodeLane.set(sha, lane);
    nodeColorIndex.set(sha, laneColor[lane] ?? 0);
    for (const j of waiting.slice(1)) lanes[j] = null;
    lanes[lane] = null;

    const parents = [...new Set(c.parents)];
    parents.forEach((p, k) => {
      if (!commits.has(p)) {
        hidden.add(sha);
        return;
      }
      if (!placed.has(p)) return;
      if (k === 0) {
        // 沿用同一條 lane；就算 parent 已被別條 lane 等待，也要保留，避免中途被別的 branch 佔用。
        lanes[lane] = p;
        pending.push({
          parent: p,
          child: sha,
          kind: 'first',
          childLane: lane,
          viaLane: lane,
          colorIndex: laneColor[lane] ?? 0,
        });
        return;
      }
      let via = lanes.indexOf(p);
      if (via === -1) {
        via = firstFree();
        lanes[via] = p;
        laneColor[via] = nextColor++;
      }
      pending.push({
        parent: p,
        child: sha,
        kind: 'other',
        childLane: lane,
        viaLane: via,
        colorIndex: laneColor[via] ?? 0,
      });
    });
    // 第一個 parent 不在範圍內 → lane 結束
  }

  // 3. 節點（order 已是 children-first ＝ 由新到舊，row 就是它的索引）
  const refsBySha = new Map<string, RefInput[]>();
  for (const r of data.refs) {
    if (!commits.has(r.sha)) continue;
    const arr = refsBySha.get(r.sha) ?? [];
    arr.push(r);
    refsBySha.set(r.sha, arr);
  }
  const currentBranch = data.repo.currentBranch;
  const currentRef = currentBranch
    ? data.refs.find((r) => r.kind === 'branch' && !r.remote && r.name === currentBranch)
    : undefined;
  const currentTip = currentRef && commits.has(currentRef.sha) ? currentRef.sha : undefined;

  const childrenOf = new Map<string, string[]>();
  for (const sha of order) {
    for (const p of new Set(commits.get(sha)!.parents)) {
      if (!placed.has(p)) continue;
      const arr = childrenOf.get(p) ?? [];
      arr.push(sha);
      childrenOf.set(p, arr);
    }
  }

  const nodes: GraphNode[] = [];
  const nodeBySha = new Map<string, GraphNode>();
  order.forEach((sha, row) => {
    const c = commits.get(sha)!;
    const lane = nodeLane.get(sha)!;
    const colorIndex = nodeColorIndex.get(sha)!;
    const [subject = ''] = c.message.split('\n');
    const parentCount = new Set(c.parents).size;
    const node: GraphNode = {
      sha,
      shortSha: sha.slice(0, 7),
      row,
      lane,
      colorIndex,
      color: colorAt(colorIndex),
      kind: classifyCommit(c.message, parentCount),
      subject: subject.trim(),
      message: c.message,
      authorName: c.authorName,
      authorLogin: c.authorLogin,
      avatarUrl: c.avatarUrl,
      date: c.date,
      url: c.url,
      refs: refsBySha.get(sha) ?? [],
      parents: c.parents,
      children: childrenOf.get(sha) ?? [],
      isHead: sha === defaultHead,
      isCurrent: sha === currentTip,
      hasHiddenParents: hidden.has(sha),
    };
    nodes.push(node);
    nodeBySha.set(sha, node);
  });

  // 4. 邊
  const edges: GraphEdge[] = pending.map((e) => {
    const parent = nodeBySha.get(e.parent)!;
    const child = nodeBySha.get(e.child)!;
    const kind: EdgeKind =
      e.kind === 'other' ? 'merge' : parent.lane === child.lane ? 'main' : 'fork';
    return {
      from: parent.sha,
      to: child.sha,
      kind,
      colorIndex: e.colorIndex,
      color: colorAt(e.colorIndex),
      points: routeEdge(child, parent, e.viaLane),
    };
  });

  // 5. 圖例 / 範圍
  const branches: GraphBranch[] = data.refs
    .filter((r) => r.kind === 'branch' && nodeBySha.has(r.sha))
    .map((r) => ({
      name: r.name,
      sha: r.sha,
      color: nodeBySha.get(r.sha)!.color,
      isDefault: Boolean(r.isDefault),
      ...(r.remote ? { remote: r.remote } : {}),
      isCurrent: !r.remote && r.name === currentBranch,
    }))
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        Number(b.isCurrent) - Number(a.isCurrent) ||
        Number(Boolean(a.remote)) - Number(Boolean(b.remote)) ||
        a.name.localeCompare(b.name),
    );

  let laneCount = 0;
  for (const node of nodes) laneCount = Math.max(laneCount, node.lane + 1);
  for (const e of edges) {
    for (const [lane] of e.points) laneCount = Math.max(laneCount, Math.ceil(lane) + 1);
  }

  return {
    repo: data.repo,
    coverage: data.coverage && {
      ...data.coverage,
      commits:
        clipped || hidden.size > 0
          ? {
              ...data.coverage.commits,
              status: 'partial',
              reasons: [...new Set([...data.coverage.commits.reasons, 'display_window'])],
              loaded: nodes.length,
            }
          : data.coverage.commits,
    },
    fetchedAt: data.fetchedAt,
    nodes,
    edges,
    branches,
    laneCount,
    truncated: Boolean(data.truncated) || clipped || hidden.size > 0,
  };
}
