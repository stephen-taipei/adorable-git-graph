// Actual App regressions for the two remaining auth-scope P1s. Every browser
// context here is fresh and isolated; credentials and GitHub data are synthetic
// and all GitHub traffic is intercepted in the browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const TOKEN_KEY = 'agg.github-token';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const wait = async (fn, label, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await sleep(100);
  }
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Synthetic GitHub REST answers. Patches name the credential scope that
// fetched them, so a late or reused result is visible in committed frames.
export function githubBody(url, scope, shas) {
  const parts = url.pathname.split('/'),
    owner = parts[2];
  const commit = (sha) => ({
    sha,
    parents: sha === shas.selected ? [{ sha: shas.context }] : [],
    commit: {
      message: `Auth fixture ${owner} ${sha === shas.selected ? 'selected' : 'context'}`,
      author: { name: 'Fixture', date: '2026-01-01T00:00:00Z' },
    },
    author: { login: 'fixture' },
  });
  if (/\/commits\/[a-f0-9]{40}$/.test(url.pathname))
    return {
      kind: 'detail',
      requested: parts.at(-1),
      body: {
        ...commit(parts.at(-1)),
        files: [
          {
            filename: `${owner}.txt`,
            status: 'modified',
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: `@@ -0,0 +1 @@\n+${owner}:${scope}`,
          },
        ],
      },
    };
  if (url.pathname.endsWith('/commits'))
    return { kind: 'graph', body: [commit(shas.selected), commit(shas.context)] };
  if (url.pathname.endsWith('/branches'))
    return { kind: 'branches', body: [{ name: 'main', commit: { sha: shas.selected } }] };
  if (url.pathname.endsWith('/tags') || url.pathname.endsWith('/pulls'))
    return { kind: 'list', body: [] };
  return {
    kind: 'repo',
    body: {
      name: parts[3],
      default_branch: 'main',
      html_url: `https://github.com/${owner}/${parts[3]}`,
    },
  };
}

export function scopeOf(auth, tokens) {
  for (const [scope, value] of Object.entries(tokens)) if (auth === `Bearer ${value}`) return scope;
  return auth ? 'unexpected' : 'anonymous';
}

// Shared page helpers for the shipped App, SourceBar and TokenDialog.
function appKit(page, repo) {
  const ready = (label = repo) =>
    wait(
      () =>
        page.evaluate(
          (repo) =>
            !!document.querySelector('.web-root') &&
            document.querySelector('.agg-title-text')?.textContent === repo &&
            document.querySelectorAll('.agg-commit').length === 2,
          repo,
        ),
      `actual App ready ${label}`,
    );
  const openDiagnostics = async () => {
    if ((await page.locator('.agg-diag-toggle').getAttribute('aria-expanded')) !== 'true')
      await page.locator('.agg-diag-toggle').click();
  };
  const select = async (sha, { settle = true } = {}) => {
    await page.locator(`.agg-commit[data-sha="${sha}"]`).click();
    await openDiagnostics();
    if (settle)
      await wait(
        () => page.evaluate(() => !!document.querySelector('.agg-diag-files button')),
        'selected commit changes',
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
      'TokenDialog closed after verified save',
    );
  const cancel = async () => {
    if (await page.locator('.web-dialog').count())
      await page.locator('.web-dialog button[type="button"]').last().click();
  };
  const alert = () =>
    wait(
      () =>
        page
          .locator('.web-dialog [role="alert"]')
          .count()
          .then((n) => n === 1),
      'visible storage failure',
    );
  const selectedIs = (sha) =>
    wait(
      () =>
        page
          .locator(`.agg-commit[data-selected="true"][data-sha="${sha}"]`)
          .count()
          .then((n) => n === 1),
      `focus restored to ${sha.slice(0, 7)}`,
    );
  return { ready, select, save, clear, closed, cancel, alert, selectedIs, openDiagnostics };
}

// Raw credentials stay out of every storage entry except the credential
// itself; their SHA-256 fingerprints stay out of every viewer key, focus,
// inspection and auth scope record. Only the graph cache keeps its existing
// module-private fingerprint.
async function assertNoCredentialMaterial(pages, tokens, label) {
  const raw = Object.values(tokens);
  const hashes = raw.map(sha256);
  for (const page of pages) {
    const stored = await page.evaluate((tokenKey) => {
      const out = [];
      for (const area of [sessionStorage, localStorage])
        for (let i = 0; i < area.length; i += 1) {
          const key = area.key(i);
          if (area === localStorage && key === tokenKey) continue;
          out.push(`${key}=${area.getItem(key)}`);
        }
      return out;
    }, TOKEN_KEY);
    for (const entry of stored) {
      const key = entry.slice(0, entry.indexOf('='));
      for (const value of [...raw, ...(key.startsWith('agg:gh:') ? [] : hashes)])
        assert(!entry.includes(value), `${label}: credential material in storage entry ${key}`);
    }
    const keys = stored
      .filter((e) => e.startsWith('agg:focus:'))
      .map((e) => JSON.parse(e.slice(e.indexOf('=') + 1)).viewerStateKey);
    assert(
      keys.every((k) => typeof k === 'string' && k.length > 0),
      `${label}: every focus record carries a nonempty opaque viewer key`,
    );
  }
}

// Shared credential and generation as one tab reads them.
const sharedState = (page) =>
  page.evaluate(() => ({
    token: localStorage.getItem('agg.github-token'),
    generation: localStorage.getItem('agg:auth-generation:v1'),
  }));

// Tab-scoped auth and focus records, read without running App code.
const tabState = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith('agg:viewer-auth') || k.startsWith('agg:focus:'))
        .sort()
        .map((k) => [k, sessionStorage.getItem(k)]),
    ),
  );

