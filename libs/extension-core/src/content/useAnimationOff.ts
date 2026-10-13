import { useExtensionSetting } from './useExtensionSetting';

/** 「關閉動畫」記在 extension 的本機儲存，和詳情面板大小一樣（不寫進 github.com 的 localStorage）。 */
export const ANIMATION_OFF_KEY = 'animationOff';

/** 舊版由 viewer 自己寫在頁面（github.com）的 localStorage。 */
export const LEGACY_ANIMATION_OFF_KEY = 'agg:animation-off';

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** 舊版的設定搬進 extension storage，並從 github.com 的 localStorage 移除。 */
function takeLegacy(): boolean | undefined {
  try {
    const raw = localStorage.getItem(LEGACY_ANIMATION_OFF_KEY);
    if (raw === null) return undefined;
    localStorage.removeItem(LEGACY_ANIMATION_OFF_KEY);
    return raw === 'true';
  } catch {
    return undefined;
  }
}

export function useAnimationOff(): [boolean, (off: boolean) => void] {
  return useExtensionSetting<boolean>(ANIMATION_OFF_KEY, false, isBoolean, takeLegacy);
}
