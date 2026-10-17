import {
  GitHubError,
  cacheDiagnostics,
  createGitHubDiagnostics,
  fetchGitHubCommitsFrom,
  fetchGitHubGraph,
  isDiagnosticRequest,
  isValidRepoSegment,
  withoutRateLimit,
} from '@adorable/graph-core';
import type { DiagnosticAdapter, GraphData } from '@adorable/graph-core';
import { isLocale } from '@adorable/graph-ui/i18n/locales';
import { parseFetchMore } from '../shared/history';
import { FETCH_MORE_MAX_STARTS, RPC_PORT } from '../shared/messages';
import type {
  BgError,
  BgRequest,
  BgResponse,
  FetchGraphResponse,
  FetchMoreResponse,
  RateLimitResponse,
  TabCommand,
} from '../shared/messages';
import { SETTINGS_KEY, loadSettings, type Settings } from '../shared/settings';
import { hasTokenConsent } from '../shared/consent';

/**
 * GitHub への要求にかける時間の上限。Firefox の background は event page で、アイドルが 30 秒続くと停止する。
 * 応答待ちの `sendResponse` はそれを延命しないので、その前に「ネットワークエラー」として明示的に失敗させる
 * （上限なしだと content script 側は "Receiving end does not exist" という分かりにくい失敗になる）。
 */
const FETCH_TIMEOUT_MS = 25_000;

const CACHE_PREFIX = 'cache:';
const CACHE_MAX_ENTRIES = 12;

interface CacheEntry {
  savedAt: number;
  credentialScope: string;
  graph: GraphData;
}

const inflight = new Map<string, Promise<FetchGraphResponse>>();
const inflightMore = new Map<string, Promise<FetchMoreResponse>>();
const diagnosticRequests = new Map<string, AbortController>();
const diagnosticAdapters = new Map<string, DiagnosticAdapter>();
const recoveryNotifications = new Map<number, { generation: string; promise: Promise<void> }>();
let settingsGeneration = 0;
let diagnosticGeneration = crypto.randomUUID();
let settingsSnapshot: Settings | undefined;
let settingsReads: Promise<void> = Promise.resolve();
let cacheInvalidation: Promise<void> = Promise.resolve();
function invalidateCache(): Promise<void> {
  cacheInvalidation = cacheInvalidation.catch(() => {}).then(clearCache);
  return cacheInvalidation;
}
class SourceChangedError extends Error {}
function assertGeneration(generation: number, tag?: string) {
  if (generation !== settingsGeneration || (tag !== undefined && tag !== diagnosticGeneration))
    throw new SourceChangedError();
}
function withinRequest<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(
        signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
          ? signal.reason
          : new DOMException('Aborted', 'AbortError'),
      );
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function notifyInvalidated(tabId: number): Promise<void> {
  const generation = diagnosticGeneration;
  const prior = recoveryNotifications.get(tabId);
  if (prior?.generation === generation) return prior.promise;
  const entry = {
    generation,
    promise: Promise.resolve()
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'data-invalidated' } satisfies TabCommand))
      .then(() => undefined),
  };
  recoveryNotifications.set(tabId, entry);
  void entry.promise.catch(() => {
    if (recoveryNotifications.get(tabId) === entry) recoveryNotifications.delete(tabId);
  });
  return entry.promise;
}
function rotateGeneration() {
  settingsGeneration++;
  diagnosticGeneration = crypto.randomUUID();
  diagnosticRequests.forEach((controller) => controller.abort());
  diagnosticRequests.clear();
  diagnosticAdapters.clear();
  recoveryNotifications.clear();
  inflight.clear();
  inflightMore.clear();
  void invalidateCache().catch(() => {});
  // Delivery and cache removal are independent; slow storage must not preserve old adapters.
  void chrome.tabs
    .query({})
    .then((tabs) =>
      Promise.allSettled(
        tabs.filter((tab) => tab.id != null).map((tab) => notifyInvalidated(tab.id!)),
      ),
    )
    .catch(() => {});
}
/** 實際拿來呼叫 API 的設定：Firefox 上沒有「驗證資訊」的資料收集同意時不送 token。 */
async function loadUsableSettings(): Promise<Settings> {
  const settings = await loadSettings();
  return settings.token && !(await hasTokenConsent()) ? { ...settings, token: '' } : settings;
}
function readScopedSettings() {
  // Serialize only settings reads/adoption. An older read cannot overwrite a newer snapshot.
  const pending = settingsReads.then(async () => {
    const before = settingsGeneration;
    const settings = await loadUsableSettings();
    assertGeneration(before);
    if (settingsSnapshot && JSON.stringify(settingsSnapshot) !== JSON.stringify(settings))
      rotateGeneration();
    settingsSnapshot = settings;
    return { settings, generation: settingsGeneration, tag: diagnosticGeneration };
  });
  settingsReads = pending.then(
    () => {},
    () => {},
  );
  return pending;
}
function diagnosticsFor(owner: string, repo: string, token: string): DiagnosticAdapter {
  const key = `${diagnosticGeneration}:${owner}/${repo}`.toLowerCase();
  let adapter = diagnosticAdapters.get(key);
  if (!adapter) {
    adapter = cacheDiagnostics(
      createGitHubDiagnostics(owner, repo, {
        token: token || undefined,
        apiBase: __AGG_API_BASE__,
      }),
    );
  }
  diagnosticAdapters.delete(key);
  diagnosticAdapters.set(key, adapter);
  while (diagnosticAdapters.size > CACHE_MAX_ENTRIES)
    diagnosticAdapters.delete(diagnosticAdapters.keys().next().value!);
  return adapter;
}
async function credentialScope(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}

