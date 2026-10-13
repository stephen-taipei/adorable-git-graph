#!/usr/bin/env node
// npx 不檢查 engines：太舊的 Node 先給一句看得懂的話，而不是語法錯誤
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`adorable-git-graph needs Node.js 22 or newer (found ${process.versions.node}).`);
  process.exit(1);
}
const { main } = await import('../dist/server.mjs');
main(process.argv.slice(2)).catch((err) => {
  console.error(`adorable-git-graph: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
