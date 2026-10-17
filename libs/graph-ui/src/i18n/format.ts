import type { Locale } from './locales';

// Intl 物件建立很貴：幾千列的列表每列都 new 一個會讓載入更早的歷史時卡一下，按語系快取
const rtfCache = new Map<Locale, Intl.RelativeTimeFormat>();

export function formatRelative(iso: string, locale: Locale, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = (ms - now) / 1000;
  let rtf = rtfCache.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, rtf);
  }
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

const durationCache = new Map<Locale, Intl.NumberFormat>();

/** 「5 min」「5 分鐘」：至少 1 分鐘 */
export function formatDuration(ms: number, locale: Locale): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  let nf = durationCache.get(locale);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' });
    durationCache.set(locale, nf);
  }
  return nf.format(mins);
}
