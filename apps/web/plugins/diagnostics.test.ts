import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalDiagnostics } from './diagnostics.ts';
import { runDiagnosticGit } from './git-snapshot.ts';
const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'agg-diagnostics-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['--no-lazy-fetch', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
const repo = (format = 'sha1') => {
  const d = temp();
  git(d, 'init', '-q', '-b', 'main', `--object-format=${format}`);
  git(d, 'config', 'user.name', 'Fixture');
  git(d, 'config', 'user.email', 'fixture@example.test');
  git(d, 'config', 'commit.gpgSign', 'false');
  return d;
};
const put = (d: string, p: string, text: string | Buffer) => {
  mkdirSync(dirname(join(d, p)), { recursive: true });
  writeFileSync(join(d, p), text);
};
const commit = (d: string, msg: string) => {
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', msg);
  return git(d, 'rev-parse', 'HEAD');
};
const adapter = (d: string) =>
  createLocalDiagnostics(d, (args, signal) => runDiagnosticGit(d, args, signal));
const state = (d: string) => {
  const hash = createHash('sha256');
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(path, entry.name);
      hash.update(p);
      if (entry.isDirectory()) visit(p);
      else hash.update(readFileSync(p));
    }
  };
  visit(join(d, '.git'));
  return hash.digest('hex');
};

