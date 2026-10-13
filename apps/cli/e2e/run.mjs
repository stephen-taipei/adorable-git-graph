// End-to-end：npm 套件（`npx adorable-git-graph`）。
//   · 建置後以 `npm pack` 打包、解開到暫時資料夾，從那裡執行 bin：驗證的是使用者實際拿到的 tarball
//     （files 清單、零 runtime 相依、不靠 workspace 的 node_modules），而不是 repo 裡的原始碼
//   · tarball 內容：bin / dist / LICENSE / README；不含原始碼與 e2e；bundle 不含任何 git 歷史（本 repo 或測試 repo）
//   · 畫面：列數 = git 的 commit 數、最新在最上面；git commit 後經 SSE 即時長出新的一列（頁面不重新整理）
//   · 本機 repo 選單：列出同層的 repo、切換後顯示它的歷史、它的 commit 也即時更新
//   · 安全性：其他 origin 的頁面讀不到 endpoint / SSE、偽造 Host 403、路徑穿越 404、只綁 127.0.0.1
//   · CLI：--help / --version / 不認得的選項、SIGINT 正常結束、沒有 console 錯誤
// 用法：pnpm --filter adorable-git-graph e2e（CHROME_PATH 可指定 Chrome；E2E_SKIP_BUILD=1 沿用現有的 dist）
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '../..');
const artifacts = resolve(root, 'e2e/.artifacts');
// 專案慣例：UI 的診斷截圖集中放在 web 的 e2e 產物資料夾
const diagnostics = resolve(repoRoot, 'apps/web/e2e/.artifacts/diagnostics');
const SCALE = Number(process.env.E2E_TIMEOUT_SCALE ?? 2);
mkdirSync(artifacts, { recursive: true });

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Amy',
  GIT_AUTHOR_EMAIL: 'amy@example.test',
  GIT_COMMITTER_NAME: 'Amy',
  GIT_COMMITTER_EMAIL: 'amy@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
let tick = 0;
const T0 = Date.UTC(2026, 0, 1);
const git = (cwd, ...args) => {
  const date = new Date(T0 + tick++ * 3_600_000).toISOString();
  return execFileSync('git', args, {
    cwd,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
  }).trim();
};
const commit = (cwd, subject) => git(cwd, 'commit', '--allow-empty', '-q', '-m', subject);
const gitCount = (cwd) => Number(git(cwd, 'rev-list', '--all', '--count'));
/** 畫面最上面那一列：所有 ref 裡最新的 commit */
const newest = (cwd) => git(cwd, 'log', '--all', '--date-order', '-1', '--format=%H');

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitUntil(fn, ms, what) {
  const until = Date.now() + ms * SCALE;
  let last;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

let step = 0;
const steps = [];
async function check(name, fn) {
  step++;
  const t = Date.now();
  await fn();
  steps.push(name);
  console.log(`  ✓ ${String(step).padStart(2)} ${name} (${Date.now() - t}ms)`);
}

// ───────────────────────── 建置與打包 ─────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'agg-cli-e2e-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (!process.env.E2E_SKIP_BUILD)
  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });
// --ignore-scripts：上面剛建置過，不要再讓 prepack 建一次
const packed = JSON.parse(
  execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp], {
    cwd: root,
    encoding: 'utf8',
  }),
)[0];
const pkgDir = join(tmp, 'package');
execFileSync('tar', ['-xzf', join(tmp, packed.filename), '-C', tmp]);
const bin = join(pkgDir, 'bin/adorable-git-graph.mjs');

// ───────────────────────── 暫時 git repo ─────────────────────────

const parent = join(tmp, 'code');
const repoA = join(parent, 'alpha');
const repoB = join(parent, 'beta');
for (const dir of [repoA, repoB]) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
}
for (let i = 1; i <= 24; i++) commit(repoA, `feat: alpha change ${i}`);
git(repoA, 'checkout', '-q', '-b', 'feat/x');
for (let i = 1; i <= 3; i++) commit(repoA, `fix: side change ${i}`);
git(repoA, 'checkout', '-q', 'main');
git(repoA, 'tag', 'v1.0.0');
for (let i = 1; i <= 5; i++) commit(repoB, `chore: beta change ${i}`);
mkdirSync(join(parent, 'not-a-repo'));

