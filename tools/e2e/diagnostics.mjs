// Isolated real-browser acceptance for the read-only workflow. Never uses the user's browser profile.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { findChrome } from './chrome-path.mjs';
import { fakeGithubPage, startFakeGithub } from './fake-github-page.mjs';
import { OUTSIDE_SHA, sha, seen, latency, startMock } from './mock-github-api.mjs';
import { inkRatio } from './pixels.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = require('playwright-core');
const mode = process.argv[2] ?? 'local';
assert(['local', 'chrome', 'firefox'].includes(mode));
const owned = mkdtempSync(resolve(tmpdir(), 'agg-diagnostic-e2e-'));
const artifacts = resolve(
  root,
  `apps/${mode === 'local' ? 'web' : mode === 'chrome' ? 'extension' : 'extension-firefox'}/e2e/.artifacts/diagnostics`,
);
mkdirSync(artifacts, { recursive: true });
const errors = [];
let browser, server, fake, child, ctx, background, setToken;
const token = 'fixture-diagnostic-token';
const git = (...args) =>
  execFileSync('git', args, {
    cwd: owned,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    encoding: 'utf8',
  }).trim();
const fixture = () => {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgSign', 'false');
  writeFileSync(resolve(owned, 'root.txt'), 'root\n');
  git('add', '.');
  git('commit', '-q', '-m', 'root');
  git('checkout', '-q', '-b', 'topic');
  writeFileSync(resolve(owned, 'diagnostic.txt'), 'diagnostic change\n');
  git('add', '.');
  git('commit', '-q', '-m', 'topic');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(resolve(owned, 'main.txt'), 'main\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main');
  return head;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label) => {
  const end = Date.now() + 20000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await sleep(100);
  }
};
const kit = (fn) => `(${fn.toString()})`;
let page;
const ui = async (fn, arg) =>
  page.evaluate(
    ({ source, arg, mode }) => {
      const root =
        mode === 'local'
          ? document
          : document.querySelector('#adorable-git-graph-host')?.shadowRoot;
      return (0, eval)(source)(root, arg);
    },
    { source: kit(fn), arg, mode },
  );
const click = (selector) =>
  ui((r, s) => {
    const el = r.querySelector(s);
    if (!el) throw new Error(`Missing ${s}`);
    el.click();
  }, selector);
