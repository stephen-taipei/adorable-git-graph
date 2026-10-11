import {
  coverage,
  isFullSha,
  isSafePath,
  isSafeRef,
  type ChangedFile,
  type Coverage,
  type DiagnosticAdapter,
  type DiagnosticCommit,
  type FilePatchResult,
  type PinnedRef,
  type RefQuery,
} from './diagnostics.ts';
import { GitHubError, isValidRepoSegment, type GitHubGraphOptions } from './github.ts';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v));
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const abort = () => new DOMException('Aborted', 'AbortError');
const aborted = (e: unknown) => e instanceof Error && e.name === 'AbortError';
const invalid = (message: string): never => {
  throw new GitHubError('invalid_repo', message);
};
const sha = (v: unknown): string => {
  if (!isFullSha(v)) throw new GitHubError('unknown', 'Invalid SHA returned by GitHub');
  return v.toLowerCase();
};
const MAX_FILES = 300,
  MAX_COMMITS = 200,
  PATCH_BYTES = 512 * 1024;

function repoName(value: string): string {
  const [owner, repo, extra] = value.split('/');
  if (
    extra !== undefined ||
    !owner ||
    !repo ||
    !isValidRepoSegment(owner) ||
    !isValidRepoSegment(repo)
  )
    invalid('Invalid repository');
  return value;
}
function files(raw: unknown[]): { files: ChangedFile[]; invalid: boolean } {
  let invalid = false;
  const result: ChangedFile[] = [];
  for (const entry of raw.slice(0, MAX_FILES)) {
    if (
      !record(entry) ||
      !isSafePath(entry.filename) ||
      (entry.previous_filename !== undefined && !isSafePath(entry.previous_filename))
    ) {
      invalid = true;
      continue;
    }
    result.push({
      path: entry.filename,
      previousPath: entry.previous_filename as string | undefined,
      status: typeof entry.status === 'string' ? entry.status : 'unknown',
      additions: count(entry.additions),
      deletions: count(entry.deletions),
      binary: typeof entry.patch === 'string' ? false : null,
    });
  }
  return { files: result, invalid };
}
function fileCoverage(mapped: ReturnType<typeof files>, capped: boolean, failed = false): Coverage {
  const reasons = [
    ...(capped ? ['file_limit'] : []),
    ...(mapped.invalid ? ['malformed_files'] : []),
    ...(failed ? ['file_page_unavailable'] : []),
  ];
  return coverage(
    failed && !mapped.files.length ? 'unavailable' : reasons.length ? 'partial' : 'complete',
    reasons,
    mapped.files.length,
    reasons.length ? undefined : mapped.files.length,
  );
}

