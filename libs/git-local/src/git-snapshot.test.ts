import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLayout } from '@adorable/graph-core';
import {
  defaultStateFile,
  discoverRepos,
  findGit,
  isSameOrigin,
  readGitSnapshot,
  repoIdFor,
  snapshotKey,
  watchGitRefs,
} from './git-snapshot.ts';

const tmps: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};

const baseEnv = {
  GIT_AUTHOR_NAME: 'Amy',
  GIT_AUTHOR_EMAIL: 'amy@example.test',
  GIT_COMMITTER_NAME: 'Amy',
  GIT_COMMITTER_EMAIL: 'amy@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
// plugin 以 process.env 執行 git：測試期間固定成乾淨的設定，不受執行者的 ~/.gitconfig 影響
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(baseEnv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// beforeAll で baseEnv は process.env に入っている。テストが GIT_CONFIG_GLOBAL を差し替えたらそれを尊重する
const env = () => ({ ...process.env });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();
let tick = 0;
const commit = (cwd: string, msg: string, ...extra: string[]) => {
  // 固定、遞增的時間，讓 --date-order 可預期
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  execFileSync('git', ['commit', '--allow-empty', ...extra, '-m', msg], {
    cwd,
    env: { ...env(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeout = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > timeout) throw new Error('waitFor timed out');
    await sleep(25);
  }
};

let root: string;
beforeAll(() => {
  root = tmp('agg-git-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/octo/cat.git');
  commit(root, 'chore: root');
  commit(root, 'feat: two');
  git(root, 'tag', 'v1');
  git(root, 'checkout', '-q', '-b', 'feat/x');
  commit(root, 'feat: side 1');
  commit(root, 'fix: side 2');
  git(root, 'checkout', '-q', 'main');
  commit(root, 'docs: main three');
  const date = new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString();
  execFileSync('git', ['merge', '--no-ff', 'feat/x', '-m', "Merge branch 'feat/x'"], {
    cwd: root,
    env: { ...env(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
});

describe('readGitSnapshot', () => {
  it('reads commits, branches and tags from a real repository', async () => {
    const snap = await readGitSnapshot(root);
    expect(snap.error).toBeUndefined();
    const g = snap.graph!;
    expect(g.commits).toHaveLength(6);
    expect(g.repo).toMatchObject({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    expect(
      g.refs
        .filter((r) => r.kind === 'branch')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['feat/x', 'main']);
    expect(g.refs.find((r) => r.kind === 'tag')).toMatchObject({ name: 'v1' });
    expect(g.refs.find((r) => r.name === 'main')).toMatchObject({ isDefault: true });
    expect(g.commits.every((c) => c.url?.startsWith('https://github.com/octo/cat/commit/'))).toBe(
      true,
    );
    expect(g.commits.find((c) => c.message.startsWith('Merge'))!.parents).toHaveLength(2);
    expect(g.truncated).toBe(false);
  });

  it('never leaks remote credentials, author emails, or message bodies / trailers', async () => {
    const dir = tmp('agg-trailer-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/octo/cat.git');
    commit(
      dir,
      'feat: subject line\n\nlong body that must stay local\n\nSigned-off-by: Bob <bob.private@corp.example>\nCo-authored-by: Cy <cy.private@corp.example>',
    );
    const json = JSON.stringify(await readGitSnapshot(dir));
    for (const secret of [
      'SECRET',
      'x-access-token',
      'amy@example.test',
      'bob.private',
      'cy.private',
      'long body',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain('feat: subject line');
  });

  it('cannot be forged or broken by control characters inside a commit subject', async () => {
    const dir = tmp('agg-forge-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'chore: root');
    const fake = 'a'.repeat(40);
    commit(
      dir,
      `fix: pwn\x1e${fake}\x1f${fake}\x1fLinus Torvalds\x1f2026-01-01T00:00:00+00:00\x1fforged`,
    );
    const g = (await readGitSnapshot(dir)).graph!;
    expect(g.commits).toHaveLength(2);
    expect(g.commits.every((c) => c.authorName === 'Amy')).toBe(true);
    expect(g.commits.some((c) => c.sha === fake)).toBe(false);
    expect(() => buildLayout(g)).not.toThrow();
  });

  it('ignores log.showSignature from the user config (signed commits stay in the graph)', async () => {
    const dir = tmp('agg-signed-');
    const fakeGpg = join(dir, 'fakegpg.sh');
    writeFileSync(
      fakeGpg,
      `#!/bin/sh
case "$*" in
  *--verify*)
    echo "gpg: Signature made Thu 01 Jan 2026 00:00:00 UTC" >&2
    echo "gpg: Can't check signature: No public key" >&2
    echo "[GNUPG:] ERRSIG 0 1 8 00 0 9 - 0000" ;;
  *)
    cat >/dev/null
    echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0000" >&2
    printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n' ;;
esac
`,
    );
    chmodSync(fakeGpg, 0o755);
    const cfg = join(dir, 'gitconfig');
    writeFileSync(cfg, `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${fakeGpg}\n`);

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      commit(repo, 'one');
      commit(repo, 'signed two', '-S');
      commit(repo, 'three');
      const g = (await readGitSnapshot(repo)).graph!;
      expect(g.commits.map((c) => c.message).sort()).toEqual(['one', 'signed two', 'three']);
      expect(g.refs.find((r) => r.name === 'main')).toBeTruthy();
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
  });

  it('produces a layout with the merge on the main lane and a side branch lane', async () => {
    const layout = buildLayout((await readGitSnapshot(root)).graph!);
    const merge = layout.nodes.find((n) => n.kind === 'merge')!;
    expect(merge.lane).toBe(0);
    expect(merge.isHead).toBe(true);
    expect(layout.nodes.find((n) => n.subject === 'fix: side 2')!.lane).not.toBe(0);
  });

  it('respects maxCommits and flags the truncation', async () => {
    const snap = await readGitSnapshot(root, { maxCommits: 3 });
    expect(snap.graph!.commits).toHaveLength(3);
    expect(snap.graph!.truncated).toBe(true);
  });

  it('honours the AGG_* environment variables', async () => {
    const keys = ['AGG_MAX_COMMITS', 'AGG_MAX_BRANCHES', 'AGG_DEFAULT_BRANCH'] as const;
    try {
      process.env['AGG_MAX_COMMITS'] = '2';
      expect((await readGitSnapshot(root)).graph!.commits).toHaveLength(2);
      delete process.env['AGG_MAX_COMMITS'];

      process.env['AGG_MAX_BRANCHES'] = '1';
      expect(
        (await readGitSnapshot(root)).graph!.refs.filter((r) => r.kind === 'branch'),
      ).toHaveLength(1);
      delete process.env['AGG_MAX_BRANCHES'];

      process.env['AGG_DEFAULT_BRANCH'] = 'feat/x';
      const g = (await readGitSnapshot(root)).graph!;
      expect(g.repo.defaultBranch).toBe('feat/x');
      expect(g.refs.find((r) => r.isDefault)!.name).toBe('feat/x');
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });

  it('snapshotKey ignores timestamps but notices a new commit', async () => {
    const dir = tmp('agg-key-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'a');
    const a = await readGitSnapshot(dir);
    await sleep(5);
    const b = await readGitSnapshot(dir);
    expect(snapshotKey(a)).toBe(snapshotKey(b));
    commit(dir, 'b');
    expect(snapshotKey(await readGitSnapshot(dir))).not.toBe(snapshotKey(a));
  });

  it('falls back to HEAD when there is no branch at all (detached HEAD, e.g. CI checkouts)', async () => {
    const dir = tmp('agg-detached-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'chore: one');
    commit(dir, 'chore: two');
    git(dir, 'checkout', '-q', '--detach');
    git(dir, 'branch', '-q', '-D', 'main');
    const snap = await readGitSnapshot(dir);
    expect(snap.graph!.commits).toHaveLength(2);
    expect(snap.graph!.refs.filter((r) => r.kind === 'branch')).toEqual([]);
    expect(buildLayout(snap.graph!).nodes).toHaveLength(2);
  });

  it('handles an empty repository', async () => {
    const empty = tmp('agg-empty-');
    git(empty, 'init', '-q', '-b', 'main');
    const snap = await readGitSnapshot(empty);
    expect(snap.graph!.commits).toEqual([]);
    expect(buildLayout(snap.graph!).nodes).toEqual([]);
  });

  it('reads bare repositories (name comes from the folder)', async () => {
    const dir = tmp('agg-bare-');
    const bare = join(dir, 'project.git');
    git(dir, 'clone', '-q', '--bare', root, bare);
    const g = (await readGitSnapshot(bare)).graph!;
    expect(g.commits).toHaveLength(6);
    expect(g.repo.name).toBe('project');
  });

  it('flags shallow clones as truncated', async () => {
    const dir = tmp('agg-shallow-');
    const clone = join(dir, 'clone');
    git(dir, 'clone', '-q', '--depth', '2', `file://${root}`, clone);
    const g = (await readGitSnapshot(clone)).graph!;
    expect(g.truncated).toBe(true);
    expect(g.commits.length).toBeGreaterThan(0);
  });

  it('reports friendly errors that never contain local paths', async () => {
    const plain = tmp('agg-plain-');
    mkdirSync(join(plain, 'sub'));
    writeFileSync(join(plain, 'sub', 'a.txt'), 'x');
    const missing = join(plain, 'does-not-exist');

    for (const dir of [join(plain, 'sub'), missing]) {
      const snap = await readGitSnapshot(dir);
      expect(snap.graph).toBeNull();
      expect(snap.error).toMatch(/not inside a git repository|does not exist/);
      expect(snap.error).not.toContain(tmpdir());
    }
  });

  it('returns a transient error snapshot (and warns) instead of throwing when git itself fails', async () => {
    const dir = tmp('agg-broken-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'ok');
    // ref 指到不存在的 object：`git for-each-ref` 以 128 結束（fatal: missing object）
    writeFileSync(join(dir, '.git/refs/heads/bad'), `${'1'.repeat(40)}\n`);
    const warnings: string[] = [];
    const snap = await readGitSnapshot(dir, { onWarn: (m) => warnings.push(m) });
    expect(snap.graph).toBeNull();
    expect(snap.transient).toBe(true);
    expect(snap.error).toMatch(/git reported an error/);
    expect(snap.error).not.toContain(tmpdir());
    expect(warnings.join('\n')).toMatch(/missing object/); // 細節只走 onWarn（終端機），不進快照
  });

  it('is not fooled by a non-UTF-8 i18n.logOutputEncoding in the user config', async () => {
    const dir = tmp('agg-enc-');
    const cfg = join(dir, 'gitconfig');
    writeFileSync(cfg, '[i18n]\n\tlogOutputEncoding = latin1\n');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      commit(repo, 'feat: café 日本語 ✓');
      const g = (await readGitSnapshot(repo)).graph!;
      expect(g.commits[0]!.message).toBe('feat: café 日本語 ✓');
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
  });

  it('always loads the default branch tip, even when other branches have newer commits than the cap', async () => {
    const dir = tmp('agg-default-tip-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'main: old tip');
    git(dir, 'checkout', '-q', '-b', 'busy');
    for (let i = 0; i < 6; i++) commit(dir, `busy ${i}`);
    const g = (await readGitSnapshot(dir, { maxCommits: 3 })).graph!;
    expect(g.refs.find((r) => r.isDefault)?.name).toBe('main');
    expect(g.commits.some((c) => c.message === 'main: old tip')).toBe(true);
    expect(buildLayout(g).nodes.find((n) => n.isHead)?.subject).toBe('main: old tip');
  });

  it('a deeper read only appends: the loaded commits are always a --date-order prefix (the default tip is reached by reading deeper)', async () => {
    const dir = tmp('agg-prefix-');
    git(dir, 'init', '-q', '-b', 'main');
    for (let i = 0; i < 5; i++) commit(dir, `main ${i}`);
    // 兩條比 main 新、日期交錯的 branch：main 的 tip 比「最新 N 筆」舊
    git(dir, 'branch', 'b', 'HEAD~2');
    git(dir, 'checkout', '-q', '-b', 'a');
    for (let i = 0; i < 6; i++) {
      commit(dir, `a ${i}`);
      git(dir, 'checkout', '-q', 'b');
      commit(dir, `b ${i}`);
      git(dir, 'checkout', '-q', 'a');
    }
    const mainTip = git(dir, 'rev-parse', 'main');
    const order = git(dir, 'rev-list', '--date-order', 'main', 'a', 'b').split('\n');
    const mainAt = order.indexOf(mainTip);
    expect(mainAt).toBe(12);
    let previous: string[] = [];
    for (const n of [3, 5, 13, 14, 17]) {
      const shas = (await readGitSnapshot(dir, { maxCommits: n })).graph!.commits.map((c) => c.sha);
      expect(shas.length, String(n)).toBe(Math.max(n, mainAt + 1));
      expect(new Set(shas), String(n)).toEqual(new Set(order.slice(0, shas.length)));
      expect(shas).toContain(mainTip);
      // 讀得更深時只會在後面多出更早的 commit
      expect(shas.slice(0, previous.length)).toEqual(previous);
      previous = shas;
    }
  });

  it('only a default tip deeper than MAX_DEPTH falls back to reading its own recent segment', async () => {
    const dir = tmp('agg-very-deep-');
    git(dir, 'init', '-q', '-b', 'main');
    // main = 很舊的一筆；busy 在它之後還有 5002 筆（比 MAX_DEPTH 深）
    const lines = [
      'commit refs/heads/main',
      'mark :1',
      'committer Amy <amy@example.test> 1000000000 +0000',
      'data 9',
      'main: old',
      '',
    ];
    for (let i = 0; i < 5002; i++) {
      lines.push(
        'commit refs/heads/busy',
        `committer Amy <amy@example.test> ${1000000001 + i} +0000`,
        `data ${`busy ${i}`.length}`,
        `busy ${i}`,
        ...(i === 0 ? ['from :1'] : []),
        '',
      );
    }
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: dir,
      env: env(),
      input: `${lines.join('\n')}\n`,
    });
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/busy');
    const g = (await readGitSnapshot(dir, { maxCommits: 3 })).graph!;
    expect(g.commits.map((c) => c.message)).toEqual([
      'busy 5001',
      'busy 5000',
      'busy 4999',
      'main: old',
    ]);
    expect(g.refs.find((r) => r.isDefault)?.name).toBe('main');
  });
});

async function awaitWatcherReady(gitDir: string, calls: () => number) {
  const ref = join(gitDir, 'refs', 'heads', 'main');
  const value = readFileSync(ref);
  const before = calls();
  // Native fs.watch has no ready event. Verify a real callback before asserting later updates.
  await waitFor(() => {
    if (calls() > before) return true;
    writeFileSync(ref, value);
    return false;
  }, 3000);
}

describe('watchGitRefs (regression: live updates must keep working after the first change)', () => {
  it('fires for EVERY consecutive commit, branch switch and ref update — not just the first', async () => {
    const dir = tmp('agg-watch-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const gitDir = join(dir, '.git');

    let calls = 0;
    const stop = watchGitRefs([gitDir], () => calls++);
    try {
      await awaitWatcherReady(gitDir, () => calls);
      const expectEvent = async (label: string, action: () => void) => {
        const before = calls;
        action();
        await waitFor(() => calls > before, 4000).catch(() => {
          throw new Error(`no event after: ${label}`);
        });
        await sleep(150);
      };
      // Node 在 Linux 的遞迴 fs.watch 會在第 2 次之後就不再通知；這裡連續做很多次
      for (let i = 2; i <= 6; i++) await expectEvent(`commit #${i}`, () => commit(dir, `c${i}`));
      await expectEvent('checkout -b other', () => git(dir, 'checkout', '-q', '-b', 'other'));
      await expectEvent('checkout main', () => git(dir, 'checkout', '-q', 'main'));
      await expectEvent('checkout other again', () => git(dir, 'checkout', '-q', 'other'));
      await expectEvent('tag', () => git(dir, 'tag', 'v1'));
      await expectEvent('new nested branch dir', () => git(dir, 'branch', 'feat/deep/er'));
      await expectEvent('checkout into it', () => git(dir, 'checkout', '-q', 'feat/deep/er'));
      // 這一步只改動「新建出來的巢狀目錄」裡的 ref 檔：目錄若沒被補上監看，就收不到事件
      await expectEvent('commit inside the nested ref directory', () => commit(dir, 'nested'));
    } finally {
      stop();
    }
  });

  it('keeps watching a ref directory that is deleted and re-created (branch delete, git gc, pack-refs)', async () => {
    const dir = tmp('agg-watch-recreate-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    git(dir, 'branch', 'feat/a');
    const gitDir = join(dir, '.git');

    let calls = 0;
    const stop = watchGitRefs([gitDir], () => calls++);
    try {
      await awaitWatcherReady(gitDir, () => calls);
      const expectEvent = async (label: string, action: () => void) => {
        const before = calls;
        action();
        await waitFor(() => calls > before, 4000).catch(() => {
          throw new Error(`no event after: ${label}`);
        });
        await sleep(200);
      };
      // refs/heads/feat 被刪掉（最後一個 feat/* 刪除）再重建，之後只改動裡面的 ref 檔
      await expectEvent('delete the only nested branch (removes refs/heads/feat)', () =>
        git(dir, 'branch', '-q', '-D', 'feat/a'),
      );
      await expectEvent('re-create a nested branch (re-creates refs/heads/feat)', () =>
        git(dir, 'branch', 'feat/b'),
      );
      await expectEvent('move ONLY the ref file inside the re-created directory', () =>
        git(dir, 'update-ref', 'refs/heads/feat/b', git(dir, 'rev-parse', 'HEAD')),
      );
      await expectEvent('second change inside it', () => {
        commit(dir, 'two');
        git(dir, 'update-ref', 'refs/heads/feat/b', git(dir, 'rev-parse', 'HEAD'));
      });
      // pack-refs --prune 會刪掉所有鬆散 ref 與空目錄，之後的更新又會重建它們
      await expectEvent('git pack-refs --all --prune', () =>
        git(dir, 'pack-refs', '--all', '--prune'),
      );
      await expectEvent('ref update after pack-refs', () => git(dir, 'branch', 'feat/c'));
      await expectEvent('only the ref inside after pack-refs', () =>
        git(dir, 'update-ref', 'refs/heads/feat/c', git(dir, 'rev-parse', 'HEAD~1')),
      );
    } finally {
      stop();
    }
  });

  it('still watches when <gitDir>/refs itself is a symlink (git-new-workdir layouts), but never below it', async () => {
    const dir = tmp('agg-watch-linkedrefs-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const shared = tmp('agg-watch-sharedrefs-');
    execFileSync('mv', [join(dir, '.git', 'refs'), join(shared, 'refs')]);
    symlinkSync(join(shared, 'refs'), join(dir, '.git', 'refs'));
    let calls = 0;
    const stop = watchGitRefs([join(dir, '.git')], () => calls++);
    try {
      await awaitWatcherReady(join(dir, '.git'), () => calls);
      const before = calls;
      git(dir, 'branch', 'feat/linked');
      await waitFor(() => calls > before, 4000);
    } finally {
      stop();
    }
  });

  it('stops notifying after being closed', async () => {
    const dir = tmp('agg-watch-close-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    let calls = 0;
    const stop = watchGitRefs([join(dir, '.git')], () => calls++);
    stop();
    commit(dir, 'two');
    await sleep(400);
    expect(calls).toBe(0);
  });
});

describe('discoverRepos', () => {
  it('finds repos (incl. worktrees and bare *.git) without following symlinks or descending into repos', async () => {
    const base = realpathSync(tmp('agg-discover-'));
    const init = (rel: string) => {
      const dir = join(base, rel);
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      commit(dir, rel);
      return dir;
    };
    const a = init('a');
    init('a/nested'); // repo 裡面的 repo（submodule 等）不列
    const deep = init('x/y/deep');
    init('x/y/z/too-deep'); // 第 4 層：超過預設深度 3
    init('node_modules/pkg');
    init('.hidden/repo');
    init('dist/out');
    const outside = realpathSync(tmp('agg-discover-outside-'));
    git(outside, 'init', '-q', '-b', 'main');
    symlinkSync(outside, join(base, 'link-to-outside'));
    symlinkSync(base, join(base, 'x', 'loop'));
    git(base, 'clone', '-q', '--bare', a, join(base, 'srv', 'b.git'));
    git(a, 'worktree', 'add', '-q', join(base, 'wt'), '-b', 'wt-branch');
    mkdirSync(join(base, 'not-a-repo', 'empty'), { recursive: true });
    const build = init('build'); // 名字在略過清單裡，但它本身就是 repo：要列出來（只是不往裡面找）
    init('build/inner');

    const { repos, truncated } = await discoverRepos([base]);
    expect(truncated).toBe(false);
    expect(repos).toEqual([a, build, deep, join(base, 'srv', 'b.git'), join(base, 'wt')].sort());

    expect((await discoverRepos([base], { maxDepth: 4 })).repos).toContain(
      join(base, 'x/y/z/too-deep'),
    );
    const limited = await discoverRepos([base], { maxDirs: 2 });
    expect(limited.truncated).toBe(true);
    expect((await discoverRepos([base], { maxRepos: 1 })).repos).toHaveLength(1);
    // 根目錄本身就是 repo
    expect((await discoverRepos([a])).repos).toEqual([a]);
    // 不存在的根目錄、整個磁碟的根：略過
    expect((await discoverRepos([join(base, 'missing'), '/'])).repos).toEqual([]);
  });
});

describe('isSameOrigin', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers: { host: 'localhost:4200', ...headers } }) as never;
  it('validates complete Origin before fetch metadata and only permits requested direct reads', () => {
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }), false)).toBe(true);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'none' }), true)).toBe(true);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'none' }), false)).toBe(false);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-site' }), true)).toBe(false);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' }), true)).toBe(false);
    expect(isSameOrigin(req({ origin: 'http://localhost:4200' }), false)).toBe(true);
    expect(isSameOrigin(req({ origin: 'http://localhost:4201' }), true)).toBe(false);
    expect(
      isSameOrigin(
        req({ origin: 'https://localhost:4200', 'sec-fetch-site': 'same-origin' }),
        true,
      ),
    ).toBe(false);
    expect(
      isSameOrigin(req({ origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }), true),
    ).toBe(false);
    expect(isSameOrigin(req({ origin: 'http://fixture@localhost:4200' }), true)).toBe(false);
    expect(
      isSameOrigin(req({ host: 'localhost:4200/other', 'sec-fetch-site': 'same-origin' }), true),
    ).toBe(false);
    expect(
      isSameOrigin(
        {
          headers: { host: 'localhost:4200', origin: 'https://localhost:4200' },
          socket: { encrypted: true },
        } as never,
        false,
      ),
    ).toBe(true);
    expect(isSameOrigin(req({ origin: 'null' }), true)).toBe(false);
    expect(isSameOrigin(req({}), true)).toBe(true);
    expect(isSameOrigin(req({}), false)).toBe(false);
  });
});

describe('findGit', () => {
  it('only uses absolute PATH entries, so a git binary planted in the selected repo is never executed', async () => {
    const saved = process.env['PATH'];
    const real = findGit();
    expect(real && isAbsolute(real)).toBe(true);
    const repo = realpathSync(tmp('agg-planted-'));
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'one');
    const marker = join(repo, 'PWNED');
    writeFileSync(join(repo, 'git'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(repo, 'git'), 0o755);
    try {
      // 空字串與 `.` 在 POSIX 都代表 cwd（也就是被選到的 repo）
      process.env['PATH'] = ['', '.', 'relative/bin', dirname(real!)].join(delimiter);
      expect(findGit()).toBe(real);
      expect((await readGitSnapshot(repo)).graph!.commits).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
      process.env['PATH'] = ['', '.'].join(delimiter);
      expect(findGit()).toBeNull();
      const snap = await readGitSnapshot(repo);
      expect(snap.error).toBe('git is not installed');
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env['PATH'] = saved;
    }
    expect(findGit()).toBe(real);
  });
});

describe('defaultStateFile', () => {
  it('lives in the user state dir (never inside the project Vite serves), one file per project', () => {
    const saved = process.env['XDG_STATE_HOME'];
    process.env['XDG_STATE_HOME'] = '/state-home';
    try {
      const a = defaultStateFile('/work/app-a') as string;
      expect(a.startsWith('/state-home/adorable-git-graph/local-repos-')).toBe(
        process.platform !== 'win32',
      );
      expect(a).not.toContain('/work/app-a');
      expect(defaultStateFile('/work/app-b')).not.toBe(a);
      expect(defaultStateFile('/work/app-a/')).toBe(a);
      // 相對的 XDG_STATE_HOME 不算（會變成相對於 cwd = Vite 的 root）：退回家目錄底下
      process.env['XDG_STATE_HOME'] = '.local/state';
      const fallback = defaultStateFile('/work/app-a') as string;
      expect(isAbsolute(fallback)).toBe(true);
      expect(fallback.startsWith(homedir())).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = saved;
    }
  });
});

describe('snapshot error codes', () => {
  it('tags failures so the page can show a localised explanation', async () => {
    expect((await readGitSnapshot(join(tmpdir(), 'agg-definitely-missing'))).code).toBe(
      'missing_dir',
    );
    expect((await readGitSnapshot(tmp('agg-nogit-code-'))).code).toBe('not_git');
  });
});
