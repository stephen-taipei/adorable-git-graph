import type { CatalogLoader, PartialCatalog } from './catalog';

// 每個語系一個 chunk（Vite 的動態 import）：web app 只下載用到的語系。
// extension 的 content script 是單一 IIFE（動態 import 會被全部內嵌），所以不用這個，改由 background 讀 dist/locales/*.json。
const files = import.meta.glob<PartialCatalog>('./locales/*.json', { import: 'default' });

export const loadBundledLocale: CatalogLoader = (locale) => {
  const file = files[`./locales/${locale}.json`];
  return file ? file() : Promise.reject(new Error(`No catalog for ${locale}`));
};
