// Chrome Web Store / AMO 的商店圖片：以真的 Chrome 載入正式建置的 extension，打開 GitHub repo 頁面截圖。
//   screenshot-1-graph.png       1280×800  overlay（白天）
//   screenshot-2-detail.png      1280×800  點開一個 commit 的詳情
//   screenshot-3-search.png      1280×800  搜尋（不符合的列淡化）
//   screenshot-4-dark.png        1280×800  夜間（跟隨 GitHub / 系統的深色模式）
//   screenshot-5-theme.png       1280×800  切換成「駭客小惡魔」主題（夜間）
//   promo-small-440x280.png      Chrome 小型宣傳圖（必填）
//   promo-marquee-1400x560.png   Chrome marquee 宣傳圖（選填）
// 用法（在自己的電腦上，需要連得到 github.com）：
//   pnpm --filter @adorable/extension store-assets [-- --repo owner/name]
//   --mock：不連外網，改用 e2e 的 mock API 與假 GitHub 頁面（只用來驗證腳本本身，圖片內容是測試資料，不要上傳）
// 輸出到 apps/extension/store-assets/。未登入的 GitHub API 每小時 60 次；一次執行約 10–20 次。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { assertExtensionLoaded, findExtensionChrome } from '../../../tools/e2e/chrome-path.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(appRoot, 'store-assets');
const extDir = resolve(out, '.extension');
const profileDir = resolve(out, '.profile');
const args = process.argv.slice(2).filter((a) => a !== '--');
const mock = args.includes('--mock');
const repoArg = args[args.indexOf('--repo') + 1];
const repo = args.includes('--repo') && repoArg ? repoArg : 'stephen-taipei/adorable-git-grpah';
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`--repo must be owner/name: ${repo}`);
const SIZE = { width: 1280, height: 800 };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let mockServer;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGG_')));
if (mock) {
  const { startMock } = await import('../../../tools/e2e/mock-github-api.mjs');
  mockServer = await startMock();
  env.AGG_API_BASE = `http://127.0.0.1:${mockServer.address().port}`;
}
env.AGG_OUT_DIR = extDir;
const built = spawnSync(process.execPath, ['scripts/build.mjs'], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
});
if (built.status !== 0) process.exit(built.status ?? 1);

const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath: findExtensionChrome(chromium),
  headless: false,
  viewport: SIZE,
  deviceScaleFactor: 1,
  locale: 'en-US',
  args: [
    '--headless=new',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
  ],
});

