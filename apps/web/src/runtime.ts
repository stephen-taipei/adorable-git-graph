/**
 * 有沒有後端可以讀本機 git：`pnpm start`（Vite dev server）或 npm CLI（`npx @stephen.taipei/adorable-git-graph`，
 * 以 `VITE_AGG_SERVER=1` 建置）。靜態建置（`pnpm --filter @adorable/web build`）沒有，只有建置當下的快照。
 */
export const HAS_SERVER: boolean =
  import.meta.env.DEV || import.meta.env['VITE_AGG_SERVER'] === '1';
