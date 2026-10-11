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