function toError(err: unknown): BgError {
  if (err instanceof SourceChangedError)
    return { code: 'source_changed', message: 'Settings changed; reload the graph' };
  if (err instanceof DOMException && err.name === 'TimeoutError')
    return { code: 'network', message: 'Query timed out' };
  if (err instanceof GitHubError)
    return { code: err.code, message: err.message, resetAt: err.resetAt };
  return { code: 'unknown', message: 'Query unavailable' };
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .map(([k, v]) => [k, (v as CacheEntry).savedAt ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const stale = entries.slice(CACHE_MAX_ENTRIES).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

/**
 * owner / repo 在 GitHub 不分大小寫，所以正規化；branch 名稱分大小寫（`Feature/Login` ≠ `feature/login`），保留原樣。
 * 結構化成 JSON 避免欄位串接後彼此混淆。舊格式（整串 toLowerCase）的 key 不會再被讀到，由 pruneCache 依 savedAt 淘汰。
 */
function graphCacheKey(
  owner: string,
  repo: string,
  branchHint: string | undefined,
  maxBranches: number,
  maxCommitsPerBranch: number,
): string {
  return (
    CACHE_PREFIX +
    JSON.stringify([
      'v2',
      owner.toLowerCase(),
      repo.toLowerCase(),
      branchHint ?? '',
      maxBranches,
      maxCommitsPerBranch,
    ])
  );
}

type GraphRequest = Extract<BgRequest, { type: 'fetch-graph' }>;
type SettingsScope = Awaited<ReturnType<typeof readScopedSettings>>;
async function validateSettingsScope(scoped: SettingsScope, signal: AbortSignal): Promise<void> {
  assertGeneration(scoped.generation, scoped.tag);
  await withinRequest(cacheInvalidation, signal);
  assertGeneration(scoped.generation, scoped.tag);
  await withinRequest(readScopedSettings(), signal);
  assertGeneration(scoped.generation, scoped.tag);
  await withinRequest(cacheInvalidation, signal);
  assertGeneration(scoped.generation, scoped.tag);
  signal.throwIfAborted();
}
async function fetchGraphScoped(
  req: GraphRequest,
  scoped: SettingsScope,
): Promise<FetchGraphResponse> {
  try {
    // A shared producer owns its deadline; an individual consumer cannot cancel it.
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const { settings, generation, tag } = scoped;
    await withinRequest(cacheInvalidation, signal);
    assertGeneration(generation, tag);
    const scope = await withinRequest(credentialScope(settings.token), signal);
    assertGeneration(generation, tag);
    const key = graphCacheKey(
      req.owner,
      req.repo,
      req.branchHint,
      settings.maxBranches,
      settings.maxCommitsPerBranch,
    );
    if (!req.force && settings.cacheMinutes > 0) {
      const hit = (await withinRequest(chrome.storage.local.get(key), signal))[key] as
        CacheEntry | undefined;
      assertGeneration(generation, tag);
      if (
        hit &&
        hit.credentialScope === scope &&
        Date.now() - hit.savedAt < settings.cacheMinutes * 60_000
      ) {
        await validateSettingsScope(scoped, signal);
        return { ok: true, data: { graph: hit.graph, fromCache: true, diagnosticGeneration: tag } };
      }
    }
    const graph = await withinRequest(
      fetchGitHubGraph(req.owner, req.repo, {
        token: settings.token || undefined,
        apiBase: __AGG_API_BASE__,
        branchHint: req.branchHint,
        maxBranches: settings.maxBranches,
        maxCommitsPerBranch: settings.maxCommitsPerBranch,
        signal,
      }),
      signal,
    );
    await validateSettingsScope(scoped, signal);
    if (settings.cacheMinutes > 0) {
      try {
        // Await the actual write so a late stale write cannot land after its cleanup.
        await chrome.storage.local.set({
          // rate limit 是抓取當下的額度：不進 cache，cache 命中的圖就不會顯示過時的剩餘次數
          [key]: {
            savedAt: Date.now(),
            graph: withoutRateLimit(graph),
            credentialScope: scope,
          } satisfies CacheEntry,
        });
        await pruneCache();
        await validateSettingsScope(scoped, signal);
      } catch (err) {
        // A previously failed clear stays failed until an explicit retry/setting change.
        await cacheInvalidation;
        await invalidateCache();
        throw err;
      }
    }
    return { ok: true, data: { graph, fromCache: false, diagnosticGeneration: tag } };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}
async function fetchGraph(req: GraphRequest): Promise<FetchGraphResponse> {
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    await withinRequest(cacheInvalidation, signal);
    const scoped = await withinRequest(readScopedSettings(), signal);
    await withinRequest(cacheInvalidation, signal);
    assertGeneration(scoped.generation, scoped.tag);
    signal.throwIfAborted();
    const key = JSON.stringify([
      scoped.generation,
      scoped.tag,
      req.owner,
      req.repo,
      req.branchHint ?? '',
      Boolean(req.force),
    ]);
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchGraphScoped(req, scoped).finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key);
      });
      inflight.set(key, pending);
    }
    const response = await withinRequest(pending, signal);
    await validateSettingsScope(scoped, signal);
    return response;
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

/**
 * infinite scroll：從 content script 給的 missing parent 各往回抓一頁（每頁筆數 = 設定的「每條分支抓幾筆」）。
 * 不寫快取：快取只存第一批，重新整理 / 換 repo 都從第一批重新開始。
 * `generation` 是第一批回傳的 diagnosticGeneration：設定（token）換過之後就不再用新的 credential 補舊的圖。
 */
async function fetchMore(
  req: Extract<BgRequest, { type: 'fetch-more' }>,
): Promise<FetchMoreResponse> {
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    await withinRequest(cacheInvalidation, signal);
    const scoped = await withinRequest(readScopedSettings(), signal);
    assertGeneration(scoped.generation, req.generation);
    const commits = await withinRequest(
      fetchGitHubCommitsFrom(req.owner, req.repo, req.shas, {
        token: scoped.settings.token || undefined,
        apiBase: __AGG_API_BASE__,
        perPage: scoped.settings.maxCommitsPerBranch,
        maxStarts: FETCH_MORE_MAX_STARTS,
        signal,
      }),
      signal,
    );
    await validateSettingsScope(scoped, signal);
    return { ok: true, data: { commits } };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

async function rateLimit(): Promise<RateLimitResponse> {
  const settings = await loadUsableSettings();
  try {
    const res = await fetch(`${__AGG_API_BASE__}/rate_limit`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
      },
    });
    if (res.status === 401)
      return { ok: false, error: { code: 'unauthorized', message: 'Bad credentials' } };
    if (!res.ok) return { ok: false, error: { code: 'unknown', message: `HTTP ${res.status}` } };
    const body = (await res.json()) as {
      resources?: { core?: { limit: number; remaining: number; reset: number } };
    };
    const core = body.resources?.core;
    if (!core) return { ok: false, error: { code: 'unknown', message: 'Unexpected response' } };
    return {
      ok: true,
      data: { ...core, reset: core.reset * 1000, authenticated: Boolean(settings.token) },
    };
  } catch (err) {
    return { ok: false, error: { code: 'network', message: toError(err).message } };
  }
}