describe('read-only local source diagnostics', () => {
  it('limits file/directory replacement patches and byte coverage to the selected file', async () => {
    const d = repo();
    put(d, 'pkg', 'selected old file\n');
    const base = commit(d, 'file');
    rmSync(join(d, 'pkg'));
    put(d, 'pkg/child.txt', 'unrelated child\n'.repeat(50_000));
    const head = commit(d, 'directory');
    const expectedRemoved = runDiagnosticGit(d, [
      'diff',
      '-p',
      '--diff-filter=D',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      base,
      head,
      '--',
      'pkg',
    ]);
    const expectedAdded = runDiagnosticGit(d, [
      'diff',
      '-p',
      '--diff-filter=A',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      head,
      base,
      '--',
      'pkg',
    ]);
    const expected = await Promise.all([expectedRemoved, expectedAdded]);
    const before = state(d);
    for (const [from, to, text] of [
      [base, head, expected[0]],
      [head, base, expected[1]],
    ]) {
      const patch = await adapter(d).patch(from!, to!, 'pkg');
      expect(patch.patch).toBe(text);
      expect(patch.patch).not.toContain('pkg/child.txt');
      expect(patch.coverage.status).toBe('complete');
      expect(patch.coverage.loaded).toBe(Buffer.byteLength(text!));
      expect(patch.coverage.total).toBe(Buffer.byteLength(text!));
    }
    expect(state(d)).toBe(before);
  });

  it('isolates a rename from unrelated descendant renames', async () => {
    const d = repo(),
      isolated = repo();
    for (const cwd of [d, isolated]) put(cwd, 'from', 'selected rename\n');
    put(d, 'to/child.txt', 'unrelated rename\n');
    const base = commit(d, 'base'),
      isolatedBase = commit(isolated, 'base');
    rmSync(join(d, 'from'));
    rmSync(join(d, 'to'), { recursive: true });
    put(d, 'to', 'selected rename\n');
    put(d, 'from/child.txt', 'unrelated rename\n');
    rmSync(join(isolated, 'from'));
    put(isolated, 'to', 'selected rename\n');
    const head = commit(d, 'renames'),
      isolatedHead = commit(isolated, 'rename');
    const expected = await runDiagnosticGit(isolated, [
      'diff',
      '-p',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      isolatedBase,
      isolatedHead,
      '--',
      'from',
      'to',
    ]);
    const before = state(d);
    const patch = await adapter(d).patch(base, head, 'to', 'from');
    expect(patch.patch).toBe(expected);
    expect(patch.patch).not.toContain('child.txt');
    expect(patch.coverage.total).toBe(Buffer.byteLength(expected));
    expect(state(d)).toBe(before);
  });

  it.each([
    'space name.txt',
    'tab\tname.txt',
    'new\nline.txt',
    'quote"name.txt',
    '中文.txt',
    ':(glob)*.txt',
  ])('uses a checked legacy fallback for the exact literal leaf %j', async (path) => {
    const d = repo();
    put(d, path, 'one\n');
    const base = commit(d, 'base');
    put(d, path, 'two\n');
    const head = commit(d, 'head');
    const calls: string[][] = [];
    const legacy = createLocalDiagnostics(d, async (args, signal) => {
      calls.push([...args]);
      if (args.includes('--max-depth=0')) throw Object.assign(new Error('old Git'), { code: 129 });
      return runDiagnosticGit(d, args, signal);
    });
    const expected = await runDiagnosticGit(d, [
      'diff',
      '-p',
      '--no-color',
      base,
      head,
      '--',
      path,
    ]);
    const before = state(d);
    const result = await legacy.patch(base, head, path);
    expect(result.patch).toBe(expected);
    expect(result.coverage.status).toBe('complete');
    expect(calls.filter((a) => a[0] === 'ls-tree')).toHaveLength(2);
    expect(state(d)).toBe(before);
  });

  it('keeps legacy root, rename, mode and missing-child gitlink patches readable', async () => {
    const d = repo();
    put(d, 'before', 'rename content\n');
    const base = commit(d, 'root');
    const legacy = createLocalDiagnostics(d, async (args, signal) => {
      if (args.includes('--max-depth=0')) throw new Error('depth flag unavailable');
      return runDiagnosticGit(d, args, signal);
    });
    expect((await legacy.patch(null, base, 'before')).coverage.status).toBe('complete');
    rmSync(join(d, 'before'));
    put(d, 'after', 'rename content\n');
    const renamed = commit(d, 'rename');
    expect((await legacy.patch(base, renamed, 'after', 'before')).patch).toContain(
      'rename to after',
    );
    chmodSync(join(d, 'after'), 0o755);
    const mode = commit(d, 'mode');
    expect((await legacy.patch(renamed, mode, 'after')).patch).toContain('new mode 100755');
    const sub = repo();
    git(sub, 'update-index', '--add', '--cacheinfo', '160000', '4'.repeat(40), 'vendor/mod');
    git(sub, 'commit', '-q', '-m', 'root gitlink');
    const subHead = git(sub, 'rev-parse', 'HEAD');
    const subLegacy = createLocalDiagnostics(sub, async (args, signal) => {
      if (args.includes('--max-depth=0')) throw new Error('depth flag unavailable');
      return runDiagnosticGit(sub, args, signal);
    });
    const before = state(sub);
    expect((await subLegacy.patch(null, subHead, 'vendor/mod')).patch).toContain(
      'Subproject commit',
    );
    expect(state(sub)).toBe(before);
  });

  it('refuses legacy recursion when an endpoint contains a tree at the selected path', async () => {
    const d = repo();
    put(d, 'pkg', 'file\n');
    const base = commit(d, 'file');
    rmSync(join(d, 'pkg'));
    put(d, 'pkg/child', 'child\n');
    const head = commit(d, 'directory');
    const calls: string[][] = [];
    const legacy = createLocalDiagnostics(d, async (args, signal) => {
      calls.push([...args]);
      if (args.includes('--max-depth=0')) throw new Error('old Git');
      return runDiagnosticGit(d, args, signal);
    });
    const result = await legacy.patch(base, head, 'pkg');
    expect(result.coverage.status).toBe('unavailable');
    expect(result.error).toBe('exact_patch_unavailable');
    expect(
      calls.some((a) => a[0] === 'diff' && a.includes('-p') && !a.includes('--max-depth=0')),
    ).toBe(false);
  });

  it.each(['unterminated', 'wrong-path', 'extra-field', 'multiple-records'])(
    'rejects malformed legacy leaf proof: %s',
    async (kind) => {
      const d = repo();
      put(d, 'leaf', 'one\n');
      const base = commit(d, 'base');
      put(d, 'leaf', 'two\n');
      const head = commit(d, 'head');
      const object = git(d, 'rev-parse', `${head}:leaf`);
      const valid = `100644 blob ${object}\tleaf\0`;
      const bad =
        kind === 'unterminated'
          ? valid.slice(0, -1)
          : kind === 'wrong-path'
            ? valid.replace('\tleaf', '\tother')
            : kind === 'extra-field'
              ? valid.replace('\t', ' extra\t')
              : valid + valid;
      const calls: string[][] = [];
      const legacy = createLocalDiagnostics(d, async (args, signal) => {
        calls.push([...args]);
        if (args.includes('--max-depth=0')) throw new Error('old Git');
        if (args[0] === 'ls-tree') return bad;
        return runDiagnosticGit(d, args, signal);
      });
      expect((await legacy.patch(base, head, 'leaf')).error).toBe('exact_patch_unavailable');
      expect(calls.some((a) => a.includes('-p') && !a.includes('--max-depth=0'))).toBe(false);
    },
  );

  it('propagates cancellation before attempting a legacy exact-path proof', async () => {
    const d = repo();
    put(d, 'leaf', 'one\n');
    const base = commit(d, 'base');
    put(d, 'leaf', 'two\n');
    const head = commit(d, 'head');
    const calls: string[][] = [];
    const local = createLocalDiagnostics(d, async (args, signal) => {
      calls.push([...args]);
      if (args.includes('--max-depth=0')) throw new DOMException('cancelled', 'AbortError');
      return runDiagnosticGit(d, args, signal);
    });
    await expect(local.patch(base, head, 'leaf')).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.some((a) => a[0] === 'ls-tree')).toBe(false);
  });

  it('reports fixed-SHA gitlinks even when repository settings ignore submodules', async () => {
    const child = repo();
    put(child, 'child.txt', 'one\n');
    const childBase = commit(child, 'child base');
    put(child, 'child.txt', 'two\n');
    const childHead = commit(child, 'child head');
    const d = repo();
    git(d, 'update-index', '--add', '--cacheinfo', '160000', childBase, 'vendor/mod');
    git(d, 'commit', '-q', '-m', 'root gitlink');
    const base = git(d, 'rev-parse', 'HEAD');
    git(d, 'branch', 'base', base);
    git(d, 'update-index', '--cacheinfo', '160000', childHead, 'vendor/mod');
    git(d, 'commit', '-q', '-m', 'update gitlink');
    const head = git(d, 'rev-parse', 'HEAD');
    git(d, 'config', 'diff.ignoreSubmodules', 'all');
    const expectedPaths = git(
      d,
      'diff',
      '--name-only',
      '--ignore-submodules=none',
      base,
      head,
    ).split('\n');
    expect(expectedPaths).toEqual(['vendor/mod']);
    const before = state(d);
    const a = adapter(d);
    for (const result of [await a.changes(head), await a.compare('base', 'main')]) {
      expect(result.files.map((f) => f.path)).toEqual(expectedPaths);
      expect(result.files[0]).toMatchObject({ additions: 1, deletions: 1, binary: false });
      expect(result.filesCoverage.status).toBe('complete');
    }
    const patch = await a.patch(base, head, 'vendor/mod');
    expect(patch.coverage.status).toBe('complete');
    expect(patch.patch).toBe(
      git(
        d,
        'diff',
        '-p',
        '--no-color',
        '--submodule=short',
        '--ignore-submodules=none',
        base,
        head,
        '--',
        'vendor/mod',
      ) + '\n',
    );
    expect(patch.patch).toContain(`-Subproject commit ${childBase}`);
    expect(patch.patch).toContain(`+Subproject commit ${childHead}`);
    const root = await a.changes(base);
    expect(root.files.map((f) => f.path)).toEqual(['vendor/mod']);
    expect((await a.patch(null, base, 'vendor/mod')).patch).toContain(
      `+Subproject commit ${childBase}`,
    );
    expect(state(d)).toBe(before);
  });

  it.each(['sha1', 'sha256'])(
    'matches exact Git divergence and root/merge-parent tree diffs (%s)',
    async (format) => {
      const d = repo(format);
      put(d, 'root.txt', 'root\n');
      const root = commit(d, 'root');
      git(d, 'checkout', '-q', '-b', 'topic');
      put(d, 'side.txt', 'side\n');
      const side = commit(d, 'side');
      put(d, 'second.txt', 'second\n');
      const head = commit(d, 'second');
      git(d, 'checkout', '-q', 'main');
      put(d, 'main.txt', 'main\n');
      const base = commit(d, 'main');
      const before = state(d),
        a = adapter(d),
        r = await a.compare('main', 'topic');
      expect(r.base.sha).toBe(base);
      expect(r.head.sha).toBe(head);
      expect(r.mergeBase).toBe(root);
      expect([r.behind, r.ahead]).toEqual(
        git(d, 'rev-list', '--left-right', '--count', `${base}...${head}`).split(/\s+/).map(Number),
      );
      expect(r.ancestor).toBe('no');
      expect(r.headCommits.map((c) => c.sha).sort()).toEqual([side, head].sort());
      expect(r.baseCommits.map((c) => c.sha)).toEqual([base]);
      expect(r.files.map((f) => f.path).sort()).toEqual(['second.txt', 'side.txt']);
      expect(r.commitsCoverage.status).toBe('complete');
      const same = await a.compare('main', 'main');
      expect([same.ahead, same.behind, same.ancestor, same.files.length]).toEqual([0, 0, 'yes', 0]);
      const rootChanges = await a.changes(root);
      expect(rootChanges.parentSha).toBeNull();
      expect(rootChanges.files[0]).toMatchObject({ path: 'root.txt', additions: 1, deletions: 0 });
      expect((await a.patch(null, root, 'root.txt')).patch).toContain('+root');
      const changes = await a.changes(head);
      expect(changes.parentSha).toBe(side);
      expect(changes.files.map((f) => f.path)).toEqual(['second.txt']);
      expect((await a.patch(root, head, 'second.txt')).patch).toBe(
        git(
          d,
          'diff',
          '-p',
          '--find-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--submodule=short',
          '--no-color',
          '--unified=3',
          root,
          head,
          '--',
          'second.txt',
        ) + '\n',
      );
      expect(state(d)).toBe(before);
      git(d, 'merge', '-q', '--no-ff', 'topic', '-m', 'merge');
      const merge = git(d, 'rev-parse', 'HEAD');
      const mergeBefore = state(d);
      expect((await a.changes(merge)).parentSha).toBe(base);
      expect((await a.changes(merge, head)).files.map((f) => f.path)).toEqual(['main.txt']);
      await expect(a.changes(merge, root)).rejects.toThrow('invalid_revision');
      expect(state(d)).toBe(mergeBefore);
    },
  );
  it('retains known unrelated counts while making merge-base files unavailable', async () => {
    const d = repo();
    put(d, 'a', 'a');
    commit(d, 'a');
    git(d, 'checkout', '-q', '--orphan', 'isolated');
    git(d, 'rm', '-q', '-rf', '.');
    put(d, 'b', 'b');
    commit(d, 'b');
    const r = await adapter(d).compare('main', 'isolated');
    expect([r.ahead, r.behind, r.ancestor, r.mergeBase]).toEqual([1, 1, 'no', null]);
    expect(r.filesCoverage.status).toBe('unavailable');
    expect(r.error).toBe('no_common_ancestor');
  });
  it('preserves rename paths, literal pathspecs, binary status and disables helpers', async () => {
    const d = repo(),
      old = 'old\tname\n.txt',
      next = 'new\tname\n.txt';
    const original = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
    put(d, '.gitattributes', '*.txt diff=probe\n');
    put(d, old, original);
    put(d, 'wanted.txt', 'OTHER\n');
    put(d, 'binary', Buffer.from([0, 1, 2]));
    const base = commit(d, 'base');
    const marker = join(d, 'helper-ran'),
      helper = join(d, 'helper.sh');
    put(d, 'helper.sh', `#!/bin/sh\nprintf x > '${marker}'\n`);
    chmodSync(helper, 0o755);
    git(d, 'config', 'diff.external', helper);
    git(d, 'config', 'diff.probe.textconv', helper);
    rmSync(join(d, old));
    put(d, next, original.replace('line 0', 'changed'));
    put(d, ':(glob)wanted.txt', 'LITERAL\n');
    put(d, 'binary', Buffer.from([0, 2, 3]));
    const head = commit(d, 'rename');
    const before = state(d),
      a = adapter(d);
    const r = await a.changes(head);
    expect(r.files.find((f) => f.path === next)).toMatchObject({
      previousPath: old,
      additions: 1,
      deletions: 1,
    });
    expect((await a.patch(base, head, next, old)).patch).toContain('+changed');
    const literal = await a.patch(base, head, ':(glob)wanted.txt');
    expect(literal.patch).toContain('+LITERAL');
    expect(literal.patch).not.toContain('OTHER');
    expect(await a.patch(base, head, 'binary')).toMatchObject({ patch: null, binary: true });
    expect(existsSync(marker)).toBe(false);
    expect(state(d)).toBe(before);
  });
  it('separates large file and patch coverage, including UTF-8 byte caps', async () => {
    const d = repo();
    for (let i = 0; i < 301; i++) put(d, `file-${i}.txt`, 'x\n');
    put(d, 'large.txt', ('中文字'.repeat(70) + '\n').repeat(3000));
    const head = commit(d, 'large');
    const before = state(d),
      a = adapter(d);
    expect((await a.changes(head)).filesCoverage).toMatchObject({
      status: 'partial',
      loaded: 300,
      total: 302,
    });
    const patch = await a.patch(null, head, 'large.txt');
    expect(patch.coverage.status).toBe('partial');
    expect(Buffer.byteLength(patch.patch!)).toBeLessThanOrEqual(512 * 1024);
    expect(patch.patch).not.toContain('\ufffd');
    expect(state(d)).toBe(before);
  });
  it('fails closed for missing objects and shallow history', async () => {
    const d = repo();
    put(d, 'value', 'first\n');
    const base = commit(d, 'first');
    put(d, 'value', 'second\n');
    const head = commit(d, 'second');
    const shallow = temp();
    git(tmpdir(), 'clone', '-q', '--depth=1', pathToFileURL(d).href, shallow);
    const a = adapter(shallow),
      before = state(shallow),
      r = await a.compare('HEAD', 'HEAD');
    expect([r.ahead, r.behind, r.ancestor]).toEqual([null, null, 'unknown']);
    await expect(a.changes(head)).rejects.toThrow('shallow_history');
    expect(state(shallow)).toBe(before);
    rmSync(join(d, '.git', 'objects', base.slice(0, 2), base.slice(2)));
    const missingBefore = state(d);
    await expect(adapter(d).changes(head)).rejects.toThrow('missing_objects');
    expect(state(d)).toBe(missingBefore);
  });
  it('never lazy-fetches absent partial clone blobs', async () => {
    const d = repo();
    put(d, 'value', 'first\n');
    const base = commit(d, 'first');
    put(d, 'value', 'second\n');
    const head = commit(d, 'second');
    git(d, 'config', 'uploadpack.allowFilter', 'true');
    const partial = temp();
    git(
      tmpdir(),
      'clone',
      '-q',
      '--filter=blob:none',
      '--no-checkout',
      pathToFileURL(d).href,
      partial,
    );
    const blob = git(partial, 'rev-parse', `${head}:value`);
    expect(() => git(partial, 'cat-file', '-e', blob)).toThrow();
    const before = state(partial);
    expect((await adapter(partial).patch(base, head, 'value')).coverage.status).toBe('unavailable');
    expect(state(partial)).toBe(before);
    expect(() => git(partial, 'cat-file', '-e', blob)).toThrow();
  });
  it('returns unknown for an invalid ref and propagates cancellation', async () => {
    const d = repo();
    put(d, 'a', 'a');
    commit(d, 'root');
    const a = adapter(d);
    expect((await a.compare('--evil', 'HEAD')).ancestor).toBe('unknown');
    const ctrl = new AbortController();
    const pending = a.compare('HEAD', 'HEAD', ctrl.signal);
    ctrl.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });
});
