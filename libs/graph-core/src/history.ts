import { coverage, type GraphCoverage } from './diagnostics.ts';
import type { CommitInput, GraphData } from './types.ts';

/**
 * 被引用到、但不在已載入範圍內的 parent（依 commits 的順序、去重）：infinite scroll 的起點。
 * 例如每條 branch 只抓了最新的 N 筆時，最舊那一筆的 parent 就是下一批要從哪裡往回抓。
 */
export function missingParents(data: GraphData): string[] {
  const have = new Set(data.commits.map((c) => c.sha));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of data.commits) {
    for (const p of c.parents) {
      if (have.has(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * 把更早的 commit 併進來（sha 去重，原有的順序不變、新的接在後面），truncated = 還有 missingParents。
 * 沒有任何新的 commit、truncated 也沒變時原樣回傳同一個物件（React 那邊就不會重新排版）。
 * refs 不動：GitHub 來源本來就保留了抓到的 tag（只有 /tags 的第一頁，見 fetchGitHubGraph），
 * 指向的 commit 載入之後才會在圖上出現。
 */
export function appendCommits(data: GraphData, older: readonly CommitInput[]): GraphData {
  const have = new Set(data.commits.map((c) => c.sha));
  const added: CommitInput[] = [];
  for (const c of older) {
    if (have.has(c.sha)) continue;
    have.add(c.sha);
    added.push(c);
  }
  const commits = added.length > 0 ? [...data.commits, ...added] : data.commits;
  const truncated = commits.some((c) => c.parents.some((p) => !have.has(p)));
  if (added.length === 0 && Boolean(data.truncated) === truncated) return data;
  return {
    ...data,
    commits,
    truncated,
    ...(data.coverage ? { coverage: appendedCoverage(data, data.coverage, have, truncated) } : {}),
  };
}

/**
 * 往回載入之後重算涵蓋範圍：commit 數、「讀取達上限」與「tag 指向還沒載入的 commit」跟著更新，
 * 其他原因（shallow clone、ref 篩選…）原樣保留。observedAt 不變：更早的 commit 不會因為晚一點讀而不同。
 */
function appendedCoverage(
  data: GraphData,
  prev: GraphCoverage,
  have: ReadonlySet<string>,
  truncated: boolean,
): GraphCoverage {
  const shallow = prev.commits.reasons.includes('shallow');
  const commitReasons = [
    ...prev.commits.reasons.filter((r) => r !== 'history_limit'),
    ...(truncated && !shallow ? ['history_limit'] : []),
  ];
  const commitsComplete = commitReasons.length === 0;
  let refs = prev.refs;
  if (
    refs.reasons.includes('tags_outside_history') &&
    data.refs.every((r) => r.kind !== 'tag' || have.has(r.sha))
  ) {
    const reasons = refs.reasons.filter((r) => r !== 'tags_outside_history');
    refs = coverage(
      reasons.length ? refs.status : 'complete',
      reasons,
      refs.loaded,
      reasons.length ? refs.total : refs.loaded,
    );
  }
  return {
    ...prev,
    refs,
    commits: coverage(
      commitsComplete ? 'complete' : 'partial',
      commitReasons,
      have.size,
      commitsComplete ? have.size : undefined,
    ),
  };
}