// ───────────────────────── 執行 ─────────────────────────

const port = await freePort();
const stateFile = join(tmp, 'state/local-repos.json');
let cli;
let output = '';
let browser;
let page;
let other;
const consoleErrors = [];

const startCli = (args, env = {}) => {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, AGG_LOCAL_REPOS_FILE: stateFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return child;
};
const runCli = (args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};

/** 不經瀏覽器送請求（可以偽造 Host）。 */
const rawGet = (path, headers = {}) =>
  new Promise((ok, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => ok(res.statusCode));
    });
    req.on('error', fail);
    req.end();
  });

try {
  console.log(`adorable-git-graph e2e · ${packed.filename}`);

  await check('tarball 只含 bin / dist / LICENSE / README / package.json', async () => {
    const files = packed.files.map((f) => f.path).sort();
    for (const f of files)
      assert.match(
        f,
        /^(bin\/|dist\/|LICENSE$|README\.md$|package\.json$)/,
        `unexpected file in tarball: ${f}`,
      );
    for (const f of [
      'bin/adorable-git-graph.mjs',
      'dist/server.mjs',
      'dist/web/index.html',
      'LICENSE',
      'README.md',
    ])
      assert.ok(files.includes(f), `missing ${f}`);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.license, 'Apache-2.0');
    assert.equal(pkg.dependencies, undefined, 'the package must have no runtime dependencies');
    assert.match(readFileSync(join(pkgDir, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
  });

  await check('bundle 不含任何 git 歷史', async () => {
    const ownSubject = git(repoRoot, 'log', '-1', '--format=%s');
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(join(pkgDir, 'dist'))) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes(ownSubject), `${file} contains this repository's history`);
      assert.ok(!text.includes('alpha change'), `${file} contains test history`);
    }
  });

  await check('--help / --version / 不認得的選項', async () => {
    const help = runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /Usage: adorable-git-graph/);
    assert.equal(
      runCli(['--version']).out.trim(),
      JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version,
    );
    const bad = runCli(['--nope']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /Unknown option: --nope/);
    assert.equal(runCli(['--port', '99999']).code, 1);
  });

  cli = startCli([repoA, '--port', String(port), '--no-open'], { AGG_REPO_ROOTS: parent });
  const base = `http://127.0.0.1:${port}/`;
  await waitUntil(() => output.includes(base), 20_000, 'the CLI to print its URL');

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
  ctx.setDefaultTimeout(30_000 * SCALE);
  page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const commitCount = async () => {
    const t = await page
      .locator('.agg-chip--commits')
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    return Number(/^(\d+)/.exec(t ?? '')?.[1] ?? NaN);
  };
  const waitForCommits = (n) =>
    waitUntil(async () => (await commitCount()) === n, 25_000, `commit chip to show ${n}`);
  const firstRow = () => page.locator('.agg-commit').first().getAttribute('data-sha');

  await check('畫面顯示預設 repo 的完整歷史（最新在最上面）', async () => {
    await page.goto(base);
    await waitForCommits(gitCount(repoA));
    assert.equal(await firstRow(), newest(repoA));
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
    await page.screenshot({ path: join(artifacts, 'cli-default.png') });
  });

  await check('git commit 後經 SSE 即時更新，不重新整理', async () => {
    await page.evaluate(() => (window.__aggMarker = 1));
    commit(repoA, 'feat: live from the terminal');
    await waitForCommits(gitCount(repoA));
    await waitUntil(
      async () => (await firstRow()) === newest(repoA),
      10_000,
      'the new commit on top',
    );
    assert.equal(await page.evaluate(() => window.__aggMarker), 1, 'the page must not reload');
  });

  await check('本機 repo 選單：切換到同層的 repo，它的 commit 也即時更新', async () => {
    const select = page.locator('select.web-select');
    await waitUntil(
      async () => (await select.locator('option').allInnerTexts()).some((t) => t.includes('beta')),
      20_000,
      'beta in the repository menu',
    );
    const options = await select.locator('option').allInnerTexts();
    assert.ok(!options.some((t) => t.includes('not-a-repo')), 'folders without git are not listed');
    const value = await select.locator('option', { hasText: 'beta' }).getAttribute('value');
    await select.selectOption(value);
    await waitUntil(
      () => page.url().includes(`local=${value}`),
      10_000,
      'the URL to carry the repo id',
    );
    await waitForCommits(gitCount(repoB));
    commit(repoB, 'chore: beta live');
    await waitForCommits(gitCount(repoB));
    await waitUntil(
      async () => (await firstRow()) === newest(repoB),
      10_000,
      'the beta commit on top',
    );
    await page.goBack();
    await waitForCommits(gitCount(repoA));
  });

  await check('其他 origin 的頁面讀不到 endpoint 與 SSE', async () => {
    const otherPort = await freePort();
    other = createHttpServer((_, res) => res.end('<!doctype html><title>other</title>'));
    await new Promise((r) => other.listen(otherPort, '127.0.0.1', r));
    const evil = await ctx.newPage();
    await evil.goto(`http://127.0.0.1:${otherPort}/`);
    const result = await evil.evaluate(async (target) => {
      const tryFetch = (path, init) =>
        fetch(target + path, init).then(
          (r) => `status ${r.status}`,
          () => 'blocked',
        );
      return {
        snapshot: await tryFetch('__agg/git-snapshot'),
        repos: await tryFetch('__agg/repos'),
        noCors: await tryFetch('__agg/git-snapshot', { mode: 'no-cors' }),
        events: await new Promise((done) => {
          const es = new EventSource(`${target}__agg/events`);
          es.onmessage = () => done('received');
          es.onerror = () => done('blocked');
          setTimeout(() => done('timeout'), 5000);
        }),
      };
    }, base);
    assert.equal(result.snapshot, 'blocked');
    assert.equal(result.repos, 'blocked');
    assert.equal(result.events, 'blocked');
    await evil.close();
    // no-cors 拿得到的只是 opaque response：再確認 server 本身就拒絕了跨來源的請求
    assert.equal(
      await rawGet('/__agg/git-snapshot', { origin: `http://127.0.0.1:${otherPort}` }),
      403,
    );
    assert.equal(await rawGet('/__agg/events', { 'sec-fetch-site': 'cross-site' }), 403);
  });

  await check('偽造 Host 403、路徑穿越 404、只綁 127.0.0.1', async () => {
    assert.equal(await rawGet('/', { host: `evil.example:${port}` }), 403);
    assert.equal(await rawGet('/__agg/git-snapshot', { host: `evil.example:${port}` }), 403);
    assert.equal(await rawGet('/../package.json'), 404);
    assert.equal(await rawGet('/%2e%2e/package.json'), 404);
    assert.equal(await rawGet('/assets/..%2f..%2fserver.mjs'), 404);
    assert.equal(await rawGet('/'), 200);
    // 區網位址連不進來（沒有非 loopback 的介面就略過這一項）
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (lan) {
      const refused = await new Promise((ok) => {
        const req = httpRequest({ host: lan, port, path: '/', timeout: 3000 }, () => ok(false));
        req.on('error', () => ok(true));
        req.on('timeout', () => req.destroy());
        req.end();
      });
      assert.ok(refused, `${lan}:${port} must not accept connections`);
    }
  });

  await check('沒有 console 錯誤', async () => {
    assert.deepEqual(consoleErrors, []);
  });

  await check('Ctrl+C（SIGINT）正常結束', async () => {
    const exited = new Promise((r) => cli.once('exit', (code) => r(code)));
    cli.kill('SIGINT');
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r('timeout'), 5000 * SCALE)),
    ]);
    assert.equal(code, 0);
    cli = undefined;
  });

  console.log(`\nall ${steps.length} steps passed`);
} catch (err) {
  console.error(`\n✗ step ${step} failed: ${err.stack ?? err}`);
  console.error(`\nCLI output:\n${output}`);
  if (page) {
    mkdirSync(diagnostics, { recursive: true });
    const shot = join(diagnostics, `cli-step-${step}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    writeFileSync(join(diagnostics, `cli-step-${step}.log`), `${err.stack ?? err}\n\n${output}`);
    console.error(`diagnostics: ${shot}`);
  }
  process.exitCode = 1;
} finally {
  cli?.kill('SIGKILL');
  other?.close();
  await browser?.close();
  rmSync(tmp, { recursive: true, force: true });
}
