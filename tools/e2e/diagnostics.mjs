// Isolated real-browser acceptance for the read-only workflow. Never uses the user's browser profile.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { findChrome } from './chrome-path.mjs';
import { fakeGithubPage, startFakeGithub } from './fake-github-page.mjs';
import { OUTSIDE_SHA, sha, seen, latency, startMock } from './mock-github-api.mjs';
import { inkRatio } from './pixels.mjs';
import { cleanupViewerScope, prepareViewerScope, verifyViewerScope } from './viewer-scope.mjs';
import { buildLanBundle, verifyCrossTabAuth, verifyLanHttp } from './app-auth-isolation.mjs';
import { verifyFirefoxApp } from './app-auth-firefox.mjs';
import { verifyThemes } from './themes.mjs';
import { verifyFirefoxCleanup } from './app-auth-firefox-cleanup.mjs';
import {
  cleanupWebSourceIdentity,
  prepareWebSourceIdentity,
  verifyWebSourceIdentity,
} from './source-identity.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'apps/web/package.json'));
const { chromium } = require('playwright-core');
const mode = process.argv[2] ?? 'local';
assert(['local', 'chrome', 'firefox'].includes(mode));
const owned = mkdtempSync(resolve(tmpdir(), 'agg-diagnostic-e2e-'));
console.log(
  JSON.stringify({
    owner: 'isolated diagnostic E2E',
    mode,
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date().toISOString(),
    cwd: root,
    command: process.argv,
    temporaryDirectory: owned,
  }),
);
const artifacts = resolve(
  root,
  `apps/${mode === 'local' ? 'web' : mode === 'chrome' ? 'extension' : 'extension-firefox'}/e2e/.artifacts/diagnostics`,
);
mkdirSync(artifacts, { recursive: true });
const errors = [];
let browser, server, fake, child, ctx, background, setToken, lanBundle, xvfb;
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
        return Math.min(b.bottom, viewport.bottom) - Math.max(b.top, viewport.top) >= 24;
      });
      const bounds = row?.getBoundingClientRect();
      const cell = row?.querySelector('.agg-c-g')?.getBoundingClientRect();
      const top = bounds ? Math.max(bounds.top, viewport.top) : 0;
      const bottom = bounds ? Math.min(bounds.bottom, viewport.bottom) : 0;
      return cell && bounds && cell.width > 8 && bottom - top >= 24
        ? { x: cell.left + 2, y: top + 8, width: cell.width - 4, height: bottom - top - 16 }
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

