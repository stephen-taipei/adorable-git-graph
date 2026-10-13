import { useSyncExternalStore } from 'react';

export type GithubColorMode = 'day' | 'night' | 'auto';

/** GitHub 頁面目前的配色（<html data-color-mode>）：light → day、dark → night、其他（auto）→ 跟隨系統。 */
export function githubColorMode(): GithubColorMode {
  const mode = document.documentElement.getAttribute('data-color-mode');
  return mode === 'dark' ? 'night' : mode === 'light' ? 'day' : 'auto';
}

function subscribe(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });
  return () => mo.disconnect();
}

/** 跟著 GitHub 的配色即時切換：overlay 開著時在 GitHub 換深淺色，overlay 也跟著換。 */
export function useGithubColorMode(): GithubColorMode {
  return useSyncExternalStore(subscribe, githubColorMode);
}
