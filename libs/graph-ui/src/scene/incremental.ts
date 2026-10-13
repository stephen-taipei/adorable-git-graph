import { olderHistory } from '@adorable/graph-core';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';

/**
 * 增量更新（同一個 repo 換了新的 layout）時，哪些 node 要播「新 commit 彈出來」的動畫，由舊到新排好。
 *   - 原本就有的（`previous`）：立刻就位
 *   - 往回載入的更早歷史（infinite scroll）：從上一次「看不到的 parent」沿 parent 走得到的（olderHistory），
 *     或排在所有舊列下面的 → 立刻就位。就算它們照日期插在舊列之間（例如 GitHub 每條 branch 各抓一頁），也不是新的 commit
 *   - 其餘（剛 commit / pull 進來的，都是既有 commit 的 child）：只有可視範圍附近（上下各 2 列）的會彈出來，
 *     畫面外的立刻就位，不然要白等一長串看不到的動畫
 */
export function spawnOrder(
  previous: ReadonlySet<string>,
  layout: GraphLayout,
  view: { first: number; last: number },
): GraphNode[] {
  const older = olderHistory(previous, layout.nodes);
  let lastOld = -1;
  for (const n of layout.nodes) if (previous.has(n.sha)) lastOld = n.row;
  return layout.nodes
    .filter((n) => !previous.has(n.sha) && !older.has(n.sha) && n.row < lastOld)
    .filter((n) => n.row >= view.first - 2 && n.row <= view.last + 2)
    .reverse();
}
