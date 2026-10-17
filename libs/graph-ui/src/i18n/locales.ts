/**
 * 支援的介面語系（BCP 47）。每個語系都有一份 `locales/<tag>.json`；缺的字串退回英文（en.json）。
 *
 * - `name`：選單上顯示的名稱（用該語言自己的寫法）
 * - `chrome` / `firefox`：extension `_locales/` 的資料夾名稱（manifest 的 description / action 標題用）。
 *   兩個瀏覽器的語系代碼不同，也不是每個語系都有對應；沒有的（undefined）在那個瀏覽器上 manifest 文字退回英文，
 *   extension 內的介面仍然用這個語系（介面字串不靠 chrome.i18n）。
 */
export const LOCALES = [
  { tag: 'zh-Hant-TW', name: '繁體中文（台灣）', chrome: 'zh_TW', firefox: 'zh_TW' },
  { tag: 'zh-Hant-HK', name: '繁體中文（香港）' },
  { tag: 'zh-Hant', name: '繁體中文' },
  { tag: 'zh-Hans', name: '简体中文', chrome: 'zh_CN', firefox: 'zh_CN' },
  { tag: 'en', name: 'English', chrome: 'en', firefox: 'en' },
  { tag: 'ja', name: '日本語', chrome: 'ja', firefox: 'ja' },
  { tag: 'ko', name: '한국어', chrome: 'ko', firefox: 'ko' },
  { tag: 'vi', name: 'Tiếng Việt', chrome: 'vi', firefox: 'vi' },
  { tag: 'th', name: 'ไทย', chrome: 'th', firefox: 'th' },
  { tag: 'id', name: 'Bahasa Indonesia', chrome: 'id', firefox: 'id' },
  { tag: 'ms', name: 'Bahasa Melayu', chrome: 'ms', firefox: 'ms' },
  { tag: 'fil', name: 'Filipino', chrome: 'fil', firefox: 'fil' },
  { tag: 'my', name: 'မြန်မာ', firefox: 'my' },
  { tag: 'km', name: 'ខ្មែរ', firefox: 'km' },
  { tag: 'lo', name: 'ລາວ', firefox: 'lo' },
  { tag: 'hi', name: 'हिन्दी', chrome: 'hi', firefox: 'hi' },
  { tag: 'ar', name: 'العربية', dir: 'rtl', chrome: 'ar', firefox: 'ar' },
  { tag: 'he', name: 'עברית', dir: 'rtl', chrome: 'he', firefox: 'he' },
  { tag: 'tr', name: 'Türkçe', chrome: 'tr', firefox: 'tr' },
  { tag: 'ru', name: 'Русский', chrome: 'ru', firefox: 'ru' },
  { tag: 'uk', name: 'Українська', chrome: 'uk', firefox: 'uk' },
  { tag: 'pl', name: 'Polski', chrome: 'pl', firefox: 'pl' },
  { tag: 'cs', name: 'Čeština', chrome: 'cs', firefox: 'cs' },
  { tag: 'sk', name: 'Slovenčina', chrome: 'sk', firefox: 'sk' },
  { tag: 'hu', name: 'Magyar', chrome: 'hu', firefox: 'hu' },
  { tag: 'ro', name: 'Română', chrome: 'ro', firefox: 'ro' },
  { tag: 'hr', name: 'Hrvatski', chrome: 'hr', firefox: 'hr' },
  { tag: 'el', name: 'Ελληνικά', chrome: 'el', firefox: 'el' },
  { tag: 'de', name: 'Deutsch', chrome: 'de', firefox: 'de' },
  { tag: 'nl', name: 'Nederlands', chrome: 'nl', firefox: 'nl' },
  { tag: 'da', name: 'Dansk', chrome: 'da', firefox: 'da' },
  { tag: 'sv', name: 'Svenska', chrome: 'sv', firefox: 'sv' },
  { tag: 'nb', name: 'Norsk bokmål', chrome: 'no', firefox: 'nb_NO' },
  { tag: 'fi', name: 'Suomi', chrome: 'fi', firefox: 'fi' },
  { tag: 'fr', name: 'Français', chrome: 'fr', firefox: 'fr' },
  { tag: 'it', name: 'Italiano', chrome: 'it', firefox: 'it' },
  { tag: 'es', name: 'Español (España)', chrome: 'es', firefox: 'es_ES' },
  { tag: 'es-MX', name: 'Español (México)', chrome: 'es_419', firefox: 'es_MX' },
  { tag: 'pt', name: 'Português (Portugal)', chrome: 'pt_PT', firefox: 'pt_PT' },
  { tag: 'pt-BR', name: 'Português (Brasil)', chrome: 'pt_BR', firefox: 'pt_BR' },
  { tag: 'ca', name: 'Català', chrome: 'ca', firefox: 'ca' },
] as const satisfies readonly {
  tag: string;
  name: string;
  dir?: 'rtl';
  chrome?: string;
  firefox?: string;
}[];

