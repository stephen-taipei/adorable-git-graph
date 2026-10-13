import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, detectLocale, getMessages } from '@adorable/graph-ui';
import '@adorable/graph-ui/viewer.css';
import './styles.css';
import { App } from './App';
import { setBoot } from './useThemeStylesheet';
import type { BootText } from './useThemeStylesheet';

const m = getMessages(detectLocale());
const CRASH_TEXT: BootText = {
  loading: m.crashTitle,
  failed: `${m.crashTitle} — ${m.crashSub}`,
  retry: m.retry,
};

/**
 * Crash screen on the theme-neutral boot screen: it needs no theme stylesheet
 * (none may be loaded yet, or a different one than the default fallback
 * expects) and replaces a boot screen that would otherwise cover it.
 */
function BootCrash({ reset }: { reset: () => void }) {
  const hasBoot = Boolean(document.getElementById('agg-boot'));
  useEffect(() => {
    setBoot('failed', CRASH_TEXT);
    const retry = document.getElementById('agg-boot-retry');
    retry?.addEventListener('click', reset);
    return () => retry?.removeEventListener('click', reset);
  }, [reset]);
  return hasBoot ? null : <p role="alert">{CRASH_TEXT.failed}</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={(_error, reset) => <BootCrash reset={reset} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
