import { useEffect, useState } from 'react';
import {
  detectLocale,
  effectiveLocale,
  hasCatalog,
  isLocaleSetting,
  loadLocale,
} from '@adorable/graph-ui';
import type { CatalogLoader, Locale, LocaleSetting, PartialCatalog } from '@adorable/graph-ui';
import { sendToBackground } from '../shared/messages';
import type { LocaleCatalogResponse } from '../shared/messages';
import { useExtensionSetting } from './useExtensionSetting';

/** 介面語言的設定（`auto` = 瀏覽器語言），和主題一樣記在 extension 的本機儲存。 */
export const LOCALE_KEY = 'locale';

/**
 * content script 是單一 IIFE，不能按需載入 chunk：語系字串放在 extension 的 `locales/<tag>.json`，
 * 由 background 讀出來（content script 直接 fetch 需要把檔案設成 web_accessible_resources，讓 github.com 也讀得到）。
 */
export const backgroundCatalogLoader: CatalogLoader = async (locale) => {
  const res = await sendToBackground<LocaleCatalogResponse>({ type: 'locale-catalog', locale });
  if (!res?.ok) throw new Error(res?.error.message ?? 'no response');
  return res.data as PartialCatalog;
};

/**
 * 目前的語系（字串已載入的那個）、使用者的設定、更改設定。
 * 新語系的字串載入前維持原本的語系，不會先閃一下英文。
 */
export function useLocale(
  loader: CatalogLoader = backgroundCatalogLoader,
): [Locale, LocaleSetting, (next: LocaleSetting) => void] {
  const [setting, setSetting] = useExtensionSetting<LocaleSetting>(
    LOCALE_KEY,
    'auto',
    isLocaleSetting,
  );
  const wanted = effectiveLocale(setting, detectLocale());
  const [shown, setShown] = useState<Locale>(() => (hasCatalog(wanted) ? wanted : 'en'));
  useEffect(() => {
    let alive = true;
    void loadLocale(wanted, loader).then(() => {
      if (alive) setShown(hasCatalog(wanted) ? wanted : 'en');
    });
    return () => {
      alive = false;
    };
  }, [wanted, loader]);
  return [shown, setting, setSetting];
}
