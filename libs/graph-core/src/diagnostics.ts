/** Read-only diagnostics are independent of the graph's display window. */
export type CoverageStatus = 'complete' | 'partial' | 'unknown' | 'unavailable';
export interface Coverage {
  status: CoverageStatus;
  reasons: string[];
  loaded?: number;
  total?: number;
}
export interface GraphCoverage {
  source: 'local' | 'github' | 'snapshot';
  observedAt: number;
  refs: Coverage;
  commits: Coverage;
  remoteRefsAreLocal?: boolean;
}
export interface PinnedRef {
  name: string;
  sha: string;
  /** GitHub owner/repo; required for fork PR refs. */
  repo?: string;
}
export type RefQuery = string | PinnedRef;
export interface DiagnosticCommit {
  sha: string;
  subject: string;
}
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean | null;
}
export interface ComparisonResult {
  base: PinnedRef;
  head: PinnedRef;
  mergeBase: string | null;
  /** Whether base is an ancestor of head; not patch equivalence or deployment. */
  ancestor: 'yes' | 'no' | 'unknown';
  ahead: number | null;
  behind: number | null;
  headCommits: DiagnosticCommit[];
  baseCommits: DiagnosticCommit[];
  commitsCoverage: Coverage;
  files: ChangedFile[];
  filesCoverage: Coverage;
  semantics: 'merge-base-to-head';
  observedAt: number;
  error?: string;
}
export interface CommitChangesResult {
  sha: string;
  parents: string[];
  /** null denotes the empty tree, only for a verified root commit. */
  parentSha: string | null;
  files: ChangedFile[];
  filesCoverage: Coverage;
  observedAt: number;
  error?: string;
}
export interface FilePatchResult {
  baseSha: string | null;
  headSha: string;
  path: string;
  previousPath?: string;
  patch: string | null;
  binary: boolean | null;
  coverage: Coverage;
  observedAt: number;
  error?: string;
}
export interface PullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  url: string;
  base: PinnedRef;
  head: PinnedRef;
  observedAt: number;
}
export interface DiagnosticContext {
  commit?: string;
  pullRequest?: number;
}
export interface DiagnosticAdapter {
  compare(base: RefQuery, head: RefQuery, signal?: AbortSignal): Promise<ComparisonResult>;
  changes(
    sha: string,
    parent?: string,
    signal?: AbortSignal,
    commitRepo?: string,
  ): Promise<CommitChangesResult>;
  patch(
    base: string | null,
    head: string,
    path: string,
    previousPath?: string,
    signal?: AbortSignal,
    headRepo?: string,
  ): Promise<FilePatchResult>;
  pullRequest?(number: number, signal?: AbortSignal): Promise<PullRequestSummary>;
  context?: DiagnosticContext;
}
export type DiagnosticRequest =
  | { operation: 'compare'; base: RefQuery; head: RefQuery }
  | { operation: 'changes'; sha: string; parent?: string; commitRepo?: string }
  | {
      operation: 'patch';
      base: string | null;
      head: string;
      path: string;
      previousPath?: string;
      headRepo?: string;
    }
  | { operation: 'pull-request'; number: number };
export const isRepoContext = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
  !value.split('/').some((s) => s === '.' || s === '..');
