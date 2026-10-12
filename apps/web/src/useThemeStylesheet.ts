import { useEffect, useState } from 'react';
import type { ThemeId } from '@adorable/graph-ui';
import { THEME_STYLESHEETS, loadThemeStylesheet } from './themeLoader';

interface BootText {
  loading: string;
  failed: string;
  retry: string;
}

/** Focus to give back when the boot screen goes away (inert drops it). */
let focusBeforeBoot: HTMLElement | null = null;

/** Shows or hides the full-screen boot screen from index.html (absent in tests). */
function setBoot(state: 'loading' | 'done' | 'failed', text: BootText) {
  const boot = document.getElementById('agg-boot');
  const root = document.getElementById('root');
  // While the boot screen covers the app, keep the app out of focus and the a11y tree.
  if (root) {
    const covering = state !== 'done';
    if (covering && !root.inert) {
      const active = document.activeElement;
      focusBeforeBoot = active instanceof HTMLElement && root.contains(active) ? active : null;
    }
    root.inert = covering;
    if (!covering) {
      // Give focus back (the theme button after a switch), or to the viewer
      // on first load, which tried to take it while the app was inert.
      const target =
        focusBeforeBoot?.isConnected === true
          ? focusBeforeBoot
          : root.querySelector<HTMLElement>('.agg-root');
      if (target && (document.activeElement === document.body || !document.activeElement))
        target.focus({ preventScroll: true });
      focusBeforeBoot = null;
    }
  }
  if (!boot) return;
  boot.dataset['state'] = state === 'done' ? 'done' : 'loading';
  boot.setAttribute('aria-busy', String(state === 'loading'));
  boot.toggleAttribute('data-failed', state === 'failed');
  const status = document.getElementById('agg-boot-status');
  if (status) status.textContent = state === 'failed' ? text.failed : text.loading;
  const error = document.getElementById('agg-boot-error');
  if (error) error.hidden = state !== 'failed';
  const errorText = document.getElementById('agg-boot-error-text');
  if (errorText) errorText.textContent = text.failed;
  const retry = document.getElementById('agg-boot-retry');
  if (retry) retry.textContent = text.retry;
}

/**
 * Loads `themeId`'s stylesheet on demand and returns the theme that is
 * actually applied: null until the first one has loaded. The boot screen
 * covers the app until then and during each switch; a failed load keeps it
 * up with a retry button rather than showing an unstyled app.
 */
export function useThemeStylesheet(themeId: ThemeId, text: BootText): ThemeId | null {
  const [active, setActive] = useState<ThemeId | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setBoot('loading', text);
    loadThemeStylesheet(THEME_STYLESHEETS[themeId]).then(
      () => {
        if (!current) return;
        setActive(themeId);
        setBoot('done', text);
      },
      () => {
        if (current) setBoot('failed', text);
      },
    );
    return () => {
      current = false;
    };
    // `text` is locale-constant for the page's lifetime.
  }, [themeId, attempt]);

  useEffect(() => {
    const retry = document.getElementById('agg-boot-retry');
    if (!retry) return;
    const onRetry = () => setAttempt((n) => n + 1);
    retry.addEventListener('click', onRetry);
    return () => retry.removeEventListener('click', onRetry);
  }, []);

  return active;
}
