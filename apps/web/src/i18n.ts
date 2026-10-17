import {
  detectLocale,
  effectiveLocale,
  format,
  getCatalog,
  isLocaleSetting,
  loadLocale,
} from '@adorable/graph-ui';
import type { Catalog, Locale, LocaleSetting } from '@adorable/graph-ui';
import { loadBundledLocale } from '@adorable/graph-ui/i18n/bundled';
import { readStored, writeStored } from './storage';

/** 使用者在 🌐 選單選的語言（`auto` = 跟隨瀏覽器語言），記在這個瀏覽器。 */
export const LOCALE_KEY = 'agg.locale';

type Web = Catalog['web'];
export type WebMessages = Omit<Web, 'schemeLabel' | 'schemeNames' | 'snapshotErrors'> & {
  schemeLabel: (id: string) => string;
  github: string;
  snapshotErrors: Record<string, string>;
  themeIdCandy: string;
  themeIdHacker: string;
  themeIdHalloween: string;
};

export function messagesFor(l: Locale): WebMessages {
  const { web, common } = getCatalog(l);
  const { schemeNames, ...rest } = web;
  return {
    ...rest,
    schemeLabel: (id) =>
      format(web.schemeLabel, { scheme: (schemeNames as Record<string, string>)[id] ?? id }),
    github: 'GitHub',
    themeIdCandy: common.themeIdCandy,
    themeIdHacker: common.themeIdHacker,
    themeIdHalloween: common.themeIdHalloween,
  };
}

function storedSetting(): LocaleSetting {
  const raw = readStored(LOCALE_KEY);
  return raw !== null && isLocaleSetting(raw) ? raw : 'auto';
}

export const localeSetting: LocaleSetting = storedSetting();
/** 瀏覽器語言對應到的語系（選單的「自動」） */
export const detectedLocale: Locale = detectLocale();
export const locale: Locale = effectiveLocale(localeSetting, detectedLocale);

/** 介面字串；`ready` 之前是英文（main.tsx 等 ready 之後才載入 App）。 */
export let t: WebMessages = messagesFor('en');

/** 目前語系的字串載入完成（失敗時維持英文）。 */
export const ready: Promise<void> = loadLocale(locale, loadBundledLocale).then(() => {
  t = messagesFor(locale);
});

/** 換語言：記住設定並重新載入頁面（網址保留目前的 repo；所有字串一次換好，不會半新半舊）。 */
export function changeLocale(next: LocaleSetting): void {
  if (next === localeSetting) return;
  writeStored(LOCALE_KEY, next === 'auto' ? null : next);
  location.reload();
}
