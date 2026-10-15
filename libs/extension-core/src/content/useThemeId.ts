import { DEFAULT_THEME, isThemeId, type ThemeId } from '@adorable/graph-ui';
import { useExtensionSetting } from './useExtensionSetting';

/** overlay 的主題（candy / hacker / halloween），和其他偏好一樣記在 extension 的本機儲存。 */
export const THEME_ID_KEY = 'themeId';

export function useThemeId(): [ThemeId, (id: ThemeId) => void] {
  return useExtensionSetting<ThemeId>(THEME_ID_KEY, DEFAULT_THEME, isThemeId);
}