function handleRequest(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: BgResponse) => void,
): boolean {
  // 只接受自己這個 extension 的 context（content script / options page）
  if (sender.id !== chrome.runtime.id) return false;
  const req = raw as BgRequest | undefined;
  switch (req?.type) {
    case 'diagnostic-cancel': {
      if (typeof req.requestId === 'string')
        diagnosticRequests.get(`${sender.tab?.id ?? 'options'}:${req.requestId}`)?.abort();
      sendResponse({ ok: true, data: null });
      return false;
    }
    case 'diagnostic': {
      if (
        typeof req.owner !== 'string' ||
        typeof req.repo !== 'string' ||
        !isValidRepoSegment(req.owner) ||
        !isValidRepoSegment(req.repo) ||
        typeof req.requestId !== 'string' ||
        !/^[a-z0-9-]{1,64}$/i.test(req.requestId) ||
        !isDiagnosticRequest(req.query) ||
        diagnosticRequests.size >= 24
      ) {
        sendResponse({
          ok: false,
          error: { code: 'invalid_repo', message: 'Invalid diagnostic request' },
        });
        return false;
      }
      if (typeof req.generation !== 'string' || req.generation !== diagnosticGeneration) {
        sendResponse({ ok: false, error: toError(new SourceChangedError()) });
        // Legacy content must reload its page; do not create a refresh loop for missing tags.
        if (typeof req.generation === 'string' && sender.tab?.id != null)
          void notifyInvalidated(sender.tab.id).catch(() => {});
        return false;
      }
      const key = `${sender.tab?.id ?? 'options'}:${req.requestId}`;
      diagnosticRequests.get(key)?.abort();
      const controller = new AbortController(),
        generation = settingsGeneration;
      diagnosticRequests.set(key, controller);
      void (async () => {
        try {
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(FETCH_TIMEOUT_MS),
          ]);
          await withinRequest(cacheInvalidation, signal);
          const scoped = await withinRequest(readScopedSettings(), signal);
          assertGeneration(generation, req.generation);
          await withinRequest(cacheInvalidation, signal);
          assertGeneration(scoped.generation, req.generation);
          signal.throwIfAborted();
          const adapter = diagnosticsFor(req.owner, req.repo, scoped.settings.token);
          const query = req.query;
          const work =
            query.operation === 'compare'
              ? adapter.compare(query.base, query.head, signal)
              : query.operation === 'changes'
                ? adapter.changes(query.sha, query.parent, signal, query.commitRepo)
                : query.operation === 'patch'
                  ? adapter.patch(
                      query.base,
                      query.head,
                      query.path,
                      query.previousPath,
                      signal,
                      query.headRepo,
                    )
                  : adapter.pullRequest!(query.number, signal);
          const data = await withinRequest<Awaited<typeof work>>(work, signal);
          await validateSettingsScope(scoped, signal);
          assertGeneration(generation, req.generation);
          signal.throwIfAborted();
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({
            ok: false,
            error: toError(
              generation !== settingsGeneration || req.generation !== diagnosticGeneration
                ? new SourceChangedError()
                : e,
            ),
          });
        } finally {
          controller.abort();
          if (diagnosticRequests.get(key) === controller) diagnosticRequests.delete(key);
        }
      })();
      return true;
    }
    case 'fetch-graph': {
      if (
        typeof req.owner !== 'string' ||
        typeof req.repo !== 'string' ||
        !isValidRepoSegment(req.owner) ||
        !isValidRepoSegment(req.repo)
      ) {
        sendResponse({
          ok: false,
          error: { code: 'invalid_repo', message: 'Invalid repository' },
        });
        return false;
      }
      void fetchGraph(req).then(sendResponse);
      return true;
    }
    case 'fetch-more': {
      // content script 送來的內容一律重新驗證（repo 名稱、40 位 hex 的 sha、起點數量），不合法就不碰網路
      const more = parseFetchMore(req);
      if (!more) {
        sendResponse({ ok: false, error: { code: 'invalid', message: 'Invalid request' } });
        return false;
      }
      const key = JSON.stringify([
        more.generation,
        more.owner,
        more.repo,
        ...more.shas,
      ]).toLowerCase();
      let p = inflightMore.get(key);
      if (!p) {
        const pending = fetchMore(more).finally(() => {
          if (inflightMore.get(key) === pending) inflightMore.delete(key);
        });
        inflightMore.set(key, pending);
        p = pending;
      }
      void p.then(sendResponse);
      return true;
    }
    case 'rate-limit':
      void rateLimit().then(sendResponse);
      return true;
    case 'clear-cache':
      diagnosticAdapters.clear();
      void invalidateCache().then(
        () => sendResponse({ ok: true, data: null }),
        () => sendResponse({ ok: false, error: { code: 'unknown', message: 'Cache unavailable' } }),
      );
      return true;
    case 'locale-catalog': {
      // 只接受支援的語系代碼：不會拿訊息內容組出任意的檔案路徑
      if (!isLocale(req.locale)) {
        sendResponse({ ok: false, error: { code: 'unknown', message: 'Unsupported locale' } });
        return false;
      }
      void fetch(chrome.runtime.getURL(`locales/${req.locale}.json`))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(
          (data: unknown) => sendResponse({ ok: true, data }),
          (err: unknown) =>
            sendResponse({ ok: false, error: { code: 'unknown', message: toError(err).message } }),
        );
      return true;
    }
    case 'open-options':
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true, data: null });
      return false;
    default:
      return false;
  }
}

