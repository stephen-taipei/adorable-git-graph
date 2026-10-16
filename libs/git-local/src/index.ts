// 本機 git 執行環境（node 端）：Vite dev server（apps/web/plugins）與 npm CLI（apps/cli）共用。
// 瀏覽器端只能 import `@adorable/git-local/protocol`（不含任何 node 模組）。
export * from './protocol.ts';
export * from './git-snapshot.ts';
export * from './diagnostics.ts';