export function isRefQuery(value: unknown): value is RefQuery {
  if (typeof value === 'string') return isSafeRef(value);
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  return (
    isSafeRef(q['name']) &&
    isFullSha(q['sha']) &&
    (q['repo'] === undefined ||
      (typeof q['repo'] === 'string' &&
        /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(q['repo']) &&
        !q['repo'].split('/').some((s) => s === '.' || s === '..')))
  );
}
export function isDiagnosticRequest(value: unknown): value is DiagnosticRequest {
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  switch (q['operation']) {
    case 'compare':
      return isRefQuery(q['base']) && isRefQuery(q['head']);
    case 'changes':
      return (
        isFullSha(q['sha']) &&
        (q['parent'] === undefined || isFullSha(q['parent'])) &&
        (q['commitRepo'] === undefined || isRepoContext(q['commitRepo']))
      );
    case 'patch':
      return (
        (q['base'] === null || isFullSha(q['base'])) &&
        isFullSha(q['head']) &&
        isSafePath(q['path']) &&
        (q['previousPath'] === undefined || isSafePath(q['previousPath'])) &&
        (q['headRepo'] === undefined || isRepoContext(q['headRepo']))
      );
    case 'pull-request':
      return Number.isSafeInteger(q['number']) && Number(q['number']) > 0;
    default:
      return false;
  }
}
export const coverage = (
  status: CoverageStatus,
  reasons: string[] = [],
  loaded?: number,
  total?: number,
): Coverage => ({
  status,
  reasons,
  ...(loaded === undefined ? {} : { loaded }),
  ...(total === undefined ? {} : { total }),
});
export const isFullSha = (s: unknown): s is string =>
  typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(s);
/** Only names or object IDs; no revision operators, options, or path expressions. */
export const isSafeRef = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.length > 0 &&
  s.length <= 1024 &&
  !s.startsWith('-') &&
  !/[\s\x00-\x20~^:?*\[\\]/.test(s) &&
  !s.includes('..') &&
  !s.includes('@{');
export const isSafePath = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.length > 0 &&
  s.length <= 4096 &&
  !s.includes('\0') &&
  !s.startsWith('/') &&
  !/^[a-z]:/i.test(s) &&
  !s.split(/[\\/]/).includes('..');
export function unknownComparison(
  base: RefQuery,
  head: RefQuery,
  reason: string,
): ComparisonResult {
  const pin = (q: RefQuery): PinnedRef => (typeof q === 'string' ? { name: q, sha: '' } : q);
  return {
    base: pin(base),
    head: pin(head),
    mergeBase: null,
    ancestor: 'unknown',
    ahead: null,
    behind: null,
    headCommits: [],
    baseCommits: [],
    commitsCoverage: coverage('unavailable', [reason]),
    files: [],
    filesCoverage: coverage('unavailable', [reason]),
    semantics: 'merge-base-to-head',
    observedAt: Date.now(),
    error: reason,
  };
}

/** In-memory immutable change/patch cache, scoped to adapter identity; never persists file contents. */
export function cacheDiagnostics(adapter: DiagnosticAdapter): DiagnosticAdapter {
  const entries = new Map<
    string,
    { value: CommitChangesResult | FilePatchResult; savedAt: number; bytes: number }
  >();
  let totalBytes = 0;
  async function read<T extends CommitChangesResult | FilePatchResult>(
    key: string,
    signal: AbortSignal | undefined,
    query: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const hit = entries.get(key);
    if (hit && Date.now() - hit.savedAt < 120_000) return hit.value as T;
    const value = await query();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const c = 'coverage' in value ? value.coverage : value.filesCoverage;
    if (
      value.error ||
      c.status === 'unknown' ||
      c.status === 'unavailable' ||
      c.reasons.some((r) => /unavailable|malformed|mismatch/.test(r))
    )
      return value;
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes <= 1024 * 1024) {
      if (hit) totalBytes -= hit.bytes;
      entries.delete(key);
      entries.set(key, { value, savedAt: Date.now(), bytes });
      totalBytes += bytes;
      while (entries.size > 32 || totalBytes > 4 * 1024 * 1024) {
        const oldest = entries.keys().next().value!;
        totalBytes -= entries.get(oldest)!.bytes;
        entries.delete(oldest);
      }
    }
    return value;
  }
  return {
    ...adapter,
    changes: (sha, parent, signal, commitRepo) =>
      read(JSON.stringify(['changes', sha, parent, commitRepo]), signal, () =>
        adapter.changes(sha, parent, signal, commitRepo),
      ),
    patch: (base, head, path, previousPath, signal, headRepo) =>
      read(JSON.stringify(['patch', base, head, path, previousPath, headRepo]), signal, () =>
        adapter.patch(base, head, path, previousPath, signal, headRepo),
      ),
  };
}
