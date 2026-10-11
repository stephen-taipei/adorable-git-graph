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

const TOKEN_KEY = 'agg.github-token';
const VIEWER_NONCE_KEY = 'agg:viewer-auth-nonce:v1';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function persistViewerNonce(): string {
  const nonce = crypto.randomUUID();
  sessionStorage.setItem(VIEWER_NONCE_KEY, nonce);
  if (sessionStorage.getItem(VIEWER_NONCE_KEY) !== nonce) throw new Error('Nonce not persisted');
  return nonce;
}

function initialAuthentication() {
  try {
    // A failed token read cannot establish an anonymous credential scope.
    const token = localStorage.getItem(TOKEN_KEY) ?? '';
    let nonce: string;
    try {
      const saved = sessionStorage.getItem(VIEWER_NONCE_KEY);
      nonce = saved && UUID.test(saved) ? saved : persistViewerNonce();
    } catch {
      nonce = crypto.randomUUID();
    }
    return { token, nonce, tokenReadable: true };
  } catch {
    return { token: '', nonce: crypto.randomUUID(), tokenReadable: false };
  }
}

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
  const [auth, setAuth] = useState(initialAuthentication);
  const { token } = auth;
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
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
          token={token}
          error={tokenError}
          onClose={() => setTokenOpen(false)}
          onSave={(next) => {
            try {
              const persisted = localStorage.getItem(TOKEN_KEY);
              if (
                auth.tokenReadable &&
                next === token &&
                (next ? persisted === next : persisted === null)
              ) {
                setTokenOpen(false);
                return;
              }
              // Rotate and verify before touching the credential. No token or
              // fingerprint enters the viewer key or its persisted metadata.
              const nonce = persistViewerNonce();
              if (next) localStorage.setItem(TOKEN_KEY, next);
              else localStorage.removeItem(TOKEN_KEY);
              if (localStorage.getItem(TOKEN_KEY) !== (next || null)) {
                throw new Error('Settings not persisted');
              }
              clearGitHubCache();
              setAuth({ token: next, nonce, tokenReadable: true });
              setTokenError(null);
            } catch {
              // A partial write may have persisted the new token. An unused,
              // ephemeral nonce makes both same-page and reload restoration
              // fail closed without committing an uncertain auth change.
              setAuth({ ...auth, nonce: crypto.randomUUID(), tokenReadable: false });
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
