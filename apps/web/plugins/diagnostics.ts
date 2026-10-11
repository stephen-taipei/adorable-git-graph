import {
  coverage,
  isFullSha,
  isSafePath,
  isSafeRef,
  unknownComparison,
} from '@adorable/graph-core';
import type {
  ChangedFile,
  ComparisonResult,
  CommitChangesResult,
  DiagnosticAdapter,
  DiagnosticCommit,
  FilePatchResult,
  PinnedRef,
  RefQuery,
} from '@adorable/graph-core';

export type RunGit = (args: string[], signal?: AbortSignal) => Promise<string>;
const MAX_COMMITS = 200;
const MAX_FILES = 300;
const MAX_PATCH = 512 * 1024;
const aborted = (e: unknown) => (e as { name?: string })?.name === 'AbortError';
const code = (e: unknown) => (e as { code?: number })?.code;

/** NUL-delimited paths preserve tabs, newlines and rename pairs. */
function parseNames(text: string): Array<{ status: string; path: string; previousPath?: string }> {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const out: Array<{ status: string; path: string; previousPath?: string }> = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]!;
    if (!/^[A-Z][0-9]*$/.test(status)) throw new Error('missing_objects');
    const old = /^[RC]/.test(status) ? parts[i++] : undefined;
    const path = parts[i++];
    if (!path || (/^[RC]/.test(status) && !old)) throw new Error('missing_objects');
    out.push({ status, path, ...(old ? { previousPath: old } : {}) });
  }
  return out;
}

function parseStats(text: string) {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const out = new Map<
    string,
    { additions: number | null; deletions: number | null; binary: boolean }
  >();
  for (let i = 0; i < parts.length;) {
    const row = parts[i++]!;
    const a = row.indexOf('\t');
    const b = row.indexOf('\t', a + 1);
    if (a < 0 || b < 0) throw new Error('missing_objects');
    const added = row.slice(0, a),
      removed = row.slice(a + 1, b);
    let path = row.slice(b + 1),
      old = '';
    if (!path) {
      old = parts[i++]!;
      path = parts[i++]!;
    }
    if (!path || (!row.slice(b + 1) && !old)) throw new Error('missing_objects');
    const binary = added === '-' || removed === '-';
    const number = (v: string) =>
      /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
    out.set(`${old}\0${path}`, {
      additions: binary ? null : number(added),
      deletions: binary ? null : number(removed),
      binary,
    });
  }
  return out;
}