export type Locale = (typeof LOCALES)[number]['tag'];

export const DEFAULT_LOCALE: Locale = 'en';

const BY_TAG = new Map<string, Locale>(LOCALES.map((l) => [l.tag.toLowerCase(), l.tag]));

export const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && BY_TAG.get(v.toLowerCase()) === v;

export function localeName(tag: Locale): string {
  return LOCALES.find((l) => l.tag === tag)!.name;
}

export function localeDir(tag: Locale): 'ltr' | 'rtl' {
  const l = LOCALES.find((x) => x.tag === tag) as { dir?: 'rtl' } | undefined;
  return l?.dir ?? 'ltr';
}

/** 舊的 / 別名語言代碼 → 支援的語系 */
const ALIASES: Record<string, Locale> = {
  no: 'nb',
  nn: 'nb',
  tl: 'fil',
  iw: 'he',
  in: 'id',
  zsm: 'ms',
};

/** 中文：依文字（Hant / Hans）與地區決定 */
function chinese(parts: string[]): Locale {
  const rest = parts.slice(1);
  const script = rest.find((p) => p.length === 4);
  const region = rest.find((p) => p.length === 2 || /^\d{3}$/.test(p));
  if (script === 'hant') {
    if (region === 'tw') return 'zh-Hant-TW';
    if (region === 'hk' || region === 'mo') return 'zh-Hant-HK';
    return 'zh-Hant';
  }
  if (script === 'hans') return 'zh-Hans';
  if (region === 'tw') return 'zh-Hant-TW';
  if (region === 'hk' || region === 'mo') return 'zh-Hant-HK';
  // zh、zh-CN、zh-SG …
  return 'zh-Hans';
}

/** 單一語言代碼 → 支援的語系；對不上就是 undefined。 */
export function matchLocale(input: string): Locale | undefined {
  const raw = input.trim().replace(/_/g, '-').toLowerCase();
  if (!raw) return undefined;
  const exact = BY_TAG.get(raw);
  if (exact) return exact;
  const parts = raw.split('-');
  const lang = parts[0]!;
  if (lang === 'zh') return chinese(parts);
  const region = parts.slice(1).find((p) => p.length === 2 || /^\d{3}$/.test(p));
  if (lang === 'pt') return region === 'br' ? 'pt-BR' : 'pt';
  // 西班牙以外（拉丁美洲、美國…）用墨西哥的用語
  if (lang === 'es') return !region || region === 'es' ? 'es' : 'es-MX';
  return BY_TAG.get(lang) ?? ALIASES[lang];
}

/** 依偏好順序（例如 navigator.languages）挑第一個支援的語系，都不支援就是英文。 */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const p of preferred) {
    const l = matchLocale(p);
    if (l) return l;
  }
  return DEFAULT_LOCALE;
}

/** 瀏覽器 / 系統的語言偏好（不含使用者在介面上的選擇）。 */
export function detectLocale(lang?: string): Locale {
  if (lang !== undefined) return resolveLocale([lang]);
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveLocale(langs.filter(Boolean));
}

/** 使用者的語言設定：`auto` 跟隨瀏覽器 / 系統。 */
export type LocaleSetting = Locale | 'auto';

export const isLocaleSetting = (v: unknown): v is LocaleSetting => v === 'auto' || isLocale(v);

export const effectiveLocale = (setting: LocaleSetting, detected = detectLocale()): Locale =>
  setting === 'auto' ? detected : setting;
