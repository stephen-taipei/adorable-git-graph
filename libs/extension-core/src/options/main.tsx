import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguagePicker, Mascot, detectLocale, format, getCatalog } from '@adorable/graph-ui';
import type { CatalogLoader, PartialCatalog } from '@adorable/graph-ui';
import { useLocale } from '../content/useLocale';
import { sendToBackground } from '../shared/messages';
import type { RateLimitResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings';
import { requestTokenConsent } from '../shared/consent';
import type { Settings } from '../shared/settings';
import './options.css';

/** options page 是 extension 自己的頁面：直接讀 locales/<tag>.json（不經 background） */
const fetchCatalog: CatalogLoader = async (locale) => {
  const res = await fetch(chrome.runtime.getURL(`locales/${locale}.json`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PartialCatalog;
};

function Options() {
  const [locale, localeSetting, setLocaleSetting] = useLocale(fetchCatalog);
  const t = getCatalog(locale).options;
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.title;
  }, [locale, t.title]);
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void loadSettings().then((v) => {
      setS(v);
      setLoaded(true);
    });
  }, []);

  const num = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS((p) => ({ ...p, [key]: Number(e.target.value) }));

  /** 有 token 才問（Firefox 的資料收集同意；要在 click 裡、任何 await 之前發出請求） */
  const consented = (): Promise<boolean> =>
    s.token.trim() ? requestTokenConsent() : Promise.resolve(true);

  const save = async () => {
    if (!(await consented())) return setStatus(t.consent);
    await saveSettings(s);
    setS(await loadSettings());
    setStatus(t.saved);
  };

  const test = async () => {
    if (!(await consented())) return setStatus(t.consent);
    await saveSettings(s);
    const res = await sendToBackground<RateLimitResponse>({ type: 'rate-limit' });
    setStatus(
      res.ok
        ? format(res.data.authenticated ? t.limitToken : t.limitAnonymous, {
            remaining: res.data.remaining,
            limit: res.data.limit,
          })
        : format(t.fail, { message: res.error.message }),
    );
  };

  const clear = async () => {
    await sendToBackground({ type: 'clear-cache' });
    setStatus(t.cleared);
  };

  return (
    <main className="card">
      <h1>
        <Mascot size={44} /> {t.title}
      </h1>
      <div className="lang-row">
        <LanguagePicker
          className="lang"
          locale={locale}
          setting={localeSetting}
          detected={detectLocale()}
          onChange={setLocaleSetting}
          showLabel
        />
      </div>
      <label>
        <span>{t.token}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="github_pat_…"
          value={s.token}
          disabled={!loaded}
          onChange={(e) => setS((p) => ({ ...p, token: e.target.value }))}
        />
      </label>
      <p className="help">{t.tokenHelp}</p>
      <p className="warn">{t.tokenWarn}</p>
      <div className="grid">
        <label>
          <span>{t.maxBranches}</span>
          <input
            type="number"
            min={1}
            max={12}
            value={s.maxBranches}
            onChange={num('maxBranches')}
          />
        </label>
        <label>
          <span>{t.maxCommits}</span>
          <input
            type="number"
            min={10}
            max={100}
            value={s.maxCommitsPerBranch}
            onChange={num('maxCommitsPerBranch')}
          />
        </label>
        <label>
          <span>{t.cache}</span>
          <input
            type="number"
            min={0}
            max={120}
            value={s.cacheMinutes}
            onChange={num('cacheMinutes')}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="cta" onClick={save}>
          {t.save}
        </button>
        <button type="button" className="cta ghost" onClick={test}>
          {t.test}
        </button>
        <button type="button" className="cta ghost" onClick={clear}>
          {t.clear}
        </button>
        <output aria-live="polite">{status}</output>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
