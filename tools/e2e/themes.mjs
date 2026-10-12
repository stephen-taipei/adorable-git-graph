// Actual App theme platform: theme stylesheets load on demand behind a
// full-screen boot screen, one theme at a time, through one managed <link>.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEME_CSS = /\/themes\/(candy|hacker)\.css(?:$|\?)(?!url)/;

export async function verifyThemes({ browser, origin, artifacts }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const requested = [];
  const results = [];
  const errors = [];
  let hold = 0;
  let fail = false;
  await ctx.route(/\/themes\/(candy|hacker)\.css/, async (route) => {
    const url = route.request().url();
    if (/[?&]url\b/.test(url)) return route.continue(); // dev-only module exporting the URL
    requested.push(url.match(THEME_CSS)?.[1] ?? url);
    if (hold) await sleep(hold);
    if (fail) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const state = () =>
    page.evaluate(() => ({
      boot: document.getElementById('agg-boot')?.dataset.state ?? null,
      bootCovers: (() => {
        const b = document.getElementById('agg-boot')?.getBoundingClientRect();
        return Boolean(b && b.width >= innerWidth && b.height >= innerHeight);
      })(),
      links: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map((l) => l.getAttribute('href'))
        .filter((h) => /\/themes\//.test(h)),
      applied: [...document.styleSheets]
        .map((s) => s.href ?? '')
        .filter((h) => /\/themes\//.test(h))
        .map((h) => h.match(/themes\/(\w+)\.css/)?.[1]),
      root: document.querySelector('.agg-root')?.getAttribute('data-theme-id') ?? null,
      linkState: document.getElementById('agg-theme-stylesheet')?.dataset.state ?? null,
      tokens: getComputedStyle(document.querySelector('.agg-root') ?? document.body)
        .getPropertyValue('--agg-ink')
        .trim(),
      html: document.documentElement.dataset.themeId ?? null,
      rootInert: document.getElementById('root')?.inert ?? null,
      stored: localStorage.getItem('agg.theme-id'),
    }));
  const done = () =>
    page.waitForFunction(
      () => document.getElementById('agg-boot')?.dataset.state === 'done',
      null,
      {
        timeout: 20_000,
      },
    );
  const ready = () => page.waitForSelector('.agg-commit', { timeout: 20_000 });
  try {
    // First visit: nothing theme-specific until the default theme loads.
    hold = 900;
    await page.goto(`${origin}/`);
    await page.waitForFunction(
      () => document.getElementById('agg-boot')?.dataset.state === 'loading',
    );
    let s = await state();
    assert(s.bootCovers, 'boot screen covers the viewport');
    assert.equal(s.rootInert, true, 'app is inert under the boot screen');
    assert.deepEqual(s.applied, [], 'no theme stylesheet applied before it loads');
    assert.deepEqual(requested, ['candy'], 'only the default theme requested');
    await page.screenshot({ path: resolve(artifacts, 'theme-0-boot.png') });
    hold = 0;
    await done();
    await ready();
    s = await state();
    assert.equal(s.root, 'candy');
    assert.equal(s.html, 'candy');
    assert.equal(s.rootInert, false, 'app interactive after the theme loaded');
    assert(
      await page.evaluate(() => document.activeElement?.classList.contains('agg-root')),
      'viewer has keyboard focus once the boot screen is gone',
    );
    assert.equal(s.links.length, 1, 'one managed theme link');
    assert.deepEqual(s.applied, ['candy']);
    results.push({ label: 'first visit loads only the default theme behind the boot screen' });

    // Switching shows the boot screen again and swaps the single link.
    hold = 700;
    await page.click('.web-skin');
    await page.waitForFunction(
      () => document.getElementById('agg-boot')?.dataset.state === 'loading',
    );
    s = await state();
    assert.equal(s.root, 'candy', 'viewer keeps the old theme until the new one loads');
    hold = 0;
    await done();
    await page.waitForFunction(
      () => document.querySelector('.agg-root')?.getAttribute('data-theme-id') === 'hacker',
    );
    s = await state();
    assert.equal(s.links.length, 1, 'still one managed theme link');
    assert.deepEqual(s.applied, ['hacker'], 'only the active theme applied');
    assert.equal(s.stored, 'hacker');
    assert(
      await page.evaluate(() => document.activeElement?.classList.contains('web-skin')),
      'focus returns to the theme button after switching',
    );
    assert.deepEqual(requested, ['candy', 'hacker']);
    results.push({ label: 'switching swaps the one theme link behind the boot screen' });

    // A reload fetches only the saved theme.
    requested.length = 0;
    await page.reload();
    await done();
    await ready();
    s = await state();
    assert.deepEqual(requested, ['hacker'], 'reload requests only the saved theme');
    assert.equal(s.root, 'hacker');
    results.push({ label: 'reload loads only the saved theme' });

    // Screenshots of every theme × colour mode.
    for (const [id, mode] of [
      ['hacker', 'night'],
      ['hacker', 'day'],
      ['candy', 'day'],
      ['candy', 'night'],
    ]) {
      await page.evaluate(
        ({ id, mode }) => {
          localStorage.setItem('agg.theme-id', id);
          localStorage.setItem('agg.theme', mode);
        },
        { id, mode },
      );
      await page.reload();
      await done();
      await ready();
      await page.waitForFunction(
        ({ id, mode }) => {
          const r = document.querySelector('.agg-root');
          return r?.getAttribute('data-theme-id') === id && r?.getAttribute('data-theme') === mode;
        },
        { id, mode },
      );
      await sleep(1500);
      await page.screenshot({ path: resolve(artifacts, `theme-${id}-${mode}.png`) });
    }
    results.push({ label: 'every theme renders in day and night' });

    // A failed load keeps the boot screen up with a retry instead of an unstyled app.
    await page.evaluate(() => localStorage.setItem('agg.theme-id', 'hacker'));
    fail = true;
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('agg-boot-error')?.hidden);
    s = await state();
    assert.equal(s.boot, 'loading', 'boot screen stays up when the theme fails');
    assert.equal(s.linkState, 'failed', 'theme link marked failed');
    assert.equal(s.tokens, '', 'no theme tokens applied after a failed load');
    await page.screenshot({ path: resolve(artifacts, 'theme-failed.png') });
    fail = false;
    await page.click('#agg-boot-retry');
    await done();
    await ready();
    s = await state();
    assert.deepEqual(s.applied, ['hacker'], 'retry loads the theme');
    results.push({ label: 'failed load offers a retry' });

    assert.deepEqual(errors, [], 'page errors');
    writeFileSync(
      resolve(artifacts, 'themes-results.json'),
      JSON.stringify({ results, requested }, null, 2) + '\n',
    );
    console.log(`PASS actual App themes: ${results.length} checks`);
  } finally {
    await ctx.close().catch(() => {});
  }
}
