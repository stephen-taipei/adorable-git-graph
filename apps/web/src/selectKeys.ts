/**
 * macOS 的 Chrome / Safari：關著的 select 上按方向鍵 / Home / End / PageUp / PageDown 是打開原生選單，不會直接改值；
 * 在選單裡按 Enter 選定時才觸發一次 change，那就是使用者的最終選擇，不該再等。
 */
export const IS_MAC_SELECT: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform || nav.platform || '');
})();

type KeyLike = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/**
 * 這個按鍵會不會直接改變「關著的」select 的值（每按一下觸發一次 change，所以要等停下來才切換）：
 * 其他平台的方向鍵 / Home / End / Page 鍵，以及各平台的 type-ahead 字母。
 */
export function isKeyNav(e: KeyLike, mac: boolean = IS_MAC_SELECT): boolean {
  if (/^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/.test(e.key)) return !mac;
  return e.key.length === 1 && e.key !== ' ' && !e.altKey && !e.ctrlKey && !e.metaKey;
}