// Mount the shipped App, SourceBar and TokenDialog unchanged. The Profiler
// records committed DOM, including frames before passive effects can run.
const appScopeFiles = ['app-scope.html', 'app-scope.mjs'].map((p) => resolve(artifacts, p));
function prepareAppScope() {
  writeFileSync(
    appScopeFiles[0],
    '<!doctype html><html><body><div id="root"></div><script type="module" src="./app-scope.mjs"></script></body></html>',
  );
  writeFileSync(
    appScopeFiles[1],
    `
import React,{StrictMode,Profiler} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '/src/App.tsx';
import '@adorable/graph-ui/viewer.css';
import '/src/styles.css';
const host=document.getElementById('root');
window.__aggAppFrames=[];
createRoot(host).render(React.createElement(StrictMode,null,React.createElement(Profiler,{id:'shipped-app',onRender(){
 const p=new URLSearchParams(location.search);
 window.__aggAppFrames.push({repo:p.get('repo'),context:p.get('commit'),title:host.querySelector('.agg-title-text')?.textContent,
  ready:!!host.querySelector('.agg-commit'),selected:host.querySelector('.agg-commit[data-selected="true"]')?.dataset.sha??null,
  files:[...host.querySelectorAll('.agg-diag-files button')].map(x=>x.textContent),
  patch:host.querySelector('.agg-diag-patch pre')?.textContent??null});
}},React.createElement(App))));
`,
  );
}
async function verifyAppScope(api) {
  const nonceKey = 'agg:viewer-auth-nonce:v1',
    selected = '1'.repeat(40),
    context = '2'.repeat(40);
  const tokenA = 'fixture-app-auth-a',
    tokenB = 'fixture-app-auth-b';
  const calls = [],
    results = [];
  const routePattern = api + '/repos/app-*/fixture**';
  await ctx.route(routePattern, async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      parts = url.pathname.split('/'),
      owner = parts[2];
    const auth = req.headers().authorization;
    const scope =
      auth === `Bearer ${tokenA}` ? 'a' : auth === `Bearer ${tokenB}` ? 'b' : 'anonymous';
    const commit = (sha) => ({
      sha,
      parents: sha === selected ? [{ sha: context }] : [],
      commit: {
        message: 'App scope ' + owner,
        author: { name: 'Fixture', date: '2026-01-01T00:00:00Z' },
      },
      author: { login: 'fixture' },
    });
    let body;
    if (/\/commits\/[a-f0-9]{40}$/.test(url.pathname)) {
      calls.push({ owner, scope, requested: parts.at(-1) });
      body = {
        ...commit(parts.at(-1)),
        files: [
          {
            filename: owner + '.txt',
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: '@@ -0,0 +1 @@\n+' + owner + ':' + scope,
          },
        ],
      };
    } else if (url.pathname.endsWith('/commits')) body = [commit(selected), commit(context)];
    else if (url.pathname.endsWith('/branches'))
      body = [{ name: 'main', commit: { sha: selected } }];
    else if (url.pathname.endsWith('/tags') || url.pathname.endsWith('/pulls')) body = [];
    else
      body = {
        name: 'fixture',
        default_branch: 'main',
        html_url: 'https://github.com/' + owner + '/fixture',
      };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.addInitScript(
    ({ nonceKey }) => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem,
        remove = Storage.prototype.removeItem;
      const tokenKey = 'agg.github-token';
      const initial = (k) => get.call(sessionStorage, 'agg:test:' + k) === '1';
      window.__aggStorageFault = {
        tokenGet: initial('tokenGet'),
        nonceGet: initial('nonceGet'),
        nonceSet: initial('nonceSet'),
      };
      window.__aggStorageInspect = {
        token: () => get.call(localStorage, tokenKey),
        nonce: () => get.call(sessionStorage, nonceKey),
      };
      Storage.prototype.getItem = function (k) {
        const f = window.__aggStorageFault;
        if (
          this === localStorage &&
          k === tokenKey &&
          (f.tokenGet || (f.tokenReadAfterWrite && f.tokenWritten))
        )
          throw new Error('fixture token read blocked');
        if (
          this === sessionStorage &&
          k === nonceKey &&
          (f.nonceGet || (f.nonceReadAfterWrite && f.nonceWritten))
        )
          throw new Error('fixture nonce read blocked');
        return get.call(this, k);
      };
      Storage.prototype.setItem = function (k, v) {
        const f = window.__aggStorageFault;
        if (this === localStorage && k === tokenKey && f.tokenSet)
          throw new Error('fixture token write blocked');
        if (this === sessionStorage && k === nonceKey && f.nonceSet)
          throw new Error('fixture nonce write blocked');
        set.call(this, k, v);
        if (this === localStorage && k === tokenKey) f.tokenWritten = true;
        if (this === sessionStorage && k === nonceKey) f.nonceWritten = true;
      };
      Storage.prototype.removeItem = function (k) {
        const f = window.__aggStorageFault;
        if (this === localStorage && k === tokenKey && f.tokenRemove)
          throw new Error('fixture token removal blocked');
        remove.call(this, k);
        if (this === localStorage && k === tokenKey) f.tokenWritten = true;
      };
    },
    { nonceKey },
  );
  const ready = (owner) =>
    wait(
      () =>
        page.evaluate(
          (owner) =>
            document.querySelector('.agg-title-text')?.textContent === owner + '/fixture' &&
            document.querySelectorAll('.agg-commit').length === 2,
          owner,
        ),
      'actual App ready ' + owner,
    );
  const go = async (owner, commit) => {
    await page
      .locator('.web-form input')
      .fill(commit ? `https://github.com/${owner}/fixture/commit/${commit}` : `${owner}/fixture`);
    await page.locator('.web-form button[type="submit"]').click();
    await ready(owner);
  };
  const select = async () => {
    await page.locator(`.agg-commit[data-sha="${selected}"]`).click();
    if ((await page.locator('.agg-diag-toggle').getAttribute('aria-expanded')) !== 'true')
      await page.locator('.agg-diag-toggle').click();
    await wait(
      () => page.evaluate(() => !!document.querySelector('.agg-diag-files button')),
      'actual App selected changes',
    );
  };
  const openSettings = () => page.locator('.agg-actions button').last().click();
  const save = async (value) => {
    if (!(await page.locator('.web-dialog').count())) await openSettings();
    await page.locator('.web-dialog input').fill(value);
    await page.locator('.web-dialog button[type="submit"]').click();
  };
  const clear = async () => {
    if (!(await page.locator('.web-dialog').count())) await openSettings();
    await page.locator('.web-dialog button[type="button"]').first().click();
  };
  const closed = () =>
    wait(
      () =>
        page
          .locator('.web-dialog')
          .count()
          .then((n) => n === 0),
      'actual TokenDialog saved',
    );
  const fault = (v) =>
    page.evaluate((v) => {
      window.__aggStorageFault = v;
    }, v);
  const inspect = () =>
    page.evaluate(() => ({
      token: window.__aggStorageInspect.token(),
      nonce: window.__aggStorageInspect.nonce(),
    }));
  const resetFrames = () =>
    page.evaluate(() => {
      window.__aggAppFrames.length = 0;
    });
  const noOldFocus = async (label, from) => {
    await ready('app-a');
    await sleep(120);
    const frames = await page.evaluate(() =>
      window.__aggAppFrames.filter((f) => f.repo === 'app-a/fixture' && f.ready),
    );
    assert(frames.length > 0, label + ': ready frames observed');
    assert(
      frames.every((f) => f.selected === null && f.files.length === 0 && !f.patch),
      label + ': no old selection/results in any committed frame',
    );
    assert(
      !calls.slice(from).some((c) => c.owner === 'app-a' && c.requested === selected),
      label + ': old SHA never reaches the new adapter',
    );
    results.push({ label, readyFrames: frames.length, oldSelectionRequests: 0 });
  };
  const visibleError = () =>
    wait(
      () =>
        page
          .locator('.web-dialog [role="alert"]')
          .count()
          .then((n) => n === 1),
      'visible storage failure',
    );
  try {
    await page.evaluate((token) => localStorage.setItem('agg.github-token', token), tokenA);
    await page.goto(
      'http://localhost:4277/e2e/.artifacts/diagnostics/app-scope.html?repo=app-a/fixture',
    );
    await ready('app-a');
    await select();
    const first = await inspect();
    await page.reload();
    await ready('app-a');
    await wait(
      () =>
        page
          .locator(`.agg-commit[data-selected="true"][data-sha="${selected}"]`)
          .count()
          .then((n) => n === 1),
      'same auth same URL manual focus restored',
    );
    assert.equal((await inspect()).nonce, first.nonce);
    results.push({ label: 'same-auth same-URL reload restores manual focus', passed: true });
    await go('app-b');
    await save(tokenB);
    await closed();
    await resetFrames();
    let from = calls.length;
    await go('app-a');
    await noOldFocus('A→B→change token→A', from);
    await page.reload();
    await noOldFocus('changed token same-tab reload', from);
    const focus = await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([k]) => k.startsWith('agg:focus:') && k.includes('app-a/fixture'))
        .map(([, v]) => JSON.parse(v)),
    );
    assert(
      focus.length > 0 &&
        focus.every(
          (f) =>
            typeof f.viewerStateKey === 'string' &&
            f.viewerStateKey.length > 0 &&
            !f.viewerStateKey.includes('fixture-app-auth'),
        ),
      'nonsecret nonempty actual App viewer key',
    );
    await select();
    await go('app-b');
    await clear();
    await closed();
    await resetFrames();
    from = calls.length;
    await go('app-a');
    await noOldFocus('A→B→clear token→A', from);
    await page.reload();
    await noOldFocus('cleared token same-tab reload', from);
    await select();
    await resetFrames();
    from = calls.length;
    await go('app-a', context);
    await wait(
      () =>
        page
          .locator(`.agg-commit[data-selected="true"][data-sha="${context}"]`)
          .count()
          .then((n) => n === 1),
      'URL context takes priority',
    );
    const contextFrames = await page.evaluate(() =>
      window.__aggAppFrames.filter((f) => f.context === '2'.repeat(40) && f.ready),
    );
    assert(
      contextFrames.every((f) => f.selected !== '1'.repeat(40)),
      'new URL never resurrects old selected SHA',
    );
    assert(
      !calls.slice(from).some((c) => c.requested === selected),
      'new URL does not request stale manual SHA',
    );
    results.push({ label: 'new commit URL wins over saved manual selection', passed: true });

    // Failure at nonce set, nonce readback, token set and token readback.
    for (const scenario of [
      { label: 'nonce write failure', fault: { nonceSet: true }, partialToken: false },
      {
        label: 'nonce readback failure',
        fault: { nonceReadAfterWrite: true },
        partialToken: false,
      },
      { label: 'token write failure', fault: { tokenSet: true }, partialToken: false },
      {
        label: 'token readback after successful write',
        fault: { tokenReadAfterWrite: true },
        partialToken: true,
      },
    ]) {
      await fault({});
      if (await page.locator('.web-dialog').count())
        await page.locator('.web-dialog button[type="button"]').last().click();
      await go('app-a');
      await save(tokenA);
      await closed();
      await ready('app-a');
      await select();
      await go('app-b');
      await fault(scenario.fault);
      await save(tokenB);
      await visibleError();
      const stored = await inspect();
      assert.equal(
        stored.token,
        scenario.partialToken ? tokenB : tokenA,
        scenario.label + ': persistence outcome reconciled',
      );
      await fault({});
      await page.locator('.web-dialog button[type="button"]').last().click();
      await resetFrames();
      from = calls.length;
      await go('app-a');
      await noOldFocus(scenario.label + ' same-page', from);
      await page.reload();
      await noOldFocus(scenario.label + ' reload', from);
    }
    // Initial TOKEN read failure must not make Clear a same-empty-token no-op.
    await save(tokenB);
    await closed();
    await ready('app-a');
    await select();
    await page.evaluate(() => sessionStorage.setItem('agg:test:tokenGet', '1'));
    await page.reload();
    await ready('app-a');
    await clear();
    await visibleError();
    assert.equal(
      (await inspect()).token,
      tokenB,
      'failed initial read never pretends credential was cleared',
    );
    await fault({});
    await clear();
    await closed();
    assert.equal((await inspect()).token, null, 'retry Clear really removes persistent credential');
    await page.evaluate(() => sessionStorage.removeItem('agg:test:tokenGet'));
    await resetFrames();
    from = calls.length;
    await go('app-b');
    await go('app-a');
    await noOldFocus('initial token read failure then verified Clear', from);
    for (const kind of ['nonceGet', 'nonceSet']) {
      await save(tokenA);
      await closed();
      await ready('app-a');
      await select();
      await page.evaluate(
        ({ kind, nonceKey }) => {
          sessionStorage.setItem('agg:test:' + kind, '1');
          if (kind === 'nonceSet') sessionStorage.removeItem(nonceKey);
        },
        { kind, nonceKey },
      );
      from = calls.length;
      await page.reload();
      await noOldFocus('initial ' + kind + ' failure', from);
      await fault({});
      await page.evaluate((kind) => sessionStorage.removeItem('agg:test:' + kind), kind);
    }
    await page.screenshot({ path: resolve(artifacts, 'actual-app-auth-scope.png') });
    writeFileSync(
      resolve(artifacts, 'actual-app-auth-scope-results.json'),
      JSON.stringify(
        { results, calls, syntheticCredentials: true, realApp: true, firstCommittedFrames: true },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS actual App auth scope: same-URL restore, token change/clear, reload, URL priority, verified storage failures and initial read failures',
    );
  } catch (error) {
    const frames = await page.evaluate(() => window.__aggAppFrames).catch(() => []);
    writeFileSync(
      resolve(artifacts, 'actual-app-auth-scope-failure.json'),
      JSON.stringify(
        {
          results,
          calls,
          frames,
          error: String(error.message),
          syntheticCredentials: true,
          realApp: true,
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    await fault({}).catch(() => {});
    await page
      .evaluate((token) => {
        for (const k of ['tokenGet', 'nonceGet', 'nonceSet'])
          sessionStorage.removeItem('agg:test:' + k);
        localStorage.setItem('agg.github-token', token);
      }, token)
      .catch(() => {});
    await ctx.unroute(routePattern);
  }
}
try {
  server = await startMock();
  const api = `http://127.0.0.1:${server.address().port}`;
  // Local queries and the production snapshot need safe Git reads; the
  // product refuses older Git, so fail early and clearly.
  if (mode !== 'chrome')
    try {
      execFileSync('git', ['--no-lazy-fetch', '--version'], { stdio: 'ignore' });
    } catch {
      throw new Error(
        'Local diagnostics need Git with --no-lazy-fetch (2.44+); put a newer git first in PATH.',
      );
    }
  if (mode === 'local') {
    prepareWebSourceIdentity(root);
    prepareViewerScope(root);
    prepareAppScope();
    const head = fixture();
    // Shipped production bundle of this checkout, built from the fixture repo.
    lanBundle = mkdtempSync(resolve(tmpdir(), 'agg-lan-bundle-'));
    buildLanBundle({ root, repoDir: owned, outDir: resolve(lanBundle, 'dist') });
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
    await verifyWebSourceIdentity({ page, ctx, api, root });
    await verifyViewerScope(page);
    await verifyAppScope(api);
    await verifyThemes({ browser, origin: 'http://localhost:4277', artifacts });
    await verifyCrossTabAuth({ browser, api, origin: 'http://localhost:4277', artifacts });
    await verifyLanHttp({
      browser,
      outDir: resolve(lanBundle, 'dist'),
      defaultRepo: basename(owned),
      defaultCommits: 3,
      artifacts,
    });
    await page.goto(`http://localhost:4277/?repo=demo/adorable-git-graph&pull=7`);
  } else {
    if (mode === 'firefox') {
      // The web App P1 regressions in Firefox, before the extension flow.
      const fx = await import('../../apps/extension-firefox/e2e/firefox.mjs');
      xvfb = await fx.startXvfb();
      await verifyFirefoxCleanup({
        root,
        firefox: fx.findFirefox(),
        display: xvfb.display,
        artifacts,
      });
      fixture();
      lanBundle = mkdtempSync(resolve(tmpdir(), 'agg-lan-bundle-'));
      await verifyFirefoxApp({
        root,
        repoDir: owned,
        outDir: resolve(lanBundle, 'dist'),
        artifacts,
        firefox: fx.findFirefox(),
        display: xvfb.display,
      });
    }
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
      // Linux Firefox has no WebGL without a display; reuse DISPLAY if set.
      xvfb ??= await fx.startXvfb();
      ({ browser } = await fx.launchFirefox({
        display: xvfb.display,
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
  assert.equal(
    await ui(
      (r, expected) =>
        [...r.querySelectorAll('.agg-diag-commits li')]
          .find((row) => row.querySelector('button')?.textContent.includes(expected))
          ?.querySelector('a')?.href,
      OUTSIDE_SHA,
    ),
    `https://github.com/fork/adorable-git-graph/commit/${OUTSIDE_SHA}`,
    'outside PR commit evidence link uses the fork repository',
  );
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
  if (mode !== 'local') {
    const forkCommitPath = `/repos/fork/adorable-git-graph/commits/${OUTSIDE_SHA}`;
    assert(
      seen.paths.some((p) => p.includes(forkCommitPath)),
      'outside PR commit uses its fork repository',
    );
    const from = seen.paths.length;
    await click('.agg-actions .agg-btn--danger');
    await wait(() => ui((r) => Boolean(r.querySelector('.agg-fab'))), 'outside inspection closed');
    await click('.agg-fab');
    await wait(
      () =>
        ui(
          (r, expected) =>
            [...r.querySelectorAll('.agg-diag-section')].some(
              (s) => s.querySelector('select') && s.textContent.includes(expected),
            ),
          OUTSIDE_SHA,
        ),
      'outside fork inspection restored without Home',
    );
    assert(
      !seen.paths
        .slice(from)
        .some((p) => p.includes(`/repos/demo/adorable-git-graph/commits/${OUTSIDE_SHA}`)),
      'restored outside inspection keeps the fork owner',
    );
  } else {
    await page.reload();
    await wait(
      () =>
        ui(
          (r, expected) =>
            [...r.querySelectorAll('.agg-diag-section')].some(
              (s) => s.querySelector('select') && s.textContent.includes(expected),
            ),
          OUTSIDE_SHA,
        ),
      'actual App outside fork inspection restored on same-tab reload',
    );
    assert(
      seen.paths.some((p) => p.includes(`/repos/fork/adorable-git-graph/commits/${OUTSIDE_SHA}`)),
      'actual App restored inspection uses the fork repository',
    );
  }
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
  await wait(
    () =>
      ui(
        (r, expected) => r.querySelector('.agg-commit[data-selected]')?.dataset.sha === expected,
        sha('f1'),
      ),
    'URL commit initially selected',
  );
  await click(`.agg-commit[data-sha="${sha('m13')}"]`);
  await wait(
    () =>
      ui(
        (r, expected) => r.querySelector('.agg-commit[data-selected]')?.dataset.sha === expected,
        sha('m13'),
      ),
    'manual selection differs from URL commit',
  );
  if (mode === 'local') await page.reload();
  else {
    await click('.agg-actions .agg-btn--danger');
    await wait(() => ui((r) => Boolean(r.querySelector('.agg-fab'))), 'commit context closed');
    await click('.agg-fab');
  }
  await wait(
    () =>
      ui(
        (r, expected) => r.querySelector('.agg-commit[data-selected]')?.dataset.sha === expected,
        sha('m13'),
      ),
    'same commit context restores manual selection',
  );
  assert.equal(await page.evaluate(() => location.href), commitUrl);
  const nextCommitUrl = commitUrl.replace(sha('f1'), sha('f2'));
  if (mode === 'local') await page.goto(nextCommitUrl);
  else
    await page.evaluate((url) => {
      history.pushState({}, '', url);
      document.dispatchEvent(new Event('turbo:load'));
    }, nextCommitUrl);
  await wait(
    () =>
      ui(
        (r, expected) => r.querySelector('.agg-commit[data-selected]')?.dataset.sha === expected,
        sha('f2'),
      ),
    'new commit context selects its URL commit',
  );
  if (
    !(await ui(
      (r) => r.querySelector('.agg-diag-toggle')?.getAttribute('aria-expanded') === 'true',
    ))
  )
    await click('.agg-diag-toggle');
  await wait(
    async () => (await text()).includes('parent → commit:') && (await text()).includes(sha('f2')),
    'new commit context diagnostics',
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
    await wait(
      async () => !(await text()).includes('Loading…') && !(await text()).includes('載入中…'),
      'prior diagnostics settled before token change',
    );
    await wait(() => seen.pending === 0, 'prior mock requests drained');
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
  cleanupViewerScope(root);
  latency.ms = 0;
  if (ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  if (fake) await new Promise((r) => fake.close(r));
  xvfb?.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (mode === 'local') cleanupWebSourceIdentity(root);
  if (mode === 'local') for (const p of appScopeFiles) rmSync(p, { force: true });
  if (lanBundle) rmSync(lanBundle, { recursive: true, force: true });
  rmSync(owned, { recursive: true, force: true });
}
