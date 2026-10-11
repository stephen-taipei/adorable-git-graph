import { describe, expect, it } from 'vitest';
import { createGitHubDiagnostics } from './github-diagnostics.ts';
import { cacheDiagnostics, isDiagnosticRequest } from './diagnostics.ts';
const sha = (n: number) => n.toString(16).padStart(40, '0');
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const file = (filename: string, patch?: string) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 0,
  ...(patch === undefined ? {} : { patch }),
});
const commit = (n: number, parents: number[] = [], files: unknown[] = []) => ({
  sha: sha(n),
  parents: parents.map((p) => ({ sha: sha(p) })),
  commit: { message: `subject ${n}` },
  files,
});
const compare = (
  ahead = 0,
  behind = 0,
  merge = 10,
  commits: unknown[] = [],
  files: unknown[] = [],
) => ({
  ahead_by: ahead,
  behind_by: behind,
  merge_base_commit: { sha: sha(merge) },
  commits,
  files,
});
function mock(
  handler: (path: string, url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = decodeURIComponent(url.pathname);
    calls.push(path + url.search);
    const response = await handler(path, url, init);
    if (!path.includes('/compare/') || !response.ok) return response;
    const data = await response.json();
    if (data.base_commit === undefined)
      data.base_commit = { sha: path.split('/compare/')[1]!.split('...')[0]!.split(':').at(-1) };
    return json(data, response.status);
  };
  return { fetchImpl, calls };
}
describe('pinned GitHub diagnostics', () => {
  it('resolves moving refs once per query and never compares mutable names', async () => {
    let n = 20;
    const m = mock((p) =>
      p.endsWith('/commits/main')
        ? json(commit(10))
        : p.endsWith('/commits/topic')
          ? json(commit(n++))
          : json(compare()),
    );
    const a = createGitHubDiagnostics('o', 'r', m);
    expect((await a.compare('main', 'topic')).head.sha).toBe(sha(20));
    expect((await a.compare('main', 'topic')).head.sha).toBe(sha(21));
    expect(m.calls.filter((p) => p.includes('/compare/')).every((p) => !p.includes('topic'))).toBe(
      true,
    );
  });
  it('paginates both unique lists and separates merge-base files from initial tree diff', async () => {
    const m = mock((p, url) => {
      if (p.includes('/commits/')) return json(commit(parseInt(p.slice(-4), 16)));
      const pair = p.split('/compare/')[1];
      if (pair === `${sha(10)}...${sha(30)}`)
        return json(
          compare(
            201,
            1,
            20,
            Array.from({ length: 100 }, (_, i) =>
              commit(i + 100 * (Number(url.searchParams.get('page')) - 1) + 1),
            ),
            [file('decoy')],
          ),
        );
      if (pair === `${sha(30)}...${sha(10)}`) return json(compare(1, 201, 20, [commit(900)]));
      return json(compare(201, 0, 20, [], [file('actual')]));
    });
    const r = await createGitHubDiagnostics('o', 'r', m).compare(
      { name: 'base', sha: sha(10) },
      { name: 'head', sha: sha(30) },
    );
    expect([r.ahead, r.behind, r.ancestor]).toEqual([201, 1, 'no']);
    expect(r.headCommits).toHaveLength(200);
    expect(r.baseCommits.map((c) => c.sha)).toEqual([sha(900)]);
    expect(r.commitsCoverage.status).toBe('partial');
    expect(r.files.map((f) => f.path)).toEqual(['actual']);
    expect(r.filesCoverage.status).toBe('complete');
  });
  it('keeps counts nullable, files capped independently, and actual parents verified', async () => {
    const m = mock((p) =>
      p.includes('/commits/')
        ? json(commit(10, [11, 12], [file('first')]))
        : json(
            compare(
              0,
              0,
              12,
              [],
              Array.from({ length: 300 }, (_, i) => file(`file${i}`)),
            ),
          ),
    );
    const a = createGitHubDiagnostics('o', 'r', m);
    const r = await a.changes(sha(10), sha(12));
    expect(r.parentSha).toBe(sha(12));
    expect(r.filesCoverage.status).toBe('partial');
    await expect(a.changes(sha(10), sha(13))).rejects.toMatchObject({ code: 'invalid_repo' });
    const unknown = mock((p) =>
      p.includes('/commits/') ? json(commit(10)) : json({ commits: [], files: [] }),
    );
    const c = await createGitHubDiagnostics('o', 'r', unknown).compare('main', 'main');
    expect([c.ahead, c.behind, c.ancestor]).toEqual([null, null, 'unknown']);
  });
  it('distinguishes root, missing patch, provider truncation, and non-ancestor patch input', async () => {
    const m = mock((p) =>
      p.includes('/commits/')
        ? json(commit(100, [], [file('root', '@@ -0,0 +1 @@\n+root')]))
        : json(
            compare(
              1,
              0,
              41,
              [],
              [
                file('missing'),
                file('complete', '@@ -0,0 +1 @@\n+new'),
                file('large', 'x'.repeat(512 * 1024 + 20)),
                file('unknown', '@@ -0,0 +1 @@\ncontext'),
              ],
            ),
          ),
    );
    const a = createGitHubDiagnostics('o', 'r', m);
    expect((await a.changes(sha(100))).parentSha).toBeNull();
    expect((await a.patch(null, sha(100), 'root')).coverage.status).toBe('unknown');
    expect((await a.patch(sha(41), sha(42), 'missing')).patch).toBeNull();
    expect((await a.patch(sha(41), sha(42), 'complete')).coverage.status).toBe('unknown');
    expect((await a.patch(sha(41), sha(42), 'unknown')).coverage.status).toBe('unknown');
    expect((await a.patch(sha(41), sha(42), 'large')).coverage.status).toBe('partial');
    expect((await a.patch(sha(44), sha(42), 'large')).patch).toBeNull();
  });
  it('preserves fork PR repo identity and uses base repository compare', async () => {
    const m = mock((p) =>
      p.endsWith('/pulls/7')
        ? json({
            number: 7,
            title: 'Fork change',
            state: 'open',
            draft: true,
            merged: false,
            merged_at: null,
            base: { ref: 'main', sha: sha(10), repo: { full_name: 'o/r' } },
            head: { ref: 'feature', sha: sha(20), repo: { full_name: 'fork/r' } },
          })
        : p.includes('/commits/')
          ? json(commit(parseInt(p.slice(-4), 16)))
          : json(compare(1, 0, 10, [commit(20)], [file('fork', '@@ -0,0 +1 @@\n+fork')])),
    );
    const a = createGitHubDiagnostics('o', 'r', m),
      pr = await a.pullRequest!(7);
    expect(pr.head.repo).toBe('fork/r');
    expect(pr.draft).toBe(true);
    expect((await a.compare(pr.base, pr.head)).head.sha).toBe(sha(20));
    expect((await a.patch(pr.base.sha, pr.head.sha, 'fork')).patch).toContain('+fork');
    expect(m.calls.some((p) => p.includes(`/repos/fork/r/commits/${sha(20)}`))).toBe(true);
    expect(
      m.calls
        .filter((p) => p.includes('/compare/'))
        .every((p) => p.startsWith('/repos/o/r/compare/')),
    ).toBe(true);
  });
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
  ] as const)('classifies HTTP %s as %s', async (status, code) => {
    const a = createGitHubDiagnostics(
      'o',
      'r',
      mock(() => json({}, status)),
    );
    await expect(a.pullRequest!(1)).rejects.toMatchObject({ code });
  });
  it('does not follow response URLs or send credentials to redirects and cancels callers', async () => {
    const m = mock(async (_p, _url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-token' });
      return await new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    });
    const a = createGitHubDiagnostics('o', 'r', { ...m, token: 'fixture-token' }),
      ctrl = new AbortController(),
      pending = a.pullRequest!(1, ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(isDiagnosticRequest({ operation: 'changes', sha: 'main' })).toBe(false);
    expect(
      isDiagnosticRequest({ operation: 'patch', base: sha(1), head: sha(2), path: '../secret' }),
    ).toBe(false);
    await expect(a.compare('--option', 'main..bad')).rejects.toMatchObject({
      code: 'invalid_repo',
    });
    expect(m.calls).toHaveLength(1);
  });
  it('avoids caching unknown patch coverage and refuses an aborted cache hit', async () => {
    const m = mock(() => json(compare(1, 0, 1, [], [file('x', '@@ -0,0 +1 @@\n+x')]))),
      a = cacheDiagnostics(createGitHubDiagnostics('o', 'r', m));
    await a.patch(sha(1), sha(2), 'x');
    await a.patch(sha(1), sha(2), 'x');
    expect(m.calls).toHaveLength(2);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(a.patch(sha(1), sha(2), 'x', undefined, ctrl.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
  });
  it('uses explicit fork context for changes and patches even in a fresh adapter', async () => {
    const m = mock((path) =>
      path === `/repos/fork/r/commits/${sha(20)}`
        ? json(commit(20, [10], [file('fork', '@@ -0,0 +1 @@\n+fork')]))
        : path.includes('/compare/')
          ? json(compare(1, 0, 10, [], [file('fork', '@@ -0,0 +1 @@\n+fork')]))
          : json({}, 404),
    );
    const a = createGitHubDiagnostics('o', 'r', m);
    expect((await a.changes(sha(20), undefined, undefined, 'fork/r')).sha).toBe(sha(20));
    expect(
      (await a.patch(sha(10), sha(20), 'fork', undefined, undefined, 'fork/r')).patch,
    ).toContain('+fork');
    expect(m.calls.some((path) => path.includes(`fork:${sha(20)}`))).toBe(true);
  });
});