/**
 * Two real App tabs in one browser context share localStorage and keep their
 * own sessionStorage. Each scenario starts from a fresh context.
 */
export async function verifyCrossTabAuth({ browser, api, origin, artifacts }) {
  const shas = { selected: '3'.repeat(40), context: '4'.repeat(40) };
  const tokens = { a: 'fixture-tab-auth-a', b: 'fixture-tab-auth-b' };
  const repo = 'tab-a/fixture';
  const url = `${origin}/e2e/.artifacts/diagnostics/app-scope.html?repo=${repo}`;
  const results = [];
  const failures = [];

  async function scenario(label, body) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const calls = [];
    const held = [];
    const hold = { scopes: new Set() };
    const names = new Map();
    const errors = [];
    await ctx.route(`${api}/repos/tab-*/fixture**`, async (route) => {
      const req = route.request();
      const reqUrl = new URL(req.url());
      const scope = scopeOf(req.headers().authorization, tokens);
      const answer = githubBody(reqUrl, scope, shas);
      let tab = 'unknown';
      try {
        tab = names.get(req.frame().page()) ?? 'unknown';
      } catch {
        /* not a page request */
      }
      calls.push({ tab, scope, kind: answer.kind, requested: answer.requested ?? null });
      const fulfill = () =>
        route
          .fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(answer.body),
          })
          .catch(() => {});
      if (answer.kind === 'detail' && hold.scopes.has(`${tab}:${scope}`)) held.push(fulfill);
      else await fulfill();
    });
    const open = async (name, { missStorageEvents = false } = {}) => {
      const page = await ctx.newPage();
      names.set(page, name);
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
      // Models a tab that misses storage events (frozen or discarded tabs):
      // a capture listener registered first stops the App's own listener.
      if (missStorageEvents)
        await page.addInitScript(() =>
          window.addEventListener('storage', (e) => e.stopImmediatePropagation(), true),
        );
      await page.goto(url);
      return page;
    };
    const frames = (page) => page.evaluate(() => window.__aggAppFrames.slice());
    const resetFrames = (page) =>
      page.evaluate(() => {
        window.__aggAppFrames.length = 0;
      });
    const staleRequests = (from, tab, scope) =>
      calls
        .slice(from)
        .filter(
          (c) =>
            c.tab === tab &&
            c.kind === 'detail' &&
            (scope === undefined || c.scope === scope) &&
            (c.requested === shas.selected || c.requested === shas.context),
        );
    // The new auth is adopted once the tab drops the old graph; from that
    // committed frame on, no frame may show the old selection or old results.
    const assertAdopted = async (page, label, scope, from) => {
      await wait(
        () =>
          calls.slice(from).some((c) => c.tab === 'A' && c.kind === 'graph' && c.scope === scope),
        `${label}: open tab A adopts ${scope} without reload`,
      );
      const kit = appKit(page, repo);
      await kit.ready(label);
      await sleep(150);
      const all = await frames(page);
      const first = all.findIndex((f) => !f.ready);
      assert(first >= 0, `${label}: old graph dropped before the new auth committed`);
      const after = all.slice(first);
      assert(
        after.every((f) => f.selected === null && f.files.length === 0 && !f.patch),
        `${label}: no old selection or results in any committed frame of the new auth`,
      );
      assert.equal(
        staleRequests(from, 'A', scope).length,
        0,
        `${label}: new adapter old-SHA requests`,
      );
      return { framesAfterAdoption: after.length };
    };
    const assertNoRestore = async (page, label, from) => {
      const kit = appKit(page, repo);
      await kit.ready(label);
      await sleep(150);
      const all = (await frames(page)).filter((f) => f.ready);
      assert(all.length > 0, `${label}: ready frames observed`);
      assert(
        all.every((f) => f.selected === null && f.files.length === 0 && !f.patch),
        `${label}: no old selection or results in any committed frame`,
      );
      assert.equal(
        staleRequests(from, 'A').length,
        0,
        `${label}: old-SHA requests after auth change`,
      );
      return { readyFrames: all.length };
    };
    const setup = async (options = {}) => {
      const a = await open('A', options);
      const kitA = appKit(a, repo);
      await kitA.ready('A anonymous');
      await kitA.save(tokens.a);
      await kitA.closed();
      await wait(
        () => calls.some((c) => c.tab === 'A' && c.kind === 'graph' && c.scope === 'a'),
        'A refetches with credential A',
      );
      await kitA.ready('A credential A');
      await kitA.select(shas.selected);
      assert(
        calls.some(
          (c) =>
            c.tab === 'A' &&
            c.kind === 'detail' &&
            c.scope === 'a' &&
            c.requested === shas.selected,
        ),
        'A selected SHA under credential A',
      );
      const b = await open('B');
      const kitB = appKit(b, repo);
      await kitB.ready('B');
      assert(
        calls.some((c) => c.tab === 'B' && c.kind === 'graph' && c.scope === 'a'),
        'B shares credential A',
      );
      return { a, b, kitA, kitB };
    };
    try {
      const outcome = await body({
        setup,
        calls,
        held,
        hold,
        frames,
        resetFrames,
        assertAdopted,
        assertNoRestore,
        staleRequests,
        ctx,
      });
      const pages = ctx.pages();
      await assertNoCredentialMaterial(pages, tokens, label);
      assert.deepEqual(errors, [], `${label}: page errors`);
      results.push({ label, passed: true, ...outcome });
    } catch (error) {
      failures.push({ label, error: String(error.message) });
      results.push({ label, passed: false, error: String(error.message), calls });
    } finally {
      for (const fulfill of held.splice(0)) await fulfill();
      await ctx.close().catch(() => {});
    }
  }

  await scenario('same credential: B opens, A reload restores manual focus', async (t) => {
    const { a, kitA } = await t.setup();
    await a.reload();
    await kitA.ready('A reload');
    await kitA.selectedIs(shas.selected);
    return { restored: true };
  });

  await scenario(
    'B changes credential, A kept open (in-flight request cancelled), then A reloads',
    async (t) => {
      const { a, b, kitA, kitB } = await t.setup();
      // Leave a detail request of the old credential pending in A.
      t.hold.scopes.add('A:a');
      await a.locator(`.agg-commit[data-sha="${shas.context}"]`).click();
      await wait(
        () => t.calls.some((c) => c.tab === 'A' && c.scope === 'a' && c.requested === shas.context),
        'A old-credential request in flight',
      );
      await t.resetFrames(a);
      const from = t.calls.length;
      await kitB.save(tokens.b);
      await kitB.closed();
      const afterSave = { shared: await sharedState(b), tab: await tabState(b) };
      const open = await t.assertAdopted(a, 'change keep-open', 'b', from);
      await sleep(300);
      assert.deepEqual(
        { shared: await sharedState(b), tab: await tabState(b) },
        afterSave,
        'adopting tab never rotates the saving tab again',
      );
      for (const fulfill of t.held.splice(0)) await fulfill();
      await sleep(300);
      const all = await t.frames(a);
      const late = all
        .slice(all.findIndex((f) => !f.ready))
        .filter((f) => f.files.length || f.patch || f.selected);
      assert.equal(late.length, 0, 'late old-credential result never committed after adoption');
      await a.reload();
      const reload = await t.assertNoRestore(a, 'change keep-open then reload', from);
      // Same credential again after the change: manual focus still restores.
      await kitA.select(shas.selected);
      await a.reload();
      await kitA.ready('A reload after reselect');
      await kitA.selectedIs(shas.selected);
      return { open, reload, sameCredentialRestoreAfterChange: true };
    },
  );

  await scenario('B changes credential, A reloads immediately', async (t) => {
    const { a, kitB } = await t.setup();
    const from = t.calls.length;
    await kitB.save(tokens.b);
    await kitB.closed();
    await a.reload();
    return t.assertNoRestore(a, 'change then immediate reload', from);
  });

  await scenario('B changes credential while A is away, A returns', async (t) => {
    const { a, kitB } = await t.setup();
    const before = await tabState(a);
    await a.goto('about:blank');
    const from = t.calls.length;
    await kitB.save(tokens.b);
    await kitB.closed();
    // A static same-origin document runs no App code: A's tab-scoped records
    // are still the pre-change ones, so the App alone must detect the change.
    await a.goto(`${origin}/favicon.svg`);
    assert.deepEqual(await tabState(a), before, 'A tab state survived unchanged while away');
    await a.goto(url);
    return t.assertNoRestore(a, 'change while away', from);
  });

  await scenario('B clears credential, A kept open, then A reloads', async (t) => {
    const { a, kitB } = await t.setup();
    // A has the settings dialog open with the old credential as its draft.
    await a.locator('.agg-actions button').last().click();
    await a.locator('.web-dialog input').waitFor();
    await t.resetFrames(a);
    const from = t.calls.length;
    await kitB.clear();
    await kitB.closed();
    const open = await t.assertAdopted(a, 'clear keep-open', 'anonymous', from);
    assert.equal(await a.locator('.web-dialog').count(), 0, 'stale settings draft closed');
    assert.equal((await sharedState(a)).token, null, "the other tab's clear stays in effect");
    await a.reload();
    const reload = await t.assertNoRestore(a, 'clear keep-open then reload', from);
    return { open, reload };
  });

  await scenario('B clears credential, A reloads immediately', async (t) => {
    const { a, kitB } = await t.setup();
    const from = t.calls.length;
    await kitB.clear();
    await kitB.closed();
    await a.reload();
    return t.assertNoRestore(a, 'clear then immediate reload', from);
  });

  await scenario('B clears credential while A is away, A returns', async (t) => {
    const { a, kitB } = await t.setup();
    const before = await tabState(a);
    await a.goto('about:blank');
    const from = t.calls.length;
    await kitB.clear();
    await kitB.closed();
    await a.goto(`${origin}/favicon.svg`);
    assert.deepEqual(await tabState(a), before, 'A tab state survived unchanged while away');
    await a.goto(url);
    return t.assertNoRestore(a, 'clear while away', from);
  });

  for (const [label, act, scope, recheck] of [
    ['B changes credential, A misses the event, A returns to foreground', 'save', 'b', 'visible'],
    [
      'B clears credential, A misses the event, A restored from bfcache',
      'clear',
      'anonymous',
      'pageshow',
    ],
  ])
    await scenario(label, async (t) => {
      const { a, kitB } = await t.setup({ missStorageEvents: true });
      await t.resetFrames(a);
      const from = t.calls.length;
      if (act === 'save') await kitB.save(tokens.b);
      else await kitB.clear();
      await kitB.closed();
      await sleep(1500);
      assert(
        !t.calls.slice(from).some((c) => c.tab === 'A' && c.kind === 'graph'),
        `${label}: A really missed the storage event`,
      );
      await a.evaluate((recheck) => {
        if (recheck === 'visible') document.dispatchEvent(new Event('visibilitychange'));
        else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }, recheck);
      const open = await t.assertAdopted(a, label, scope, from);
      await a.reload();
      const reload = await t.assertNoRestore(a, `${label} then reload`, from);
      return { open, reload };
    });

  writeFileSync(
    resolve(artifacts, 'actual-app-cross-tab-results.json'),
    JSON.stringify({ results, syntheticCredentials: true, realApp: true, twoTabs: true }, null, 2) +
      '\n',
  );
  for (const r of results)
    console.log(
      `${r.passed ? 'PASS' : 'FAIL'} cross-tab: ${r.label}${r.passed ? '' : ` — ${r.error}`}`,
    );
  if (failures.length)
    throw new Error(`cross-tab auth: ${failures.length}/${results.length} scenarios failed`);
  console.log(`PASS actual App cross-tab auth isolation: ${results.length} two-tab scenarios`);
}