export function createLocalDiagnostics(repoDir: string, runGit: RunGit): DiagnosticAdapter {
  if (!repoDir) throw new Error('repository_required');
  const git = (signal: AbortSignal | undefined, ...args: string[]) => runGit(args, signal);
  const resolve = async (ref: string, signal?: AbortSignal) => {
    if (!isSafeRef(ref)) throw new Error('invalid_revision');
    const sha = (
      await git(signal, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
    ).trim();
    if (!isFullSha(sha)) throw new Error('missing_objects');
    return sha.toLowerCase();
  };
  const pin = async (q: RefQuery, signal?: AbortSignal): Promise<PinnedRef> => {
    if (typeof q === 'string') return { name: q, sha: await resolve(q, signal) };
    if (!q || q.repo || !isSafeRef(q.name) || !isFullSha(q.sha))
      throw new Error('invalid_revision');
    const sha = await resolve(q.sha, signal);
    if (sha !== q.sha.toLowerCase()) throw new Error('invalid_revision');
    return { name: q.name, sha };
  };
  const shallow = async (signal?: AbortSignal) => {
    const text = (await git(signal, 'rev-parse', '--is-shallow-repository')).trim();
    if (text !== 'true' && text !== 'false') throw new Error('missing_objects');
    return text === 'true';
  };
  const parentsOf = async (sha: string, signal?: AbortSignal) => {
    const parts = (await git(signal, 'show', '-s', '--format=%H%x00%P', sha)).trimEnd().split('\0');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== sha) throw new Error('missing_objects');
    const parents = parts[1]!.trim() ? parts[1]!.trim().split(/\s+/) : [];
    if (!parents.every(isFullSha)) throw new Error('missing_objects');
    return parents;
  };
  const verifyRoot = async (sha: string, signal?: AbortSignal) => {
    if (await shallow(signal)) throw new Error('shallow_history');
    if ((await parentsOf(sha, signal)).length) throw new Error('invalid_revision');
    // No -w: computing the empty tree ID never writes an object.
    const empty = (await git(signal, 'hash-object', '-t', 'tree', '--stdin')).trim();
    if (!isFullSha(empty)) throw new Error('missing_objects');
  };
  async function summary(base: string | null, head: string, signal?: AbortSignal) {
    const args = (format: string) =>
      base === null
        ? [
            'diff-tree',
            '--root',
            '--no-commit-id',
            '-r',
            '--find-renames',
            format,
            '-z',
            '--no-ext-diff',
            '--no-textconv',
            '--submodule=short',
            '--ignore-submodules=none',
            head,
            '--',
          ]
        : [
            'diff',
            '--find-renames',
            format,
            '-z',
            '--no-ext-diff',
            '--no-textconv',
            '--submodule=short',
            '--ignore-submodules=none',
            base,
            head,
            '--',
          ];
    const names = parseNames(await runGit(args('--name-status'), signal));
    let stats = new Map<
      string,
      { additions: number | null; deletions: number | null; binary: boolean }
    >();
    let complete = true;
    try {
      stats = parseStats(await runGit(args('--numstat'), signal));
    } catch (e) {
      if (aborted(e)) throw e;
      complete = false;
    }
    const files: ChangedFile[] = names.map((f) => {
      const s = stats.get(`${f.previousPath ?? ''}\0${f.path}`);
      if (!s) complete = false;
      return {
        ...f,
        additions: s?.additions ?? null,
        deletions: s?.deletions ?? null,
        binary: s?.binary ?? null,
      };
    });
    if (stats.size !== files.length) complete = false;
    return { files, total: files.length, complete };
  }
  const fileCoverage = (s: { total: number; complete: boolean }) =>
    coverage(
      s.total > MAX_FILES || !s.complete ? 'partial' : 'complete',
      [
        ...(s.total > MAX_FILES ? ['file_limit'] : []),
        ...(!s.complete ? ['statistics_unavailable'] : []),
      ],
      Math.min(s.total, MAX_FILES),
      s.total,
    );
  async function commits(range: string, signal?: AbortSignal): Promise<DiagnosticCommit[]> {
    const parts = (
      await git(
        signal,
        'log',
        '-z',
        '--no-show-signature',
        '--format=%H%x00%s',
        '-n',
        String(MAX_COMMITS),
        range,
        '--',
      )
    ).split('\0');
    if (parts.at(-1) === '') parts.pop();
    if (parts.length % 2) throw new Error('missing_objects');
    const out: DiagnosticCommit[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const sha = parts[i]!.trim();
      if (!isFullSha(sha)) throw new Error('missing_objects');
      out.push({ sha, subject: parts[i + 1]!.replace(/[\x00-\x1f\x7f]/g, ' ') });
    }
    return out;
  }
  return {
    async compare(baseQuery, headQuery, signal): Promise<ComparisonResult> {
      let base: PinnedRef, head: PinnedRef;
      try {
        [base, head] = await Promise.all([pin(baseQuery, signal), pin(headQuery, signal)]);
      } catch (e) {
        if (aborted(e)) throw e;
        return unknownComparison(baseQuery, headQuery, 'refs_unavailable');
      }
      const unavailable = (reason: string) => unknownComparison(base, head, reason);
      try {
        if (await shallow(signal)) return unavailable('shallow_history');
        const counts = (
          await git(signal, 'rev-list', '--left-right', '--count', `${base.sha}...${head.sha}`)
        )
          .trim()
          .split(/\s+/);
        if (
          counts.length !== 2 ||
          !counts.every((v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)))
        )
          return unavailable('missing_objects');
        const [behind, ahead] = counts.map(Number) as [number, number];
        let bases: string[];
        try {
          bases = (await git(signal, 'merge-base', '--all', base.sha, head.sha))
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        } catch (e) {
          if (aborted(e)) throw e;
          if (code(e) === 1) bases = [];
          else return unavailable('missing_objects');
        }
        if (!bases.every(isFullSha)) return unavailable('missing_objects');
        let headCommits: DiagnosticCommit[] = [],
          baseCommits: DiagnosticCommit[] = [],
          failed = false;
        try {
          headCommits = await commits(`${base.sha}..${head.sha}`, signal);
          baseCommits = await commits(`${head.sha}..${base.sha}`, signal);
        } catch (e) {
          if (aborted(e)) throw e;
          failed = true;
        }
        const loaded = headCommits.length + baseCommits.length;
        const commitsCoverage = coverage(
          failed || loaded < ahead + behind ? 'partial' : 'complete',
          failed ? ['subjects_unavailable'] : loaded < ahead + behind ? ['commit_limit'] : [],
          loaded,
          ahead + behind,
        );
        const result: ComparisonResult = {
          base,
          head,
          mergeBase: bases.length === 1 ? bases[0]! : null,
          ancestor: behind === 0 ? 'yes' : 'no',
          ahead,
          behind,
          headCommits,
          baseCommits,
          commitsCoverage,
          files: [],
          filesCoverage: coverage('unavailable'),
          semantics: 'merge-base-to-head',
          observedAt: Date.now(),
        };
        if (bases.length !== 1) {
          const reason = bases.length ? 'multiple_merge_bases' : 'no_common_ancestor';
          return { ...result, filesCoverage: coverage('unavailable', [reason]), error: reason };
        }
        try {
          const s = await summary(result.mergeBase, head.sha, signal);
          result.files = s.files.slice(0, MAX_FILES);
          result.filesCoverage = fileCoverage(s);
        } catch (e) {
          if (aborted(e)) throw e;
          result.filesCoverage = coverage('unavailable', ['files_unavailable']);
          result.error = 'files_unavailable';
        }
        return result;
      } catch (e) {
        if (aborted(e)) throw e;
        return unavailable('missing_objects');
      }
    },
    async changes(shaInput, parentInput, signal): Promise<CommitChangesResult> {
      if (!isFullSha(shaInput)) throw new Error('invalid_revision');
      try {
        const sha = await resolve(shaInput, signal);
        const parents = await parentsOf(sha, signal);
        let parentSha: string | null;
        if (!parents.length) {
          if (parentInput !== undefined) throw new Error('invalid_revision');
          await verifyRoot(sha, signal);
          parentSha = null;
        } else {
          parentSha = parentInput ?? parents[0]!;
          if (!isFullSha(parentSha) || !parents.includes(parentSha))
            throw new Error('invalid_revision');
        }
        const s = await summary(parentSha, sha, signal);
        return {
          sha,
          parents,
          parentSha,
          files: s.files.slice(0, MAX_FILES),
          filesCoverage: fileCoverage(s),
          observedAt: Date.now(),
        };
      } catch (e) {
        if (aborted(e) || ['invalid_revision', 'shallow_history'].includes((e as Error).message))
          throw e;
        throw new Error('missing_objects');
      }
    },
    async patch(baseInput, headInput, path, previousPath, signal): Promise<FilePatchResult> {
      const fail = (reason: string, binary: boolean | null = null): FilePatchResult => ({
        baseSha: baseInput,
        headSha: headInput,
        path,
        ...(previousPath ? { previousPath } : {}),
        patch: null,
        binary,
        coverage: coverage('unavailable', [reason]),
        observedAt: Date.now(),
        error: reason,
      });
      if (
        !isFullSha(headInput) ||
        (baseInput !== null && !isFullSha(baseInput)) ||
        !isSafePath(path) ||
        (previousPath !== undefined && !isSafePath(previousPath))
      )
        return fail('invalid_revision');
      try {
        const head = await resolve(headInput, signal);
        const base = baseInput === null ? null : await resolve(baseInput, signal);
        if (base === null) await verifyRoot(head, signal);
        const s = await summary(base, head, signal);
        const f = s.files.find(
          (f) => f.path === path && (previousPath === undefined || f.previousPath === previousPath),
        );
        if (!f) return fail('path_not_changed');
        if (f.binary) return fail('binary_patch_unavailable', true);
        const paths = f.previousPath ? [f.previousPath, f.path] : [f.path];
        const args =
          base === null
            ? [
                'diff-tree',
                '--root',
                '--no-commit-id',
                '-r',
                '-p',
                '--find-renames',
                '--no-ext-diff',
                '--no-textconv',
                '--submodule=short',
                '--ignore-submodules=none',
                '--no-color',
                '--unified=3',
                head,
                '--',
                ...paths,
              ]
            : [
                'diff',
                '-p',
                '--find-renames',
                '--no-ext-diff',
                '--no-textconv',
                '--submodule=short',
                '--ignore-submodules=none',
                '--no-color',
                '--unified=3',
                base,
                head,
                '--',
                ...paths,
              ];
        const patch = await runGit(args, signal);
        if (!patch) return fail('patch_unavailable', f.binary);
        const bytes = Buffer.from(patch, 'utf8');
        return {
          baseSha: base,
          headSha: head,
          path,
          ...(f.previousPath ? { previousPath: f.previousPath } : {}),
          patch:
            bytes.length > MAX_PATCH
              ? new TextDecoder().decode(bytes.subarray(0, MAX_PATCH), { stream: true })
              : patch,
          binary: f.binary,
          coverage: coverage(
            bytes.length > MAX_PATCH ? 'partial' : 'complete',
            bytes.length > MAX_PATCH ? ['patch_truncated'] : [],
            Math.min(bytes.length, MAX_PATCH),
            bytes.length,
          ),
          observedAt: Date.now(),
        };
      } catch (e) {
        if (aborted(e)) throw e;
        return fail('patch_unavailable');
      }
    },
  };
}
