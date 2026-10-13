// Chrome Web Store 上架用的一條龍（對應 Firefox 的 release.mjs）：
// 乾淨 working tree → 以「不含任何 AGG_* 覆寫」的環境建置 → 檢查產物 → 打包 zip。
// 任何一步失敗就中止，不會留下「看起來能上傳」的半成品。
// 用法：pnpm --filter @adorable/extension release   → release/adorable-git-graph-chrome-<version>.zip
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(appRoot, 'dist');
const outDir = resolve(appRoot, 'release');
const allowDirty = process.argv.includes('--allow-dirty');

const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: appRoot, env, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✘ ${cmd} ${args.join(' ')} 失敗`);
    process.exit(r.status ?? 1);
  }
};
const status = spawnSync('git', ['-C', appRoot, 'status', '--porcelain'], { encoding: 'utf8' });
if (status.stdout.trim() && !allowDirty) {
  console.error(`✘ working tree 有未 commit 的變更，請先 commit 或 stash：\n${status.stdout}`);
  process.exit(1);
}

// 環境裡殘留的 AGG_*（之前跑 e2e / 開發時 export 的）會改變產物（host 權限、sourcemap…），一律拿掉
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGG_')),
);
run(process.execPath, ['scripts/build.mjs'], cleanEnv);

// 產物必須就是正式版：權限只有 GitHub、沒有 sourcemap、沒有 e2e 用的本機網址
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.permissions, ['storage']);
assert.deepEqual(manifest.host_permissions, ['https://api.github.com/*']);
assert.deepEqual(
  manifest.content_scripts.map((c) => c.matches),
  [['https://github.com/*']],
);
assert.ok(manifest.background?.service_worker, 'Chrome build must use a service worker');
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
const files = walk(dist).sort();
assert.deepEqual(
  files.filter((f) => f.endsWith('.map')),
  [],
  'production build must not ship sourcemaps',
);
for (const f of files.filter((f) => /\.(js|json|html)$/.test(f))) {
  const text = readFileSync(f, 'utf8');
  assert.ok(
    !/https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(text),
    `${f} points at a local address`,
  );
}

// zip（deflate）：檔案在根目錄，manifest.json 在最上層（Chrome Web Store 的要求）
const entries = [];
const chunks = [];
let offset = 0;
for (const file of files) {
  const name = relative(dist, file).split(sep).join('/');
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  // 固定的時間戳（1980-01-01）：同一份原始碼打包出相同的 zip
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 檔名
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  chunks.push(header, nameBuf, packed);
  entries.push({ nameBuf, crc, size: data.length, packedSize: packed.length, offset });
  offset += header.length + nameBuf.length + packed.length;
}
const central = [];
for (const e of entries) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt16LE(0, 12);
  h.writeUInt16LE(0x21, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.packedSize, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt32LE(e.offset, 42);
  central.push(h, e.nameBuf);
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const zip = join(outDir, `adorable-git-graph-chrome-${pkg.version}.zip`);
writeFileSync(zip, Buffer.concat([...chunks, ...central, end]));
console.log(
  `\n✔ ${relative(appRoot, zip)}（${entries.length} 個檔案，${(statSync(zip).size / 1024).toFixed(0)} KB）可以上傳 Chrome Web Store。`,
);
