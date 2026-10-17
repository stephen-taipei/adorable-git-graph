import en from './locales/en.json';
import { DEFAULT_LOCALE } from './locales';
import type { Locale } from './locales';

/** 一個語系的全部字串（形狀以 en.json 為準）。 */
export type Catalog = typeof en;

/** 複數形：Intl.PluralRules 的類別 → 字串；至少要有 other。 */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PartialCatalog = DeepPartial<Catalog>;

/** 讀取一個語系的字串（web：動態 import；extension：向 background 要）。 */
export type CatalogLoader = (locale: Locale) => Promise<PartialCatalog>;

const loaded = new Map<Locale, Catalog>([[DEFAULT_LOCALE, en]]);
const inflight = new Map<Locale, Promise<void>>();

/** 缺的字串退回英文：翻譯檔少一個 key 不會讓介面出現 undefined。 */
function withFallback<T>(base: T, over: unknown): T {
  if (over === undefined || over === null) return base;
  if (typeof base === 'string') return (typeof over === 'string' && over ? over : base) as T;
  if (typeof base !== 'object') return base;
  const src = over as Record<string, unknown>;
  // 複數形：每個語言的類別不同（俄文有 few / many，中文只有 other），整組用翻譯檔的，不混入英文的 one
  if ('other' in (base as object) && typeof src['other'] === 'string' && src['other']) {
    const forms: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v) forms[k] = v;
    return forms as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base as Record<string, unknown>))
    out[k] = withFallback(v, src[k]);
  return out as T;
}

export function registerCatalog(locale: Locale, catalog: PartialCatalog): void {
  loaded.set(locale, locale === DEFAULT_LOCALE ? en : withFallback(en, catalog));
  compiled.delete(locale);
}

export function hasCatalog(locale: Locale): boolean {
  return loaded.has(locale);
}

/** 已載入的字串；還沒載入的語系先用英文。 */
export function getCatalog(locale: Locale): Catalog {
  return loaded.get(locale) ?? en;
}

/** 載入語系（同一個語系只讀一次）。失敗時維持英文，不 throw。 */
export function loadLocale(locale: Locale, loader: CatalogLoader): Promise<void> {
  if (loaded.has(locale)) return Promise.resolve();
  let p = inflight.get(locale);
  if (!p) {
    p = loader(locale)
      .then((c) => registerCatalog(locale, c))
      .catch(() => {})
      .finally(() => inflight.delete(locale));
    inflight.set(locale, p);
  }
  return p;
}

/** 語系 → 由 catalog 產生的物件（例如 Messages）的快取；registerCatalog 時清掉。 */
export const compiled = new Map<Locale, Map<string, unknown>>();

export function memo<T>(locale: Locale, key: string, build: () => T): T {
  let m = compiled.get(locale);
  if (!m) compiled.set(locale, (m = new Map()));
  if (!m.has(key)) m.set(key, build());
  return m.get(key) as T;
}

/** `{name}` 換成 vars 裡的值；沒有的保留原樣。 */
export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** 依 n 選複數形（{n} 會被換成 n）。 */
export function plural(
  locale: Locale,
  forms: PluralForms,
  n: number,
  vars: Record<string, string | number> = {},
): string {
  let pr = pluralRules.get(locale);
  if (!pr) pluralRules.set(locale, (pr = new Intl.PluralRules(locale)));
  const form = forms[pr.select(n)] ?? forms.other;
  return format(form, { n, ...vars });
}
