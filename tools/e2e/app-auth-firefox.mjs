// The same two web P1 regressions in Firefox: the shipped App on a
// non-loopback HTTP origin (non-secure context) and two real tabs sharing a
// credential. Firefox resolves the fixture host to loopback, but the origin is
// not potentially trustworthy, so `isSecureContext` is false. Every other
// host goes to a dead proxy. Credentials and GitHub data are synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, extname, resolve, sep } from 'node:path';
import { TYPES, buildLanBundle, githubBody, scopeOf, sleep, wait } from './app-auth-isolation.mjs';

const HOST = 'lan.rd.fixture.test';

/**
 * `faults` lets the cleanup regression fail each stage on purpose: `build`
 * replaces the bundle build, `firefox` the executable, `verify` fails after
 * the App has loaded, `cleanup` fails the first cleanup step. `onResources`
 * reports what the helper owns so the caller can check it was released.
 */
export async function verifyFirefoxApp({
  root,
  repoDir,
  outDir,
  artifacts,
  firefox,
  display,
  faults = {},
  onResources,
}) {
  const shas = { selected: '7'.repeat(40), context: '8'.repeat(40) };
  const tokens = { a: 'fixture-ff-auth-a', b: 'fixture-ff-auth-b' };
  // Each tab views its own repo, so every API request names its tab.
  const repos = { A: 'ff-gh/fixture', B: 'ff-gh/other' };
  const tabOf = (name) => (name === 'fixture' ? 'A' : name === 'other' ? 'B' : 'unknown');
  const calls = [];
  const unexpected = [];
  const results = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const host = req.headers.host?.split(':')[0];
    const api = url.pathname.startsWith('/gh/repos/ff-gh/');
    // Pages come from the LAN host; the API from loopback, the only plain-HTTP
    // API origin the GitHub client accepts.
    if (api ? host !== '127.0.0.1' : host !== HOST) {
      unexpected.push(`${req.headers.host}${req.url}`);
      res.writeHead(421).end();
      return;
    }
    if (api) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
        });
        res.end();
        return;
      }
      const apiUrl = new URL(url.pathname.slice('/gh'.length) + url.search, 'http://api.fixture');
      const scope = scopeOf(req.headers.authorization, tokens);
      const answer = githubBody(apiUrl, scope, shas);
      calls.push({
        tab: tabOf(apiUrl.pathname.split('/')[3]),
        scope,
        kind: answer.kind,
        requested: answer.requested ?? null,
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(answer.body));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(outDir, rel);
    if (!file.startsWith(outDir + sep) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  // Owned resources, created inside the try below and released after it.
  let browser, profile, pid, origin;
  const errors = [];
  const pages = [];
  const open = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    // Keep console errors (ErrorBoundary reports) readable after a failure.
    await page.evaluateOnNewDocument(() => {
      const original = console.error;
      window.__aggConsoleErrors = [];
      console.error = (...args) => {
        window.__aggConsoleErrors.push(
          args.map((v) => (v instanceof Error ? `${v.message}\n${v.stack}` : String(v))).join(' '),
        );
        original.apply(console, args);
      };
    });
    pages.push(page);
    return page;
  };
  const kit = (page, repo) => ({
    ready: (label, name = repo, count = 2) =>
      wait(
        () =>
          page.evaluate(
            ({ name, count }) =>
              !!document.querySelector('.web-root') &&
              document.querySelector('.agg-title-text')?.textContent === name &&
              document.querySelectorAll('.agg-commit').length === count,
            { name, count },
          ),
        `Firefox App ready: ${label}`,
      ),
    selected: () =>
      page.evaluate(
        () => document.querySelector('.agg-commit[data-selected="true"]')?.dataset.sha ?? null,
      ),
    select: async (sha) => {
      await page.evaluate(
        (sha) => document.querySelector(`.agg-commit[data-sha="${sha}"]`).click(),
        sha,
      );
      await page.evaluate(() => {
        const toggle = document.querySelector('.agg-diag-toggle');
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      });
      await wait(
        () => page.evaluate(() => !!document.querySelector('.agg-diag-files button')),
        'Firefox selected changes',
      );
    },
    setCredential: async (value) => {
      await page.evaluate(() =>
        [...document.querySelectorAll('.agg-actions button')].at(-1).click(),
      );
      await wait(
        () => page.evaluate(() => !!document.querySelector('.web-dialog input')),
        'Firefox TokenDialog',
      );
      await page.evaluate((value) => {
        const input = document.querySelector('.web-dialog input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (value) document.querySelector('.web-dialog button[type="submit"]').click();
        else document.querySelector('.web-dialog button[type="button"]').click();
      }, value);
      await wait(
        () => page.evaluate(() => !document.querySelector('.web-dialog')),
        'Firefox TokenDialog saved',
      );
    },
  });
  const isOld = (c) => c.requested === shas.selected || c.requested === shas.context;
  // Old-SHA detail requests from tab A under any credential other than `old`.
  const stale = (from, old) =>
    calls
      .slice(from)
      .filter((c) => c.tab === 'A' && c.kind === 'detail' && c.scope !== old && isOld(c));
  let failure;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    origin = `http://${HOST}:${port}`;
    onResources?.({ port });
    // The API base is the only setting that differs from the shipped build; the
    // Chromium check keeps the shipped default and intercepts api.github.com.
    // Non-loopback plain-HTTP API bases are rejected by design.
    (faults.build ?? buildLanBundle)({
      root,
      repoDir,
      outDir,
      apiBase: `http://127.0.0.1:${port}/gh`,
    });
    // A profile the helper owns, so it is removed whatever happens to Firefox.
    profile = mkdtempSync(resolve(tmpdir(), 'agg-ff-app-profile-'));
    onResources?.({ port, profile });
    const puppeteer = createRequire(resolve(root, 'apps/extension-firefox/package.json'))(
      'puppeteer-core',
    );
    browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath: faults.firefox ?? firefox,
      headless: true,
      args: ['--no-remote', '--new-instance', '--profile', profile],
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
      extraPrefsFirefox: {
        'network.dns.localDomains': HOST,
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': 9,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': 9,
        'network.proxy.no_proxies_on': HOST,
        'intl.accept_languages': 'en-US',
      },
    });
    pid = browser.process()?.pid;
    onResources?.({ port, profile, pid });

    // Non-secure context, actual App, default repo.
    const a = await open();
    const kitA = kit(a, repos.A);
    await a.goto(`${origin}/`);
    const env = await a.evaluate(() => ({
      secure: window.isSecureContext,
      randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues,
    }));
    assert.deepEqual(env, { secure: false, randomUUID: 'undefined', getRandomValues: 'function' });
    await kitA.ready('default repo', basename(repoDir), 3);
    results.push({
      label: 'Firefox non-secure context renders the actual App and default repo',
      env,
    });
    if (faults.verify) throw new Error('fixture: verification failed after launch');

    // Credential A, selection, same-credential reload restore.
    await a.goto(`${origin}/?repo=${repos.A}`);
    await kitA.ready('anonymous');
    await kitA.setCredential(tokens.a);
    await wait(
      () => calls.some((c) => c.tab === 'A' && c.kind === 'graph' && c.scope === 'a'),
      'Firefox credential A used',
    );
    await kitA.ready('credential A');
    await kitA.select(shas.selected);
    await a.reload();
    await kitA.ready('reload');
    await wait(
      async () => (await kitA.selected()) === shas.selected,
      'Firefox same-credential restore',
    );
    results.push({
      label: 'Firefox settings save, Bearer graph, diagnostics, same-credential restore',
    });

    // Tab B changes the credential while A stays open.
    const b = await open();
    const kitB = kit(b, repos.B);
    await b.goto(`${origin}/?repo=${repos.B}`);
    await kitB.ready('B');
    let from = calls.length;
    await kitB.setCredential(tokens.b);
    await wait(
      () => calls.slice(from).some((c) => c.tab === 'A' && c.kind === 'graph' && c.scope === 'b'),
      'Firefox open tab A refetches with credential B',
    );
    await kitA.ready('A after adoption');
    await sleep(300);
    assert.equal(await kitA.selected(), null, 'Firefox A dropped old selection');
    assert.equal(stale(from, 'a').length, 0, 'Firefox keep-open old-SHA requests');
    await a.reload();
    await kitA.ready('A reload after change');
    await sleep(300);
    assert.equal(await kitA.selected(), null, 'Firefox A reload does not restore');
    assert.equal(stale(from, 'a').length, 0, 'Firefox reload old-SHA requests');
    results.push({ label: 'Firefox two tabs: change keep-open then reload', oldShaRequests: 0 });

    // A away while B clears the credential; A returns.
    await kitA.select(shas.selected);
    await a.goto('about:blank');
    from = calls.length;
    await kitB.setCredential('');
    await a.goto(`${origin}/?repo=${repos.A}`);
    await kitA.ready('A returns after clear');
    await sleep(300);
    assert(
      calls.slice(from).some((c) => c.tab === 'A' && c.kind === 'graph' && c.scope === 'anonymous'),
      'Firefox A returns anonymous',
    );
    assert.equal(await kitA.selected(), null, 'Firefox away tab does not restore after clear');
    assert.equal(stale(from, 'b').length, 0, 'Firefox away old-SHA requests');
    results.push({ label: 'Firefox two tabs: clear while away, return', oldShaRequests: 0 });

    assert.deepEqual(errors, [], 'Firefox page errors');
    assert.deepEqual(unexpected, [], 'Firefox requests outside the fixture hosts');
    writeFileSync(
      resolve(artifacts, 'firefox-app-auth-results.json'),
      JSON.stringify(
        { results, calls, realApp: true, productionBundle: true, syntheticCredentials: true },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `PASS Firefox actual App: non-secure context and two-tab auth (${results.length} checks)`,
    );
  } catch (error) {
    failure = error;
    if (artifacts) {
      const state = await Promise.all(
        pages.map((p) =>
          p
            .evaluate(() => ({
              page: `${location.href} ${document.body.textContent.slice(0, 400)}`,
              console: window.__aggConsoleErrors?.map((e) => e.slice(0, 1500)),
            }))
            .catch(() => null),
        ),
      );
      writeFileSync(
        resolve(artifacts, 'firefox-app-auth-failure.json'),
        JSON.stringify(
          { results, calls, errors, unexpected, state, error: String(error.message) },
          null,
          2,
        ) + '\n',
      );
    }
  }
  // Release every owned resource even when one step fails; the original
  // failure stays the one reported.
  const cleanupErrors = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error.message}`));
    }
  };
  if (faults.cleanup)
    await step('injected', () => {
      throw new Error('fixture: cleanup step failed');
    });
  for (const page of pages) await step('page', () => page.close());
  if (browser) await step('browser', () => browser.close());
  if (pid)
    await step('browser process', () => {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      process.kill(pid, 'SIGKILL');
    });
  if (profile) await step('profile', () => rmSync(profile, { recursive: true, force: true }));
  if (server.listening)
    await step('server', () => {
      server.closeAllConnections();
      return new Promise((done, fail) => server.close((e) => (e ? fail(e) : done())));
    });
  if (failure) {
    if (cleanupErrors.length) failure.cleanupErrors = cleanupErrors;
    throw failure;
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Firefox helper cleanup failed');
}
