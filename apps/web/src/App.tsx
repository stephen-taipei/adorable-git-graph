import { useCallback, useEffect, useRef, useState } from 'react';
import { GitGraphViewer } from '@adorable/graph-ui';
import { SourceBar, isThemeSetting } from './SourceBar';
import { TokenDialog } from './TokenDialog';
import { searchFromSource, sourceFromSearch } from './source';
import type { Source } from './source';
import { useStored } from './storage';
import { locale, t } from './i18n';
import { clearGitHubCache, useGraphSource } from './useGraphSource';
import { DEFAULT_REPO } from './protocol';
import {
  AuthConflict,
  GENERATION_KEY,
  TOKEN_KEY,
  ephemeralScope,
  forgetScope,
  initialAuth,
  saveCredential,
  syncAuth,
} from './authScope';

function useSource(): [Source, (s: Source) => void] {
  const [source, setSource] = useState<Source>(() => sourceFromSearch(location.search));
  useEffect(() => {
    const onPop = () => setSource(sourceFromSearch(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Source) => {
    const url = `${location.pathname}${searchFromSource(next)}`;
    // 同一個網址不要再疊一筆歷史（否則上一頁要按好幾次才會動）
    if (url !== `${location.pathname}${location.search}`) history.pushState({}, '', url);
    setSource(next);
  }, []);
  return [source, navigate];
}

export function App() {
  const [source, navigate] = useSource();
  // 最近一次看的本機 repo（從 GitHub 切回本機時回到它）
  const lastLocal = useRef<Source>({ kind: 'local' });
  // 靜態建置只有預設 repo：網址裡的 ?local= 不用帶回去
  if (source.kind === 'local') lastLocal.current = import.meta.env.DEV ? source : { kind: 'local' };
  const [theme, setTheme] = useStored('agg.theme', 'auto', isThemeSetting);
  const [auth, setAuth] = useState(initialAuth);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // Remounts the dialog so a refused stale draft is replaced by the current value.
  const [dialogRevision, setDialogRevision] = useState(0);
  const { token } = auth;
  const authRef = useRef(auth);
  authRef.current = auth;
  // Another tab can change or clear the shared credential at any time. Adopt
  // it with a new scope before anything restores or queries under it; that
  // render drops the old graph, selection and diagnostics with their requests.
  useEffect(() => {
    const sync = () => {
      const previous = authRef.current;
      const next = syncAuth(previous);
      if (next === previous) return;
      authRef.current = next;
      forgetScope(previous.nonce);
      clearGitHubCache();
      // An open dialog holds a draft of the previous credential; saving it
      // would silently undo the other tab's change.
      setTokenOpen(false);
      setAuth(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === TOKEN_KEY || e.key === GENERATION_KEY) sync();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) sync();
    };
    const onVisible = () => {
      if (!document.hidden) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    // Changes made between the initial read and subscribing.
    sync();
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const { state, refresh, repoName, diagnostics } = useGraphSource(source, token);
  const sourceKey =
    source.kind === 'github'
      ? `github:${source.owner}/${source.repo}`
      : `local:${source.id ?? DEFAULT_REPO}`;
  const viewerStateKey = JSON.stringify([
    sourceKey,
    source.kind === 'github' ? (source.commit ?? null) : null,
    source.kind === 'github' ? (source.pullRequest ?? null) : null,
    auth.nonce,
  ]);

  const title = repoName
    ? repoName.owner === 'local'
      ? repoName.name
      : `${repoName.owner}/${repoName.name}`
    : source.kind === 'github'
      ? `${source.owner}/${source.repo}`
      : t.localTitle;

  useEffect(() => {
    document.title = `${title} · Adorable Git Graph`;
    document.documentElement.lang = locale;
  }, [title]);

  return (
    <div className="web-root">
      <GitGraphViewer
        title={title}
        state={state}
        diagnostics={diagnostics}
        theme={theme === 'auto' ? 'auto' : theme}
        locale={locale}
        sourceKey={sourceKey}
        viewerStateKey={viewerStateKey}
        onRefresh={refresh}
        onOpenSettings={() => {
          setTokenError(null);
          setTokenOpen(true);
        }}
        headerExtra={
          <SourceBar
            source={source}
            lastLocal={lastLocal.current}
            onNavigate={navigate}
            theme={theme}
            onThemeChange={setTheme}
          />
        }
      />
      {tokenOpen && (
        <TokenDialog
          key={dialogRevision}
          token={token}
          error={tokenError}
          onClose={() => setTokenOpen(false)}
          onSave={(next) => {
            try {
              // No token or fingerprint enters the viewer key or its metadata.
              const current = authRef.current;
              const saved = saveCredential(current, next);
              if (saved) {
                forgetScope(current.nonce);
                clearGitHubCache();
                authRef.current = saved;
                setAuth(saved);
              }
              setTokenError(null);
            } catch (error) {
              if (error instanceof AuthConflict) {
                // Nothing was written. Adopt the other tab's credential (as a
                // storage event would) and let the user decide again.
                const current = authRef.current;
                const adopted = syncAuth(current);
                if (adopted !== current) {
                  authRef.current = adopted;
                  forgetScope(current.nonce);
                  clearGitHubCache();
                  setAuth(adopted);
                }
                setDialogRevision((n) => n + 1);
                setTokenError(
                  locale === 'zh-TW'
                    ? '另一個分頁已變更 GitHub token，這次未儲存。已載入目前設定，請確認後再試。'
                    : 'GitHub token was changed in another tab, so nothing was saved. The current settings are loaded; review them and retry.',
                );
                return;
              }
              // A partial write may have persisted the new token. An unused,
              // ephemeral scope makes both same-page and reload restoration
              // fail closed without committing an uncertain auth change.
              const current = authRef.current;
              forgetScope(current.nonce);
              const failed = { ...current, nonce: ephemeralScope(), tokenReadable: false };
              authRef.current = failed;
              setAuth(failed);
              setTokenError(
                locale === 'zh-TW'
                  ? '設定尚未確認保存。請允許瀏覽器儲存後重試。'
                  : 'Could not confirm saving settings. Allow browser storage and retry.',
              );
              return;
            }
            setTokenOpen(false);
          }}
        />
      )}
    </div>
  );
}
