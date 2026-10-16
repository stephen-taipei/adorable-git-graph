// npm 套件的建置：
//   dist/web/       畫面（apps/web，以 VITE_AGG_SERVER=1 建置：不烤 git 快照，改向 server 要、以 SSE 收更新）
//   dist/server.mjs server（src/server.ts + libs/git-local + graph-core 打成單一檔案，零 runtime 相依）
//   LICENSE         從 repo 根目錄複製（npm 只收套件資料夾裡的檔案）
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, '../web');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });

// 開發 / e2e 用的變數不能跟著進正式的畫面
for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key];
process.env['VITE_AGG_SERVER'] = '1';
await build({
  root: web,
  configFile: resolve(web, 'vite.config.ts'),
  mode: 'production',
  logLevel: 'warn',
  build: { outDir: resolve(dist, 'web'), emptyOutDir: true },
});

await build({
  root,
  configFile: false,
  mode: 'production',
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve(root, 'src/server.ts'),
    outDir: dist,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'server.mjs' } },
  },
});

copyFileSync(resolve(root, '../../LICENSE'), resolve(root, 'LICENSE'));
console.log(`built ${dist}`);