/** All comparisons and patches use resolved immutable SHAs. No API-provided URL is followed. */
export function createGitHubDiagnostics(
  owner: string,
  repo: string,
  opts: GitHubGraphOptions = {},
): DiagnosticAdapter {
  const defaultRepo = repoName(`${owner}/${repo}`);
  const root = new URL(opts.apiBase ?? 'https://api.github.com');
  if (
    root.username ||
    root.password ||
    root.search ||
    root.hash ||
    !(
      root.protocol === 'https:' ||
      (root.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname))
    )
  )
    invalid('Invalid API origin');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pathFor = (name: string) =>
    `/repos/${repoName(name).split('/').map(encodeURIComponent).join('/')}`;
  async function get(path: string, query: Record<string, number> = {}, signal?: AbortSignal) {
    const url = new URL(`${root.origin}${root.pathname.replace(/\/$/, '')}${path}`);
    if (url.origin !== root.origin) invalid('Invalid API URL');
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const signals = [opts.signal, signal].filter((s): s is AbortSignal => Boolean(s));
    const combined = AbortSignal.any([...signals, AbortSignal.timeout(25_000)]);
    if (combined.aborted) {
      if (signals.some((s) => s.aborted && s.reason?.name !== 'TimeoutError')) throw abort();
      throw new GitHubError('network', 'GitHub request timed out');
    }
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'error',
        signal: combined,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
      });
    } catch (e) {
      if (signals.some((s) => s.aborted && s.reason?.name !== 'TimeoutError')) throw abort();
      throw new GitHubError(
        'network',
        combined.aborted ? 'GitHub request timed out' : 'GitHub network request failed',
      );
    }
    if (!response.ok) {
      const code =
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
          ? 'rate_limited'
          : response.status === 401 || response.status === 403
            ? 'unauthorized'
            : response.status === 404
              ? 'not_found'
              : response.status === 409
                ? 'empty_repo'
                : 'unknown';
      throw new GitHubError(
        code,
        `GitHub API HTTP ${response.status}`,
        Number(response.headers.get('x-ratelimit-reset')) * 1000 || undefined,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (signals.some((s) => s.aborted && s.reason?.name !== 'TimeoutError')) throw abort();
      throw new GitHubError('network', 'Invalid GitHub JSON response');
    }
    if (combined.aborted) {
      if (signals.some((s) => s.aborted && s.reason?.name !== 'TimeoutError')) throw abort();
      throw new GitHubError('network', 'GitHub request timed out');
    }
    if (!record(data)) throw new GitHubError('unknown', 'Invalid GitHub response');
    return { data, response };
  }
  async function commit(name: string, ref: string, page = 1, perPage = 100, signal?: AbortSignal) {
    const result = await get(
      `${pathFor(name)}/commits/${encodeURIComponent(ref)}`,
      { per_page: perPage, page },
      signal,
    );
    sha(result.data.sha);
    if (isFullSha(ref) && result.data.sha !== ref)
      throw new GitHubError('unknown', 'Pinned SHA mismatch');
    return result;
  }
  async function pin(query: RefQuery, signal?: AbortSignal): Promise<PinnedRef> {
    if (typeof query === 'string') {
      if (!isSafeRef(query)) invalid('Unsafe ref');
      return { name: query, sha: sha((await commit(defaultRepo, query, 1, 1, signal)).data.sha) };
    }
    if (!isSafeRef(query.name) || !isFullSha(query.sha)) invalid('Invalid pinned ref');
    const name = repoName(query.repo ?? defaultRepo);
    const resolved = sha((await commit(name, query.sha.toLowerCase(), 1, 1, signal)).data.sha);
    return { ...query, sha: resolved };
  }
  const operand = (ref: PinnedRef) =>
    ref.repo && ref.repo.toLowerCase() !== defaultRepo.toLowerCase()
      ? `${repoName(ref.repo).split('/')[0]}:${ref.sha}`
      : ref.sha;
  async function comparePage(base: PinnedRef, head: PinnedRef, page = 1, signal?: AbortSignal) {
    const result = await get(
      `${pathFor(defaultRepo)}/compare/${encodeURIComponent(operand(base))}...${encodeURIComponent(operand(head))}`,
      { per_page: 100, page },
      signal,
    );
    // Ref movement and malformed provider responses must not be silently accepted.
    if (!record(result.data.base_commit) || sha(result.data.base_commit.sha) !== base.sha)
      throw new GitHubError('unknown', 'Comparison base SHA mismatch');
    return result;
  }
  async function listCommits(
    first: RecordValue,
    base: PinnedRef,
    head: PinnedRef,
    total: number | null,
    signal?: AbortSignal,
  ) {
    const commits: DiagnosticCommit[] = [],
      reasons: string[] = [];
    let page = first;
    for (let n = 1; n <= 2; n++) {
      if (!Array.isArray(page.commits)) {
        reasons.push('commits_unavailable');
        break;
      }
      for (const value of page.commits.slice(0, 100)) {
        if (!record(value) || !isFullSha(value.sha)) {
          reasons.push('malformed_commits');
          continue;
        }
        const message =
          record(value.commit) && typeof value.commit.message === 'string'
            ? value.commit.message
            : '';
        if (!commits.some((c) => c.sha === value.sha))
          commits.push({
            sha: value.sha,
            subject: message.split(/\r?\n/)[0]!.replace(/[\x00-\x1f]/g, ''),
          });
      }
      if (page.commits.length < 100 || commits.length >= (total ?? MAX_COMMITS) || n === 2) break;
      try {
        page = (await comparePage(base, head, n + 1, signal)).data;
      } catch (e) {
        if (aborted(e)) throw e;
        reasons.push('commit_page_unavailable');
        break;
      }
    }
    if (total === null) reasons.push('count_unknown');
    else if (commits.length !== total)
      reasons.push(total > MAX_COMMITS ? 'commit_limit' : 'commit_count_mismatch');
    return {
      commits,
      coverage: coverage(
        total === null ? 'unknown' : reasons.length ? 'partial' : 'complete',
        [...new Set(reasons)],
        commits.length,
        total ?? undefined,
      ),
    };
  }
  async function compareFiles(base: PinnedRef, head: PinnedRef, signal?: AbortSignal) {
    const data = (await comparePage(base, head, 1, signal)).data;
    // The API's patch semantics are valid here only if this exact base is the merge base.
    if (!record(data.merge_base_commit) || sha(data.merge_base_commit.sha) !== base.sha)
      throw new GitHubError('unknown', 'Patch base is not the confirmed merge base');
    if (!Array.isArray(data.files)) throw new GitHubError('unknown', 'Files unavailable');
    const mapped = files(data.files);
    return {
      raw: data.files.slice(0, MAX_FILES) as unknown[],
      files: mapped.files,
      coverage: fileCoverage(mapped, data.files.length >= MAX_FILES),
    };
  }
  async function commitFiles(
    head: string,
    first: Awaited<ReturnType<typeof commit>>,
    signal?: AbortSignal,
    commitRepo = defaultRepo,
  ) {
    const raw: unknown[] = [];
    let page = first,
      capped = false,
      failed = false;
    for (let n = 1; n <= 3; n++) {
      if (!Array.isArray(page.data.files)) {
        failed = true;
        break;
      }
      raw.push(...page.data.files.slice(0, 100));
      if (
        page.data.files.length < 100 &&
        !/rel="next"/.test(page.response.headers.get('link') ?? '')
      )
        break;
      if (n === 3) {
        capped = true;
        break;
      }
      try {
        page = await commit(commitRepo, head, n + 1, 100, signal);
      } catch (e) {
        if (aborted(e)) throw e;
        failed = true;
        break;
      }
    }
    const mapped = files(raw);
    return { raw, files: mapped.files, coverage: fileCoverage(mapped, capped, failed) };
  }
  function parents(data: RecordValue): string[] {
    if (!Array.isArray(data.parents)) throw new GitHubError('unknown', 'Parents unavailable');
    return data.parents.map((p) => {
      if (!record(p)) throw new GitHubError('unknown', 'Invalid parent');
      return sha(p.sha);
    });
  }
  return {
    async compare(baseQuery, headQuery, signal) {
      const [base, head] = await Promise.all([pin(baseQuery, signal), pin(headQuery, signal)]);
      const first = (await comparePage(base, head, 1, signal)).data;
      const ahead = count(first.ahead_by),
        behind = count(first.behind_by);
      const mergeBase =
        record(first.merge_base_commit) && isFullSha(first.merge_base_commit.sha)
          ? first.merge_base_commit.sha
          : null;
      const headSide = await listCommits(first, base, head, ahead, signal);
      let baseSide = {
        commits: [] as DiagnosticCommit[],
        coverage: coverage(
          'unavailable',
          ['reverse_comparison_unavailable'],
          0,
          behind ?? undefined,
        ),
      };
      try {
        baseSide = await listCommits(
          (await comparePage(head, base, 1, signal)).data,
          head,
          base,
          behind,
          signal,
        );
      } catch (e) {
        if (aborted(e)) throw e;
      }
      let fileResult = {
        files: [] as ChangedFile[],
        coverage: coverage('unavailable', ['merge_base_unavailable']),
      };
      if (mergeBase) {
        try {
          fileResult = await compareFiles({ name: mergeBase, sha: mergeBase }, head, signal);
        } catch (e) {
          if (aborted(e)) throw e;
          fileResult.coverage = coverage('unavailable', ['files_unavailable']);
        }
      }
      const complete =
        headSide.coverage.status === 'complete' && baseSide.coverage.status === 'complete';
      return {
        base,
        head,
        mergeBase,
        ahead,
        behind,
        ancestor: behind === null ? 'unknown' : behind === 0 ? 'yes' : 'no',
        headCommits: headSide.commits,
        baseCommits: baseSide.commits,
        commitsCoverage: coverage(
          complete
            ? 'complete'
            : headSide.coverage.status === 'unknown' && baseSide.coverage.status === 'unknown'
              ? 'unknown'
              : !headSide.commits.length && !baseSide.commits.length
                ? 'unavailable'
                : 'partial',
          [...headSide.coverage.reasons, ...baseSide.coverage.reasons],
          headSide.commits.length + baseSide.commits.length,
          ahead !== null && behind !== null ? ahead + behind : undefined,
        ),
        files: fileResult.files,
        filesCoverage: fileResult.coverage,
        semantics: 'merge-base-to-head',
        observedAt: Date.now(),
      };
    },
    async changes(input, parentInput, signal, commitRepo) {
      const fullName = repoName(commitRepo ?? defaultRepo);
      if (!isFullSha(input) || (parentInput !== undefined && !isFullSha(parentInput)))
        invalid('Full SHA required');
      const head = input.toLowerCase(),
        first = await commit(fullName, head, 1, 100, signal);
      const allParents = parents(first.data),
        parentSha = parentInput?.toLowerCase() ?? allParents[0] ?? null;
      if (parentSha && !allParents.includes(parentSha)) invalid('Not an actual parent');
      const listing =
        parentSha && parentSha !== allParents[0]
          ? await compareFiles(
              { name: parentSha, sha: parentSha, repo: fullName },
              { name: head, sha: head, repo: fullName },
              signal,
            )
          : await commitFiles(head, first, signal, fullName);
      return {
        sha: head,
        parents: allParents,
        parentSha,
        files: listing.files,
        filesCoverage: listing.coverage,
        observedAt: Date.now(),
      };
    },
    async patch(base, head, path, previousPath, signal, headRepo): Promise<FilePatchResult> {
      const fullName = repoName(headRepo ?? defaultRepo);
      if (
        (base !== null && !isFullSha(base)) ||
        !isFullSha(head) ||
        !isSafePath(path) ||
        (previousPath !== undefined && !isSafePath(previousPath))
      )
        invalid('Invalid patch input');
      const result = (reason: string): FilePatchResult => ({
        baseSha: base,
        headSha: head,
        path,
        previousPath,
        patch: null,
        binary: null,
        coverage: coverage('unavailable', [reason]),
        observedAt: Date.now(),
      });
      let raw: unknown[];
      if (base === null) {
        const first = await commit(fullName, head, 1, 100, signal);
        if (parents(first.data).length) return result('unverified_root');
        raw = (await commitFiles(head, first, signal, fullName)).raw;
      } else {
        try {
          raw = (
            await compareFiles(
              { name: base, sha: base, repo: fullName },
              { name: head, sha: head, repo: fullName },
              signal,
            )
          ).raw;
        } catch (e) {
          if (
            aborted(e) ||
            (e instanceof GitHubError &&
              ['rate_limited', 'unauthorized', 'not_found', 'network'].includes(e.code))
          )
            throw e;
          return result('patch_base_unavailable');
        }
      }
      const match = raw.find(
        (v) =>
          record(v) &&
          v.filename === path &&
          (previousPath === undefined || v.previous_filename === previousPath),
      );
      if (!record(match)) return result('file_not_in_loaded_list');
      if (typeof match.patch !== 'string' || !match.patch)
        return result('patch_missing_binary_or_large');
      const bytes = new TextEncoder().encode(match.patch),
        truncated = bytes.length > PATCH_BYTES;
      // GitHub may omit/truncate patches. Match hunk line counts before asserting complete.
      let additions = 0,
        deletions = 0;
      for (const line of match.patch.split('\n')) {
        if (line.startsWith('+')) additions++;
        if (line.startsWith('-')) deletions++;
      }
      const verified = additions === count(match.additions) && deletions === count(match.deletions);
      return {
        baseSha: base,
        headSha: head,
        path,
        previousPath:
          typeof match.previous_filename === 'string' ? match.previous_filename : undefined,
        patch: truncated
          ? new TextDecoder().decode(bytes.slice(0, PATCH_BYTES), { stream: true })
          : match.patch,
        binary: false,
        coverage: coverage(
          truncated ? 'partial' : 'unknown',
          truncated
            ? ['patch_limit']
            : [
                'provider_patch_completeness_unknown',
                ...(!verified ? ['patch_statistics_mismatch'] : []),
              ],
          Math.min(bytes.length, PATCH_BYTES),
          truncated ? bytes.length : undefined,
        ),
        observedAt: Date.now(),
      };
    },
    async pullRequest(number, signal) {
      if (!Number.isSafeInteger(number) || number < 1) invalid('Invalid PR number');
      const pr = (await get(`${pathFor(defaultRepo)}/pulls/${number}`, {}, signal)).data;
      if (
        pr.number !== number ||
        typeof pr.title !== 'string' ||
        !['open', 'closed'].includes(String(pr.state))
      )
        throw new GitHubError('unknown', 'Invalid PR');
      const side = (v: unknown): PinnedRef => {
        if (
          !record(v) ||
          !isSafeRef(v.ref) ||
          !record(v.repo) ||
          typeof v.repo.full_name !== 'string'
        )
          throw new GitHubError('unknown', 'PR repository unavailable');
        return { name: v.ref, sha: sha(v.sha), repo: repoName(v.repo.full_name) };
      };
      return {
        number,
        title: pr.title,
        state:
          pr.merged === true || typeof pr.merged_at === 'string'
            ? 'merged'
            : (pr.state as 'open' | 'closed'),
        draft: pr.draft === true,
        base: side(pr.base),
        head: side(pr.head),
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        observedAt: Date.now(),
      };
    },
  };
}