try {
  await assertExtensionLoaded(ctx);
  if (mock) {
    const { fakeGithubPage } = await import('../../../tools/e2e/fake-github-page.mjs');
    await ctx.route('https://github.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fakeGithubPage(new URL(route.request().url()).pathname.slice(1)),
      }),
    );
    await ctx.route('https://avatars.githubusercontent.com/**', (route) => route.abort());
  }
  const owner = mock ? 'demo' : repo.split('/')[0];
  const name = mock ? 'adorable-git-graph' : repo.split('/')[1];
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const open = async () => {
    await page.goto(`https://github.com/${owner}/${name}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.agg-fab').waitFor({ timeout: 30_000 });
    await page.locator('.agg-fab').click();
    await page.locator('.agg-commit').first().waitFor({ timeout: 60_000 });
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(400);
  };
  const shot = (file) => page.screenshot({ path: join(out, file) });

  await page.emulateMedia({ colorScheme: 'light' });
  await open();
  await shot('screenshot-1-graph.png');

  // 詳情：挑內文短的一般 commit（沒有內文或 4 行以內）；原樣換行的長內文在截圖裡斷句很怪
  const messageLines = () =>
    page
      .locator('.agg-detail-message')
      .evaluateAll((els) => (els[0] ? els[0].textContent.trim().split('\n').length : 0));
  const rows = Math.min(await page.locator('.agg-commit').count(), 15);
  let picked = false;
  let last = -1;
  for (let i = 1; i < rows && !picked; i++) {
    last = i;
    await page.locator('.agg-commit').nth(i).click();
    await page.locator('.agg-detail').waitFor();
    const row = page.locator('.agg-commit').nth(i);
    const merge = await row.locator('.agg-merge').count();
    // Revert / Merge 這類自動產生的訊息不適合當展示
    const auto = /\b(Revert "|Merge (pull request|branch))/.test(await row.innerText());
    picked = !merge && !auto && (await messageLines()) <= 4;
  }
  // 都不合適：退回第 4 列（再點一次已選的列會收起詳情，所以先換到別列）
  if (!picked && last !== 3) {
    await page.locator('.agg-commit').nth(3).click();
    await page.locator('.agg-detail').waitFor();
  }
  await page.waitForTimeout(600);
  await page.mouse.move(2, 2);
  await shot('screenshot-2-detail.png');
  await page.keyboard.press('Escape');

  await page.locator('.agg-search input').fill('fix');
  await page.waitForTimeout(500);
  await page.mouse.move(2, 2);
  await shot('screenshot-3-search.png');
  await page.locator('.agg-search input').fill('');

  // github.com 預設跟隨系統配色；假頁面固定 light，所以直接改 data-color-mode
  await page.emulateMedia({ colorScheme: 'dark' });
  await open();
  await page.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  await page.waitForTimeout(800);
  await shot('screenshot-4-dark.png');

  // 主題：糖果 → 駭客小惡魔（存在 extension storage；結束時整個 profile 會刪掉）
  await page.locator('.agg-theme-switch').click();
  await page.locator('.agg-root[data-theme-id="hacker"]').waitFor();
  await page.waitForTimeout(800);
  await page.mouse.move(2, 2);
  await shot('screenshot-5-theme.png');

  // 宣傳圖：圖示 + 名稱 + 一句話 + 第一張截圖的局部
  const icon = readFileSync(
    resolve(appRoot, '../../libs/extension-core/assets/icons/icon-128.png'),
  ).toString('base64');
  const graph = readFileSync(join(out, 'screenshot-1-graph.png')).toString('base64');
  const promo = async (file, w, h, big) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(`<!doctype html><html><head><style>
      *{box-sizing:border-box;margin:0}
      body{width:${w}px;height:${h}px;overflow:hidden;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;
        background:linear-gradient(135deg,#ffe3ec 0%,#e3f0ff 55%,#e9ffe9 100%);color:#2b2140;display:flex;align-items:center}
      .text{padding:0 ${big ? 72 : 26}px;flex:${big ? '0 0 560px' : '1'};z-index:1}
      img.icon{width:${big ? 112 : 64}px;height:${big ? 112 : 64}px;display:block;margin-bottom:${big ? 20 : 10}px}
      h1{font-size:${big ? 56 : 30}px;line-height:1.05;font-weight:800;letter-spacing:-.5px}
      p{margin-top:${big ? 16 : 8}px;font-size:${big ? 24 : 14}px;line-height:1.35;color:#5a4d73;font-weight:600}
      .shot{position:absolute;left:${big ? 600 : 248}px;top:${big ? 48 : 64}px;width:${big ? 860 : 420}px;border-radius:18px;
        border:4px solid #2b2140;box-shadow:0 18px 40px rgba(43,33,64,.25);overflow:hidden;background:#fff}
      .shot img{display:block;width:100%}
    </style></head><body>
      <div class="text"><img class="icon" src="data:image/png;base64,${icon}">
        <h1>Adorable<br>Git Graph</h1><p>Your GitHub history<br>as an animated,<br>cartoon git graph.</p></div>
      <div class="shot"><img src="data:image/png;base64,${graph}"></div>
    </body></html>`);
    await p.waitForTimeout(200);
    await p.screenshot({ path: join(out, file) });
    await p.close();
  };
  await promo('promo-small-440x280.png', 440, 280, false);
  await promo('promo-marquee-1400x560.png', 1400, 560, true);
  console.log(`\n✔ ${out}${mock ? '（--mock：測試資料，不要上傳）' : ''}`);
} finally {
  await ctx.close();
  mockServer?.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}
