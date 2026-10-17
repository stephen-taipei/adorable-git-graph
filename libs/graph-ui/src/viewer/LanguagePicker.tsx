import { LOCALES, getCatalog, format, localeName } from '../i18n';
import type { Locale, LocaleSetting } from '../i18n';

/**
 * 介面語言的選單：外觀是標題列的圓形按鈕（🌐），實際是原生 <select>（鍵盤、螢幕報讀器、手機都能用）。
 * `auto` 跟隨瀏覽器 / 系統語言（`detected`）。選項名稱一律用該語言自己的寫法。
 */
export function LanguagePicker({
  locale,
  setting,
  detected,
  onChange,
  className = 'agg-btn agg-lang',
  showLabel = false,
}: {
  /** 目前顯示的語系（標籤文字用這個語言） */
  locale: Locale;
  setting: LocaleSetting;
  /** `auto` 時會用的語系 */
  detected: Locale;
  onChange: (next: LocaleSetting) => void;
  className?: string;
  /** 顯示「語言」文字（例如 options page）；預設只有 🌐 圖示 */
  showLabel?: boolean;
}) {
  const c = getCatalog(locale).common;
  return (
    <label className={className} title={c.language}>
      <span aria-hidden="true">{showLabel ? `🌐 ${c.language}` : '🌐'}</span>
      <select
        aria-label={c.language}
        value={setting}
        onChange={(e) => onChange(e.target.value as LocaleSetting)}
      >
        <option value="auto">{format(c.languageAuto, { name: localeName(detected) })}</option>
        {LOCALES.map((l) => (
          <option key={l.tag} value={l.tag} lang={l.tag}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