chrome.runtime.onMessage.addListener(handleRequest);

// sendToBackground 的 port：一條連線一個請求。對方先斷開（換頁）就不回應；同步處理完卻沒有回應的請求回 null。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RPC_PORT || port.sender?.id !== chrome.runtime.id) return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  port.onMessage.addListener((raw: unknown) => {
    let answered = false;
    const reply = (res: BgResponse | null) => {
      if (answered || !open) return;
      answered = true;
      try {
        port.postMessage(res);
      } catch {
        // 對方剛好斷開
      }
    };
    if (!handleRequest(raw, port.sender!, reply)) reply(null);
  });
});

// token 或抓取範圍變更 → 舊 cache 可能含私有資料 / 不符新設定，直接清掉。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEY in changes) {
    // Event payloads may be delayed; invalidate immediately, then read current storage in order.
    rotateGeneration();
  }
});

// 點工具列圖示 → 切換目前 GitHub 分頁上的圖。
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' } satisfies TabCommand);
  } catch {
    // 不是 github.com 分頁（或剛安裝尚未重新整理）→ 以 badge 提示；badge 是 tab 專屬，換頁會自動清除。
    await chrome.action.setBadgeBackgroundColor({ color: '#ff7a8a', tabId: tab.id });
    await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
  }
});