const text = () => ui((r) => r.querySelector('.agg-root')?.textContent ?? '');
// Sample only the empty DOM graph cell, away from its row borders. Its ink must come from WebGL.
const assertGraphPaint = async (label) => {
  let ratio = 0;
  await wait(async () => {
    const clip = await ui((r) => {
      const viewport = r.querySelector('.agg-scroll')?.getBoundingClientRect();
      if (!viewport || !r.querySelector('.agg-canvas canvas')) return null;
      const row = [...r.querySelectorAll('.agg-commit')].find((el) => {
        const b = el.getBoundingClientRect();
        return b.top >= viewport.top && b.bottom <= viewport.bottom;
      });
      const bounds = row?.getBoundingClientRect();
      const cell = row?.querySelector('.agg-c-g')?.getBoundingClientRect();
      return cell && bounds && cell.width > 8 && bounds.height > 20
        ? { x: cell.left + 2, y: bounds.top + 8, width: cell.width - 4, height: bounds.height - 16 }
        : null;
    });
    if (!clip) return false;
    ratio = await inkRatio(page, await page.screenshot({ clip }));
    return ratio > 0.01;
  }, `${label}: WebGL ink in a visible graph row`);
  console.log(`${label} graph ink ratio: ${ratio.toFixed(4)}`);
};
const input = async (side, value) =>
  ui(
    (r, { side, value }) => {
      const input = r.querySelector(`.agg-diag-compare input[aria-label="${side}"]`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    },
    { side, value },
  );
try {
  server = await startMock();
  const api = `http://127.0.0.1:${server.address().port}`;
  if (mode === 'local') {
    const head = fixture();
    child = spawn(
      process.execPath,
      [resolve(root, 'tools/start.mjs'), '--repo', owned, '--port', '4277'],
      {
        cwd: root,
        env: {
          ...process.env,
          AGG_REPO_DIR: owned,
          AGG_REPO_ROOTS: owned,
          AGG_LOCAL_REPOS_FILE: resolve(owned, 'state.json'),
          VITE_GITHUB_API_BASE: api,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    console.log(`Owned launcher PID ${child.pid}, cwd project, port 4277`);
    await wait(async () => {
      try {
        return (await fetch('http://localhost:4277')).ok;
      } catch {
        return false;
      }
    }, 'local server');
    browser = await chromium.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    page = await ctx.newPage();
    await page.goto('http://localhost:4277');
    setToken = async (value) =>
      page.evaluate((token) => localStorage.setItem('agg.github-token', token), value);
    await setToken(token);
    await wait(() => ui((r) => r.querySelectorAll('.agg-commit').length === 3), 'fixture graph');
    await click('.agg-diag-toggle');
    await input('Base', 'main');
    await input('Head', 'topic');
    await click('.agg-diag-compare button');
    await wait(async () => (await text()).includes('Head-only commits'), 'source comparison');
    assert((await text()).includes(head));
    await click('.agg-diag-files button');
    await wait(
      () =>
        ui((r) =>
          r.querySelector('.agg-diag-patch pre')?.textContent.includes('+diagnostic change'),
        ),
      'lazy diff',
    );
    await ui((r) => r.querySelector('.agg-diag-patch').scrollIntoView({ block: 'nearest' }));
    await page.screenshot({ path: resolve(artifacts, 'local-compare.png') });
    // Client path injection and cross-origin reads remain rejected.
    const forbidden = await fetch('http://localhost:4277/__agg/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ operation: 'compare', base: 'main', head: 'topic' }),
    });
    assert.equal(forbidden.status, 403);
    await page.goto(`http://localhost:4277/?repo=demo/adorable-git-graph&pull=7`);
  } else {
    const extension = resolve(owned, 'extension');
    execFileSync(process.execPath, ['scripts/build.mjs'], {
      cwd: resolve(root, `apps/${mode === 'chrome' ? 'extension' : 'extension-firefox'}`),
      env: {
        ...process.env,
        AGG_API_BASE: api,
        AGG_OUT_DIR: extension,
        AGG_DEV: '1',
        ...(mode === 'firefox' ? { AGG_EXTRA_MATCH: 'http://127.0.0.1/*' } : {}),
      },
      stdio: 'pipe',
    });
    if (mode === 'chrome') {
      ctx = await chromium.launchPersistentContext(resolve(owned, 'profile'), {
        executablePath: findChrome(),
        headless: false,
        viewport: { width: 1280, height: 850 },
        args: [
          '--headless=new',
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ],
      });
      browser = ctx.browser();
      background =
        ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
      setToken = (value) =>
        background.evaluate((token) => chrome.storage.local.set({ settings: { token } }), value);
      await setToken(token);
      await ctx.route('https://github.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: fakeGithubPage('diagnostics'),
        }),
      );
      page = await ctx.newPage();
      await page.goto('https://github.com/demo/adorable-git-graph/pull/7');
    } else {
      const fx = await import('../../apps/extension-firefox/e2e/firefox.mjs');
      const { GECKO_ID } = await import('../../libs/extension-core/scripts/manifest.mjs');
      ({ browser } = await fx.launchFirefox({
        firefox: fx.findFirefox(),
        extDir: extension,
        geckoId: GECKO_ID,
        uuid: '8d6f1c2e-4b7a-4c1e-9a3d-2f5e7b9c0a11',
      }));
      const options = await fx.openExtensionPage(
        browser,
        '8d6f1c2e-4b7a-4c1e-9a3d-2f5e7b9c0a11',
        'options.html',
      );
      background = await fx.backgroundHandle(options);
      setToken = (value) =>
        background.evaluate(
          (w, token) => w.chrome.storage.local.set({ settings: { token } }),
          value,
        );
      await setToken(token);
      fake = await startFakeGithub();
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 850 });
      await page.goto(`http://127.0.0.1:${fake.address().port}/demo/adorable-git-graph/pull/7`);
    }
    await wait(() => ui((r) => Boolean(r?.querySelector('.agg-fab'))), 'extension FAB');
    await click('.agg-fab');
  }
  page.on('pageerror', (e) => errors.push(e.message));
  await wait(async () => (await text()).includes('Diagnostic PR'), 'PR context');
  await click('.agg-diag-section > button'); // Explicitly select immutable PR refs.
  await click('.agg-diag-compare button');
  await wait(async () => (await text()).includes('Head-only commits'), 'PR comparison');
  assert((await text()).includes(sha('m13')));
  assert((await text()).includes(OUTSIDE_SHA));
  await click('.agg-diag-files button');
  await wait(
    () =>
      ui((r) => r.querySelector('.agg-diag-patch pre')?.textContent.includes('+diagnostic change')),
    'PR lazy patch',
  );
  assert(seen.auth.includes(`Bearer ${token}`));
  assert(!(await text()).includes(token));
  assert(!page.url().includes(token));
  assert(!seen.paths.some((p) => p.includes(token)));
  const patchCalls = seen.paths.filter((p) => p.includes('/compare/')).length;
  await ui((r, sha) => r.querySelector(`.agg-commit[data-sha="${sha}"]`).click(), sha('m13'));
  await wait(
    () =>
      ui((r, sha) => {
        const s = [...r.querySelectorAll('.agg-diag-section')].find((s) =>
          s.querySelector('select'),
        );
        return s?.textContent.includes(sha);
      }, sha('m13')),
    'initial graph selection',
  );
  const outsideButton = await ui((r, sha) => {
    const buttons = [...r.querySelectorAll('.agg-diag-commits button')];
    const b = buttons.find((b) => b.textContent.includes(sha));
    if (!b) return false;
    b.click();
    return true;
  }, OUTSIDE_SHA);
  assert(outsideButton, 'outside graph commit remains inspectable');
  await wait(
    () =>
      ui((r, sha) => {
        const s = [...r.querySelectorAll('.agg-diag-section')].find((s) =>
          s.querySelector('select'),
        );
        return s?.textContent.includes(sha);
      }, OUTSIDE_SHA),
    'outside graph changes',
  );
  await ui((r) => r.querySelector('.agg-root').focus());
  await page.keyboard.press('Home');
  await wait(
    () =>
      ui((r, sha) => {
        const s = [...r.querySelectorAll('.agg-diag-section')].find((s) =>
          s.querySelector('select'),
        );
        return s?.textContent.includes(sha) && !s?.textContent.includes('outside graph window');
      }, sha('m13')),
    'graph selection clears outside inspection',
  );
  // Closing/reopening and a pending patch/compare must not leave controls stuck busy.
  latency.ms = 1000;
  await click('.agg-diag-compare button');
  await click('.agg-diag-toggle');
  latency.ms = 0;
  await click('.agg-diag-toggle');
  await wait(
    () => ui((r) => !r.querySelector('.agg-diag-compare button').disabled),
    'cancel/reopen',
  );
  await click('.agg-diag-compare button');
  await wait(async () => (await text()).includes('Head-only commits'), 'retry');
  await click('.agg-diag-files button');
  await wait(() => ui((r) => Boolean(r.querySelector('.agg-diag-patch pre'))), 'patch retry');
  assert(seen.paths.filter((p) => p.includes('/compare/')).length > patchCalls);
  await click('.agg-actions button[aria-pressed]');
  assert(await ui((r) => r.querySelector('.agg-root').hasAttribute('data-reduced-motion')));
  // Commit URL changes preserve the new context, including commits outside the visible graph.
  const commitUrl =
    mode === 'local'
      ? `http://localhost:4277/?repo=demo/adorable-git-graph&commit=${sha('f1')}`
      : mode === 'chrome'
        ? `https://github.com/demo/adorable-git-graph/commit/${sha('f1')}`
        : `http://127.0.0.1:${fake.address().port}/demo/adorable-git-graph/commit/${sha('f1')}`;
  if (mode === 'local') await page.goto(commitUrl);
  else {
    await page.evaluate((url) => {
      history.pushState({}, '', url);
      document.dispatchEvent(new Event('turbo:load'));
    }, commitUrl);
  }
  await wait(
    async () => (await text()).includes('parent → commit:') && (await text()).includes(sha('f1')),
    'commit context change',
  );
  await ui((r) =>
    r.querySelector('.agg-diag-section select')?.scrollIntoView({ block: 'nearest' }),
  );
  await assertGraphPaint(`${mode} desktop diagnostics with motion off`);
  await page.screenshot({ path: resolve(artifacts, `${mode}-commit.png`) });
  if (mode === 'local') await page.setViewportSize({ width: 390, height: 720 });
  else if (mode === 'chrome') await page.setViewportSize({ width: 390, height: 720 });
  else await page.setViewport({ width: 390, height: 720 });
  await wait(
    () => ui((r) => r.querySelector('.agg-root')?.getAttribute('data-size') === 'narrow'),
    'responsive layout',
  );
  assert(
    await ui((r) => {
      const el = r.querySelector('.agg-root');
      return el.scrollWidth <= el.clientWidth + 1;
    }),
  );
  await assertGraphPaint(`${mode} mobile diagnostics with motion off`);
  await page.screenshot({ path: resolve(artifacts, `${mode}-mobile.png`) });
  // Basic repo focus survives reload/overlay close and reopen.
  const searchQuery = 'feat';
  await ui((r, value) => {
    const el = r.querySelector('.agg-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }, searchQuery);
  await ui((r) => r.querySelector('.agg-branches button').click());
  const focusBefore = await ui((r) => ({
    query: r.querySelector('.agg-search input').value,
    branch: r.querySelector('.agg-branches button[aria-pressed="true"]')?.textContent,
    selected: r.querySelector('.agg-commit[data-selected]')?.dataset.sha,
  }));
  if (mode === 'local') {
    await page.reload();
    await wait(() => ui((r) => Boolean(r.querySelector('.agg-commit'))), 'reload focus');
  } else {
    await click('.agg-actions .agg-btn--danger');
    await wait(() => ui((r) => Boolean(r.querySelector('.agg-fab'))), 'closed FAB');
    await click('.agg-fab');
    await wait(() => ui((r) => Boolean(r.querySelector('.agg-commit'))), 'reopen focus');
  }
  assert.deepEqual(
    await ui((r) => ({
      query: r.querySelector('.agg-search input').value,
      branch: r.querySelector('.agg-branches button[aria-pressed="true"]')?.textContent,
      selected: r.querySelector('.agg-commit[data-selected]')?.dataset.sha,
    })),
    focusBefore,
  );
  if (mode !== 'local') {
    const before = seen.auth.length,
      beforeCalls = seen.paths.length;
    await setToken('');
    await wait(
      () => seen.paths.slice(beforeCalls).some((p) => p.includes('/commits?')),
      'settings invalidation',
    );
    await wait(
      () => ui((r) => Boolean(r.querySelector('.agg-diag-compare button'))),
      'settings reset',
    );
    await click('.agg-diag-compare button');
    await wait(async () => (await text()).includes('Head-only commits'), 'token scope refresh');
    assert.equal(seen.auth.length, before);
    assert(!(await text()).includes(token));
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${mode}: pinned comparison, lazy diff, PR, context change, cancellation, motion, responsive layout, token scope`,
  );
} catch (error) {
  if (page) {
    console.error(
      'Failure state:',
      await ui((r) => ({
        hidden: document.hidden,
        text: r.querySelector('.agg-root')?.textContent.slice(0, 1800),
        canvas: r.querySelector('.agg-canvas')?.dataset,
        hasWebGL: Boolean(r.querySelector('.agg-canvas canvas')),
      })).catch(() => null),
    );
    await page
      .screenshot({ path: resolve(artifacts, `${mode}-failure.png`), timeout: 5000 })
      .catch(() => {});
  }
  console.error('Last fixture requests:', seen.paths.slice(-12));
  console.error('Page errors:', errors);
  throw error;
} finally {
  latency.ms = 0;
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  if (fake) await new Promise((r) => fake.close(r));
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  rmSync(owned, { recursive: true, force: true });
}
