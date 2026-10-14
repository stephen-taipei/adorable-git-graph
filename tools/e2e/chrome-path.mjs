import { existsSync } from 'node:fs';

/** 找一個可用的 Chrome / Chromium 執行檔（Playwright 內建安裝或系統安裝）。 */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome。請設定 CHROME_PATH 環境變數。');
  return hit;
}

/**
 * 能用 `--load-extension` 載入未封裝 extension 的 Chromium。Google Chrome 正式版（137 起）會忽略這個參數，
 * extension 根本不會載入，所以這裡不找系統的 Google Chrome：
 *   CHROME_PATH（自己指定的就照用）→ playwright-core 對應版本的 Chromium → 系統的 Chromium。
 */
/** @param {import('playwright-core').BrowserType} chromium 呼叫端自己的 playwright-core（tools/ 沒有相依套件） */
export function findExtensionChrome(chromium) {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH))
      throw new Error(`CHROME_PATH 不存在：${process.env.CHROME_PATH}`);
    return process.env.CHROME_PATH;
  }
  const candidates = [
    chromium.executablePath(),
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit)
    throw new Error(
      '找不到能載入 extension 的 Chromium（Google Chrome 正式版不支援 --load-extension）。\n' +
        '請先安裝一次：pnpm --filter @adorable/extension exec playwright-core install chromium\n' +
        '或設定 CHROME_PATH 指向 Chromium / Chrome for Testing。',
    );
  return hit;
}

/** 確認 extension 真的載入了（service worker 起來）；沒有就直接說清楚，而不是等到找不到按鈕才逾時。 */
export async function assertExtensionLoaded(ctx, timeout = 15_000) {
  if (ctx.serviceWorkers().length) return;
  try {
    await ctx.waitForEvent('serviceworker', { timeout });
  } catch {
    throw new Error(
      'extension 沒有載入（沒有 service worker）。這個瀏覽器可能忽略了 --load-extension（Google Chrome 137 起），' +
        '請改用 Chromium：pnpm --filter @adorable/extension exec playwright-core install chromium',
    );
  }
}
