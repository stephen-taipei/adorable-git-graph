import { appendCommits, missingParents } from './history.ts';
import type { CommitInput, GraphData, RateLimitInfo, RefInput } from './types.ts';
import { coverage } from './diagnostics.ts';

export type GitHubErrorCode =
  | 'invalid_repo'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'empty_repo'
  | 'network'
  | 'unknown';

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  /** rate limit 重置時間（ms epoch） */
  readonly resetAt?: number;
  /** GitHub 回應的 HTTP 狀態碼（網路錯誤、輸入驗證失敗時沒有） */
  readonly status?: number;

  constructor(code: GitHubErrorCode, message: string, resetAt?: number, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.resetAt = resetAt;
    this.status = status;
  }
}

export interface GitHubGraphOptions {
  token?: string;
  /** 預設 https://api.github.com */
  apiBase?: string;
  /** 每條 branch 最多抓幾筆 commit。預設 60（上限 100）。 */
  maxCommitsPerBranch?: number;
  /** 最多追蹤幾條 branch（含 default）。預設 5。 */
  maxBranches?: number;
  /** 使用者正在瀏覽的 branch（或 `/tree/` 之後的路徑），優先納入。 */
  branchHint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function isValidRepoSegment(s: string): boolean {
  return NAME_RE.test(s) && s !== '.' && s !== '..';
}

/** `/tree/<a>/<b>/file` 中 branch 名可能含 `/`：取最長且存在於 branch 清單的前綴。 */
export function resolveBranchHint(
  hintPath: string | undefined,
  branchNames: readonly string[],
): string | undefined {
  if (!hintPath) return undefined;
  const parts = hintPath.split('/').filter(Boolean);
  const names = new Set(branchNames);
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('/');
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

interface ApiCommit {
  sha: string;
  html_url?: string;
  parents?: Array<{ sha: string }>;
  commit: {
    message?: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
  author?: { login?: string; avatar_url?: string } | null;
}

interface ApiBranch {
  name: string;
  commit: { sha: string };
}

interface ApiRef {
  ref: string;
  object?: { sha?: string } | null;
}

/** branch 名稱可含 `/`：逐段 encode，保留分隔用的 `/`。 */
function encodeRefPath(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}

interface ApiPull {
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
}

interface ApiTag {
  name: string;
  commit: { sha: string };
}

interface ApiRepo {
  name: string;
  default_branch: string;
  html_url?: string;
  owner?: { login?: string };
}

export function mapApiCommit(c: ApiCommit): CommitInput {
  return {
    sha: c.sha,
    parents: (c.parents ?? []).map((p) => p.sha),
    message: c.commit.message ?? '',
    authorName: c.commit.author?.name ?? c.author?.login ?? 'unknown',
    authorLogin: c.author?.login,
    avatarUrl: c.author?.avatar_url,
    date: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
    url: c.html_url,
  };
}

/** 呼叫 GitHub REST API 的共用設定（fetchGitHubGraph / fetchGitHubCommitsFrom 共用）。 */
interface RequestOptions {
  token?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** `/repos/<owner>/<repo>`；名稱不合法時在碰網路之前就丟 invalid_repo。 */
function repoPathOf(owner: string, repo: string): string {
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    throw new GitHubError('invalid_repo', `Invalid repository: ${owner}/${repo}`);
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** 每頁筆數：預設 60，限制在 1–100（GitHub 的 per_page 上限）。 */
function clampPerPage(n: number | undefined): number {
  const v = Math.floor(n ?? 60);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 100) : 60;
}

/** 從回應標頭讀 rate limit；三個標頭缺任何一個（或不是數字）就當作沒有。 */
function readRateLimit(headers: Headers | undefined): RateLimitInfo | undefined {
  const num = (name: string) => {
    const raw = headers?.get(name);
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const remaining = num('x-ratelimit-remaining');
  const limit = num('x-ratelimit-limit');
  const reset = num('x-ratelimit-reset');
  if (remaining === undefined || limit === undefined || reset === undefined) return undefined;
  return { remaining, limit, resetAt: reset * 1000 };
}

/**
 * 平行請求的回應順序不固定：重置時間較晚的是較新的時段；同一個時段裡剩餘次數最少的就是最新的值。
 */
function newerRateLimit(prev: RateLimitInfo | undefined, next: RateLimitInfo): RateLimitInfo {
  if (!prev || next.resetAt > prev.resetAt) return next;
  if (next.resetAt < prev.resetAt) return prev;
  return next.remaining < prev.remaining ? next : prev;
}

/** GET 一個 API 路徑並解析 JSON；HTTP / 網路失敗一律轉成 GitHubError（呼叫端主動 abort 除外）。 */
function githubGetter(opts: RequestOptions) {
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  /** 成功回應帶來的最新 rate limit（見 newerRateLimit）；回應沒有這些標頭就維持 undefined。 */
  let rateLimit: RateLimitInfo | undefined;

  const get = async function get<T>(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    // 逾時（TimeoutError）/ 連線中斷 → network；呼叫端主動 abort（AbortError）原樣往外丟。fetch 與讀 body 兩段都可能發生
    const asNetworkError = (err: unknown): unknown =>
      (err as { name?: string }).name === 'AbortError'
        ? err
        : new GitHubError('network', `Network error: ${(err as Error).message}`);

    let res: Response;
    try {
      res = await doFetch(url.toString(), { headers, signal: opts.signal });
    } catch (err) {
      throw asNetworkError(err);
    }
    if (res.ok) {
      const seen = readRateLimit(res.headers);
      if (seen) rateLimit = newerRateLimit(rateLimit, seen);
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw asNetworkError(err);
      }
    }

    const status = res.status;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || undefined;
    if (status === 429 || (status === 403 && remaining === '0')) {
      throw new GitHubError('rate_limited', 'GitHub API rate limit exceeded', reset, status);
    }
    if (status === 401) throw new GitHubError('unauthorized', 'Bad credentials', undefined, status);
    if (status === 404) {
      throw new GitHubError('not_found', 'Repository not found', undefined, status);
    }
    if (status === 403) throw new GitHubError('unauthorized', 'Forbidden', undefined, status);
    if (status === 409) {
      throw new GitHubError('empty_repo', 'Repository is empty', undefined, status);
    }
    throw new GitHubError('unknown', `GitHub API error ${status}`, undefined, status);
  };
  return Object.assign(get, { rateLimit: () => rateLimit });
}

/**
 * 剩餘額度是否偏低，值得提醒使用者加 token。
 * 未登入（limit ≤ 60）時一次沒有 cache 的載入就要 5–9 個請求，剩不到一半（約 3、4 次載入）就提醒；
 * 有 token 的額度大得多，剩不到 20% 才提醒。重置時間已過（額度已恢復）不提醒。
 */
export function isRateLimitLow(rateLimit: RateLimitInfo | undefined, now = Date.now()): boolean {
  if (!rateLimit || rateLimit.limit <= 0 || rateLimit.resetAt <= now) return false;
  const ratio = rateLimit.limit <= 60 ? 0.5 : 0.2;
  return rateLimit.remaining < rateLimit.limit * ratio;
}

/** 存進 cache 前拿掉 rateLimit：那是抓取當下的額度，cache 命中時早就過時了。 */
export function withoutRateLimit(data: GraphData): GraphData {
  if (data.rateLimit === undefined) return data;
  const { rateLimit: _stale, ...rest } = data;
  return rest;
}

export async function fetchGitHubGraph(
  owner: string,
  repo: string,
  opts: GitHubGraphOptions = {},
): Promise<GraphData> {
  const repoPath = repoPathOf(owner, repo);
  const get = githubGetter(opts);
  const perBranch = clampPerPage(opts.maxCommitsPerBranch);
  const maxBranches = Math.max(opts.maxBranches ?? 5, 1);

  const repoInfo = await get<ApiRepo>(repoPath);
  const defaultBranch = repoInfo.default_branch;

  // tags 失敗不致命
  let tagsUnavailable = false;
  const [branches, pulls, tags] = await Promise.all([
    get<ApiBranch[]>(`${repoPath}/branches`, { per_page: 100 }),
    get<ApiPull[]>(`${repoPath}/pulls`, {
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    }).catch(() => [] as ApiPull[]),
    get<ApiTag[]>(`${repoPath}/tags`, { per_page: 30 }).catch((err) => {
      if (opts.signal?.aborted) throw err;
      tagsUnavailable = true;
      return [] as ApiTag[];
    }),
  ]);

  const headBySha = new Map(branches.map((b) => [b.name, b.commit.sha]));
  // /branches 只取第一頁（最多 100 條）。頁滿時，預設分支與正在瀏覽的分支可能在後面的頁：
  // 不靠第一頁碰運氣，改用 matching-refs 定向補查（各一次請求、只在頁滿時發生；失敗不致命，仍標 branch_page_limit）。
  const branchPageFull = branches.length >= 100;
  const lookupBranches = async (prefix: string): Promise<void> => {
    try {
      const refs = await get<ApiRef[]>(
        `${repoPath}/git/matching-refs/heads/${encodeRefPath(prefix)}`,
      );
      for (const r of refs) {
        const name = r.ref.startsWith('refs/heads/') ? r.ref.slice('refs/heads/'.length) : '';
        if (name && r.object?.sha && !headBySha.has(name)) headBySha.set(name, r.object.sha);
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
    }
  };
  if (branchPageFull) {
    const hintParts = opts.branchHint?.split('/').filter(Boolean) ?? [];
    const firstPageHint = resolveBranchHint(opts.branchHint, [...headBySha.keys()]);
    await Promise.all([
      defaultBranch && !headBySha.has(defaultBranch) ? lookupBranches(defaultBranch) : undefined,
      // 第一頁已命中整段路徑就是最長可能，不必再查；否則用第一段當前綴找出所有候選
      hintParts.length && firstPageHint !== hintParts.join('/')
        ? lookupBranches(hintParts[0]!)
        : undefined,
    ]);
  }
  const hint = resolveBranchHint(opts.branchHint, [...headBySha.keys()]);
  const fullName = `${owner}/${repo}`.toLowerCase();
  const prBranches = pulls
    .filter((p) => p.head.repo?.full_name?.toLowerCase() === fullName)
    .map((p) => p.head.ref);

  const picked: string[] = [];
  for (const name of [defaultBranch, hint, ...prBranches, ...headBySha.keys()]) {
    if (name && headBySha.has(name) && !picked.includes(name)) picked.push(name);
    if (picked.length >= maxBranches) break;
  }

  // commit 分兩階段抓，省 API 次數（未登入每小時只有 60 次）：
  // 1. default branch 與正在瀏覽的 branch 平行抓；
  // 2. 其餘選到的 branch 只抓 head 還不在已載入歷史裡的（例如已合併、或從 default 分出後沒有新 commit 的 branch，
  //    它的 head 已經在 default 的那一頁裡，不必再花一個請求）。ref 照樣全部輸出。
  // 第二階段裡互相包含的 branch 仍然各抓一次：要知道誰包含誰得先等結果，改成逐一抓太慢。
  const commits = new Map<string, CommitInput>();
  const fetchCommits = async (names: readonly string[]): Promise<void> => {
    const results = await Promise.all(
      names.map((name) =>
        get<ApiCommit[]>(`${repoPath}/commits`, { sha: headBySha.get(name)!, per_page: perBranch }),
      ),
    );
    // 依 picked 的順序合併（與一次全抓時相同的去重順序）
    for (const list of results) {
      for (const c of list) if (!commits.has(c.sha)) commits.set(c.sha, mapApiCommit(c));
    }
  };
  // default branch 找不到（例如分支清單頁滿又查不到）時，第一階段改抓第一條選到的 branch
  const preferred = picked.filter((name) => name === defaultBranch || name === hint);
  const first = preferred.length ? preferred : picked.slice(0, 1);
  await fetchCommits(first);
  await fetchCommits(
    picked.filter((name) => !first.includes(name) && !commits.has(headBySha.get(name)!)),
  );

  const refs: RefInput[] = picked.map((name) => ({
    name,
    sha: headBySha.get(name)!,
    kind: 'branch',
    isDefault: name === defaultBranch,
  }));
  // tag 只抓 /tags 的第一頁（最多 30 個，依 GitHub 的排序，通常是名稱 / 版本最大的那些），之後不會再抓更多頁。
  // 這 30 個全部留著：指向還沒載入的 commit 的，等 infinite scroll 把那段歷史載入之後才會出現（layout 只畫載入範圍內的 ref）；
  // 不在這 30 個裡的較舊 tag 永遠不會出現，所以 tag 很多的 repo 往回載入的舊歷史可能沒有 tag。
  for (const t of tags) refs.push({ name: t.name, sha: t.commit.sha, kind: 'tag' });

  const truncated = [...commits.values()].some((c) => c.parents.some((p) => !commits.has(p)));
  const refReasons = [
    ...(tagsUnavailable ? ['tags_unavailable'] : []),
    ...(picked.length < branches.length ? ['branch_selection'] : []),
    ...(branchPageFull ? ['branch_page_limit'] : []),
    // 頁滿又補查不到（或補查失敗）：圖裡沒有主線，要讓使用者看得出原因
    ...(defaultBranch && !headBySha.has(defaultBranch) ? ['default_branch_unavailable'] : []),
    ...(tags.length >= 30 ? ['tag_page_limit'] : []),
    ...(tags.some((t) => !commits.has(t.commit.sha)) ? ['tags_outside_history'] : []),
  ];
  const observedAt = Date.now();

  return {
    coverage: {
      source: 'github',
      observedAt,
      refs: coverage(
        refReasons.length ? 'partial' : 'complete',
        refReasons,
        refs.length,
        refReasons.length ? undefined : refs.length,
      ),
      commits: coverage(
        truncated ? 'partial' : 'complete',
        truncated ? ['history_limit'] : [],
        commits.size,
        truncated ? undefined : commits.size,
      ),
    },
    repo: {
      owner: repoInfo.owner?.login ?? owner,
      name: repoInfo.name ?? repo,
      defaultBranch,
      url: repoInfo.html_url ?? `https://github.com/${owner}/${repo}`,
    },
    commits: [...commits.values()],
    refs,
    truncated,
    fetchedAt: observedAt,
    ...(get.rateLimit() ? { rateLimit: get.rateLimit() } : {}),
  };
}

export interface GitHubMoreOptions {
  token?: string;
  /** 預設 https://api.github.com */
  apiBase?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** 每個起點抓幾筆（一頁）。預設 60（上限 100）。 */
  perPage?: number;
  /** 最多從幾個起點往回抓（每個起點一個請求）。預設 5。 */
  maxStarts?: number;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * 從每個 missing parent 往回抓一頁（最多 maxStarts 個起點，平行請求）：`GET /commits?sha=<sha>&per_page=<n>`。
 * 回傳各頁 commit 的聯集（sha 去重，依起點順序）。sha 必須是 40 位 hex，否則在碰網路之前就丟錯。
 * GitHub 已經不認得的起點（404 / 422，例如 force push 之後被回收的 commit）視為「這個起點沒有更早的」，不讓整批失敗。
 * 但 404 也可能是 repo 本身看不到了（token 被移除、權限被收回、repo 被刪掉 / 改成私有 / 轉移）：整批一筆都沒抓到、
 * 又有起點是 404 / 422 時，再確認一次 repo（多一個請求），看不到就照常丟 not_found / unauthorized，
 * 不會把所有起點都當成「沒有更早的」而默默結束往回載入。
 * 其他錯誤（rate limit、網路、token…）照常丟出 GitHubError，並且馬上取消其他還沒回來的起點請求
 * （它們的結果反正會被丟掉，別再耗 API 次數）。
 */
export async function fetchGitHubCommitsFrom(
  owner: string,
  repo: string,
  shas: readonly string[],
  opts: GitHubMoreOptions = {},
): Promise<CommitInput[]> {
  const repoPath = repoPathOf(owner, repo);
  const bad = shas.find((s) => typeof s !== 'string' || !SHA_RE.test(s));
  if (bad !== undefined) throw new GitHubError('unknown', `Invalid commit SHA: ${String(bad)}`);
  const perPage = clampPerPage(opts.perPage);
  const maxStarts = Math.max(1, Math.floor(opts.maxStarts ?? 5) || 1);
  const starts = [...new Set(shas.map((s) => s.toLowerCase()))].slice(0, maxStarts);
  if (starts.length === 0) return [];

  // 內部的 AbortController 接在呼叫端的 signal 後面：呼叫端 abort / 逾時照樣傳到每個請求（reason 不變，
  // 逾時仍然是 network 錯誤），第一個真正的失敗也能取消其他起點的請求
  const ctrl = new AbortController();
  const outer = opts.signal;
  const forward = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  const get = githubGetter({ ...opts, signal: ctrl.signal });

  // 第一個真正的失敗（之後被取消的請求丟的是 AbortError，不能蓋掉真正的原因）
  const failures: unknown[] = [];
  let pages: Array<ApiCommit[] | null>;
  try {
    pages = await Promise.all(
      starts.map((sha) =>
        get<ApiCommit[]>(`${repoPath}/commits`, { sha, per_page: perPage }).catch(
          (err: unknown) => {
            // null = GitHub 不認得這個起點
            if (err instanceof GitHubError && (err.status === 404 || err.status === 422))
              return null;
            if (failures.push(err) === 1) ctrl.abort();
            throw err;
          },
        ),
      ),
    );
    // 整批都沒抓到東西、又有不認得的起點：確認 repo 還看得到（看不到就丟 not_found / unauthorized / rate_limited…）
    if (pages.includes(null) && pages.every((p) => !p?.length)) await get<ApiRepo>(repoPath);
  } catch (err) {
    throw failures.length > 0 ? failures[0] : err;
  } finally {
    outer?.removeEventListener('abort', forward);
  }

  const out = new Map<string, CommitInput>();
  for (const page of pages) {
    for (const c of page ?? []) if (!out.has(c.sha)) out.set(c.sha, mapApiCommit(c));
  }
  return [...out.values()];
}

/** missingParents → fetchGitHubCommitsFrom → appendCommits。沒有缺的 parent 就原樣回傳。 */
export async function fetchMoreGitHubHistory(
  owner: string,
  repo: string,
  data: GraphData,
  opts: GitHubMoreOptions = {},
): Promise<GraphData> {
  const missing = missingParents(data);
  if (missing.length === 0) return data;
  const older = await fetchGitHubCommitsFrom(owner, repo, missing, opts);
  return appendCommits(data, older);
}