export const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** Production bundle with the shipped defaults; no dev server or Git endpoint. */
export function buildLanBundle({ root, repoDir, outDir, apiBase }) {
  const env = {
    ...process.env,
    AGG_REPO_DIR: repoDir,
    AGG_LOCAL_REPOS_FILE: resolve(outDir, '..', 'lan-state.json'),
  };
  if (apiBase) env.VITE_GITHUB_API_BASE = apiBase;
  else delete env.VITE_GITHUB_API_BASE;
  execFileSync(
    process.execPath,
    [
      resolve(root, 'apps/web/node_modules/vite/bin/vite.js'),
      'build',
      '--outDir',
      outDir,
      '--emptyOutDir',
    ],
    { cwd: resolve(root, 'apps/web'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert(existsSync(resolve(outDir, 'index.html')), 'production bundle built');
}

/**
 * The production bundle served at a non-loopback HTTP origin is a non-secure
 * context. Nothing leaves the browser: the LAN origin is answered from the
 * built files and GitHub from synthetic data; anything else is aborted.
 */
export async function verifyLanHttp({ browser, outDir, defaultRepo, defaultCommits, artifacts }) {
  const lan = 'http://lan.rd.fixture.test';
  const shas = { selected: '5'.repeat(40), context: '6'.repeat(40) };
  const tokens = { one: 'fixture-lan-token-1', two: 'fixture-lan-token-2' };
  const ghRepo = 'lan-gh/fixture';
  const results = [];
  const calls = [];
  const lanPaths = [];
  const unexpected = [];
  const errors = [];
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    serviceWorkers: 'block',
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === lan) {
      lanPaths.push(url.pathname);
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = resolve(outDir, rel);
      if (!file.startsWith(outDir + sep) || !existsSync(file))
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return route.fulfill({
        status: 200,
        contentType: TYPES[extname(file)] ?? 'application/octet-stream',
        body: readFileSync(file),
      });
    }
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/lan-gh/')) {
      const scope = scopeOf(req.headers().authorization, tokens);
      const answer = githubBody(url, scope, shas);
      calls.push({ scope, kind: answer.kind, requested: answer.requested ?? null });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(answer.body),
      });
    }
    unexpected.push(req.url());
    return route.abort();
  });
  // Storage faults are toggled per test step; initial faults survive reloads
  // through a tab-scoped flag so the first App render sees them.
  await ctx.addInitScript(
    ({ tokenKey }) => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem,
        remove = Storage.prototype.removeItem;
      const scoped = (area, k) => area === sessionStorage && k.startsWith('agg:viewer-auth');
      const generation = (area, k) => area === localStorage && k.startsWith('agg:auth-generation');
      const initial = (k) => get.call(sessionStorage, 'agg:test:' + k) === '1';
      window.__aggStorageFault = {
        tokenGet: initial('tokenGet'),
        scopeGet: initial('scopeGet'),
        scopeSet: initial('scopeSet'),
      };
      Storage.prototype.getItem = function (k) {
        const f = window.__aggStorageFault;
        if (
          this === localStorage &&
          k === tokenKey &&
          (f.tokenGet || (f.tokenReadAfterWrite && f.tokenWritten))
        )
          throw new Error('fixture token read blocked');
        if (scoped(this, k) && (f.scopeGet || (f.scopeReadAfterWrite && f.scopeWritten)))
          throw new Error('fixture scope read blocked');
        return get.call(this, k);
      };
      Storage.prototype.setItem = function (k, v) {
        const f = window.__aggStorageFault;
        if (this === localStorage && k === tokenKey && f.tokenSet)
          throw new Error('fixture token write blocked');
        if (scoped(this, k) && f.scopeSet) throw new Error('fixture scope write blocked');
        if (generation(this, k) && f.generationSet)
          throw new Error('fixture generation write blocked');
        set.call(this, k, v);
        if (this === localStorage && k === tokenKey) f.tokenWritten = true;
        if (scoped(this, k)) f.scopeWritten = true;
      };
      Storage.prototype.removeItem = function (k) {
        const f = window.__aggStorageFault;
        if (this === localStorage && k === tokenKey && f.tokenSet)
          throw new Error('fixture token removal blocked');
        remove.call(this, k);
        if (this === localStorage && k === tokenKey) f.tokenWritten = true;
      };
    },
    { tokenKey: TOKEN_KEY },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const kit = appKit(page, ghRepo);
  const fault = (v) =>
    page.evaluate((v) => {
      window.__aggStorageFault = v;
    }, v);
  const initialFault = (kind, on) =>
    page.evaluate(
      ({ kind, on }) =>
        on
          ? sessionStorage.setItem('agg:test:' + kind, '1')
          : sessionStorage.removeItem('agg:test:' + kind),
      { kind, on },
    );
  const appUsable = async (label) => {
    await wait(
      () => page.evaluate(() => !!document.querySelector('.web-root')),
      `${label}: .web-root`,
    );
    assert.deepEqual(errors, [], `${label}: no page errors`);
  };
  const goRepo = async (value) => {
    // The repo input sits behind the SourceBar's GitHub toggle on local sources.
    if (!(await page.locator('.web-form button.web-go').count()))
      await page.locator('.web-seg button').nth(1).click();
    await page.locator('.web-form input').fill(value);
    await page.locator('.web-form button[type="submit"]').click();
  };
  const noRestore = async (label, from) => {
    await kit.ready(label);
    await sleep(150);
    const selected = await page.evaluate(
      () => document.querySelector('.agg-commit[data-selected="true"]')?.dataset.sha ?? null,
    );
    assert.equal(selected, null, `${label}: uncertain auth never restores old selection`);
    const stale = calls.slice(from).filter((c) => c.kind === 'detail');
    assert.equal(stale.length, 0, `${label}: old SHA requests`);
    results.push({ label, passed: true });
  };
  const establish = async (token) => {
    await fault({});
    await kit.cancel();
    if (
      !(await page.evaluate(
        (repo) => document.querySelector('.agg-title-text')?.textContent === repo,
        ghRepo,
      ))
    )
      await goRepo(ghRepo);
    await kit.save(token);
    await kit.closed();
    await kit.ready(`credential ${token}`);
    await kit.select(shas.selected);
  };
  try {
    await page.goto(`${lan}/`);
    const env = await page.evaluate(() => ({
      origin: location.origin,
      secure: window.isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues,
      subtle: typeof crypto.subtle,
    }));
    assert.equal(env.origin, lan);
    assert.equal(env.secure, false, 'non-loopback HTTP is not a secure context');
    assert.equal(env.randomUUID, 'undefined', 'randomUUID is unavailable');
    assert.equal(env.getRandomValues, 'function', 'getRandomValues remains available');
    results.push({ label: 'non-secure context preconditions', passed: true, env });
    await appUsable('default repo');
    await wait(
      () =>
        page.evaluate(
          ({ name, count }) =>
            document.querySelector('.agg-title-text')?.textContent === name &&
            document.querySelectorAll('.agg-commit').length === count,
          { name: defaultRepo, count: defaultCommits },
        ),
      'default repo graph in the actual App',
    );
    results.push({ label: 'actual App and default repo render', passed: true });

    // Real functionality: verified settings save, GitHub source with Bearer
    // auth, diagnostics, same-credential reload restore, credential change.
    await goRepo(ghRepo);
    await kit.ready('GitHub anonymous');
    await kit.save(tokens.one);
    await kit.closed();
    await wait(
      () => calls.some((c) => c.kind === 'graph' && c.scope === 'one'),
      'Bearer credential used',
    );
    await kit.ready('GitHub credential one');
    await kit.select(shas.selected);
    await wait(
      () =>
        calls.some(
          (c) => c.kind === 'detail' && c.scope === 'one' && c.requested === shas.selected,
        ),
      'diagnostics query',
    );
    await page.reload();
    await appUsable('reload');
    await kit.ready('reload');
    await kit.selectedIs(shas.selected);
    results.push({
      label: 'settings save, GitHub graph, diagnostics and same-credential restore',
      passed: true,
    });
    await kit.save(tokens.two);
    await kit.closed();
    let from = calls.length;
    await goRepo('lan-gh/other');
    await goRepo(ghRepo);
    await noRestore('credential change clears old focus', from);
    await page.reload();
    await noRestore('credential change then reload', from);

    // Initial reads and writes that fail keep the App usable and fail closed.
    for (const kind of ['tokenGet', 'scopeGet', 'scopeSet']) {
      await establish(tokens.one);
      if (kind === 'scopeSet')
        await page.evaluate(() => {
          for (const k of Object.keys(sessionStorage))
            if (k.startsWith('agg:viewer-auth')) sessionStorage.removeItem(k);
        });
      await initialFault(kind, true);
      from = calls.length;
      await page.reload();
      await appUsable(`initial ${kind} failure`);
      await noRestore(`initial ${kind} failure`, from);
      await initialFault(kind, false);
      await fault({});
    }
    // Save-time failures: visible error, App stays usable, no old focus.
    for (const [label, f, stored] of [
      ['scope write failure', { scopeSet: true }, tokens.one],
      ['scope readback failure', { scopeReadAfterWrite: true }, tokens.one],
      ['generation write failure', { generationSet: true }, tokens.one],
      ['credential write failure', { tokenSet: true }, tokens.one],
      ['credential readback failure', { tokenReadAfterWrite: true }, tokens.two],
    ]) {
      await establish(tokens.one);
      await goRepo('lan-gh/other');
      await fault(f);
      await kit.save(tokens.two);
      await kit.alert();
      await appUsable(label);
      await fault({});
      assert.equal(
        await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY),
        stored,
        `${label}: persisted credential reconciled`,
      );
      await kit.cancel();
      from = calls.length;
      await goRepo(ghRepo);
      await noRestore(`${label} same page`, from);
      await page.reload();
      await appUsable(`${label} reload`);
      await noRestore(`${label} reload`, from);
    }
    assert.deepEqual(unexpected, [], 'no request escaped interception');
    assert(!lanPaths.some((p) => p.startsWith('/__agg')), 'no Git endpoint on the LAN origin');
    await page.screenshot({ path: resolve(artifacts, 'lan-http-non-secure.png') });
    writeFileSync(
      resolve(artifacts, 'lan-http-non-secure-results.json'),
      JSON.stringify(
        {
          results,
          calls,
          lanPaths: [...new Set(lanPaths)],
          realApp: true,
          productionBundle: true,
          syntheticCredentials: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`PASS non-secure LAN HTTP production App: ${results.length} checks`);
  } catch (error) {
    const state = await page
      .evaluate(() => ({
        webRoot: !!document.querySelector('.web-root'),
        aggRoot: !!document.querySelector('.agg-root'),
        text: document.body.textContent.slice(0, 600),
      }))
      .catch(() => null);
    await page
      .screenshot({ path: resolve(artifacts, 'lan-http-non-secure-failure.png') })
      .catch(() => {});
    writeFileSync(
      resolve(artifacts, 'lan-http-non-secure-failure.json'),
      JSON.stringify(
        { results, calls, errors, unexpected, state, error: String(error.message) },
        null,
        2,
      ) + '\n',
    );
    console.error('LAN HTTP failure state:', JSON.stringify(state), 'page errors:', errors);
    throw error;
  } finally {
    await ctx.close().catch(() => {});
  }
}
