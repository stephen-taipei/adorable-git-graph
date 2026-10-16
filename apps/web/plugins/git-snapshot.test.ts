import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGitSnapshot, repoIdFor } from '@adorable/git-local';
import { gitSnapshot } from './git-snapshot.ts';

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

describe('gitSnapshot plugin (dev server behaviour)', () => {
  interface Sent {
    type: string;
    event: string;
    data: { repo: string; snapshot?: { graph: { commits: unknown[] } | null } };
  }
  interface Req {
    path?: string;
    headers?: Record<string, string>;
    method?: string;
    /** connect 會把掛載路徑拿掉，handler 看到的是剩下的部分（例如 `/?repo=abc`） */
    url?: string;
    body?: string;
    /** 連線的來源位址（預設是本機） */
    remote?: string;
  }

  async function startPlugin(
    repoDir: string,
    pollMs = 300,
    extra: {
      repoRoots?: string[];
      scanDepth?: number;
      stateFile?: string | false;
      idleMs?: number;
      maxCommits?: number;
    } = {},
  ) {
    return startWith(gitSnapshot({ repoDir, pollMs, stateFile: false, ...extra }), repoDir);
  }

  async function startWith(instance: ReturnType<typeof gitSnapshot>, repoDir: string) {
    const plugin = instance as unknown as {
      configResolved(c: unknown): void;
      configureServer(s: unknown): Promise<void>;
      load(id: string): Promise<string | undefined>;
    };
    const sent: Sent[] = [];
    type Handler = (req: unknown, res: unknown) => void;
    const handlers = new Map<string, Handler>();
    let invalidated = 0;
    const server = {
      middlewares: { use: (path: string, h: Handler) => handlers.set(path, h) },
      moduleGraph: { getModuleById: () => ({}), invalidateModule: () => invalidated++ },
      ws: { send: (m: Sent) => sent.push(m) },
      httpServer: null,
      close: async () => {},
    };
    const warnings: string[] = [];
    plugin.configResolved({ root: repoDir, logger: { warn: (m: string) => warnings.push(m) } });
    // gitSnapshot 在 vitest 下會刻意略過 configureServer；這裡要真的跑，所以暫時拿掉旗標
    const flag = process.env['VITEST'];
    delete process.env['VITEST'];
    try {
      await plugin.configureServer(server);
    } finally {
      process.env['VITEST'] = flag;
    }
    const call = ({
      path = '/__agg/git-snapshot',
      headers = {},
      method = 'GET',
      url = '/',
      body,
      remote = '127.0.0.1',
    }: Req = {}) =>
      new Promise<{ status: number; body: string; json: () => any }>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          once() {},
          end(text = '') {
            resolve({ status: this.statusCode, body: text, json: () => JSON.parse(text) });
          },
        };
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
          method,
          headers: { host: 'localhost:4200', ...headers },
          url,
          socket: { remoteAddress: remote },
        });
        handlers.get(path)!(req, res);
      });
    const request = (headers: Record<string, string> = {}, method = 'GET') =>
      call({ headers, method });
    const snapshotOf = (repo: string, headers: Record<string, string> = {}) =>
      call({ url: `/?repo=${encodeURIComponent(repo)}`, headers });
    const repos = (headers: Record<string, string> = {}) => call({ path: '/__agg/repos', headers });
    const addPath = (path: unknown, headers: Record<string, string> = {}) =>
      call({
        path: '/__agg/repos',
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ path }),
      });
    return {
      plugin,
      sent,
      warnings,
      call,
      request,
      snapshotOf,
      repos,
      addPath,
      invalidated: () => invalidated,
      close: () => server.close(),
    };
  }

  it('pushes an HMR update for each consecutive commit — through the WATCHER alone (poll disabled)', async () => {
    const dir = tmp('agg-plugin-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    // pollMs: 0 → 安全網關掉。若監看失靈，這個測試必須失敗（否則輪詢會把問題蓋住）
    const p = await startPlugin(dir, 0);
    try {
      for (let i = 2; i <= 5; i++) {
        commit(dir, `c${i}`);
        await waitFor(() => p.sent.length >= i - 1, 8000);
        expect(p.sent.at(-1)!.data.snapshot!.graph!.commits).toHaveLength(i);
      }
      expect(p.invalidated()).toBeGreaterThanOrEqual(4); // 重新整理頁面時要拿到新的 module，而不是舊快取
    } finally {
      await p.close();
    }
  });

  it('the 2s-style poll catches changes the watcher could miss (watchers cannot be the only path)', async () => {
    const dir = tmp('agg-poll-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 200);
    try {
      commit(dir, 'two');
      await waitFor(() => p.sent.length >= 1, 8000);
      expect(p.sent.at(-1)!.data.snapshot!.graph!.commits).toHaveLength(2);
    } finally {
      await p.close();
    }
  });

  it('serves the snapshot only to same-origin / direct requests', async () => {
    const dir = tmp('agg-endpoint-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir);
    try {
      const ok = await p.request({ 'sec-fetch-site': 'same-origin' });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).graph.commits).toHaveLength(1);
      expect((await p.request({})).status).toBe(200); // 沒有 fetch metadata（curl 等）
      expect((await p.request({ 'sec-fetch-site': 'none' })).status).toBe(200);
      expect((await p.request({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await p.request({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await p.request({}, 'POST')).status).toBe(405);
    } finally {
      await p.close();
    }
  });

  it('keeps the last good snapshot (and warns once) when git fails transiently', async () => {
    const dir = tmp('agg-keep-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 0);
    try {
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
      writeFileSync(join(dir, '.git/refs/heads/bad'), `${'1'.repeat(40)}\n`); // git 以 128 結束
      const during = JSON.parse((await p.request({})).body);
      expect(during.graph.commits).toHaveLength(1);
      expect(during.error).toBeUndefined();
      expect(p.warnings.filter((w) => /keeping the last good snapshot/.test(w))).toHaveLength(1);
      await p.request({});
      expect(p.warnings.filter((w) => /keeping the last good snapshot/.test(w))).toHaveLength(1);
      rmSync(join(dir, '.git/refs/heads/bad')); // 恢復後立刻回到正常
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
    } finally {
      await p.close();
    }
  });

  it('does NOT mask a permanent failure (repository gone) behind the stale snapshot', async () => {
    const dir = tmp('agg-gone-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 0);
    try {
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
      rmSync(join(dir, '.git'), { recursive: true, force: true });
      const body = JSON.parse((await p.request({})).body);
      expect(body.graph).toBeNull();
      expect(body.error).toMatch(/not inside a git repository/);
      expect(body.error).not.toContain(tmpdir());
      await waitFor(() => p.sent.some((m) => m.data.snapshot?.graph === null), 4000); // 也會推送給畫面
    } finally {
      await p.close();
    }
  });

  /** 一個放了幾個 repo 的資料夾：default 是 alpha，其他的是畫面上可以選的。 */
  function makeRoot() {
    const base = realpathSync(tmp('agg-roots-'));
    const repo = (rel: string, msgs: string[]) => {
      const dir = join(base, rel);
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      for (const m of msgs) commit(dir, m);
      return dir;
    };
    return {
      base,
      alpha: repo('alpha', ['a1', 'a2']),
      beta: repo('beta', ['b1', 'b2', 'b3']),
      gamma: repo('group/gamma', ['g1']),
    };
  }

  it('serves diagnostics only for loopback same-origin JSON and opaque repo ids', async () => {
    const p = await startPlugin(root);
    const post = (value: unknown, headers: Record<string, string> = {}, remote = '127.0.0.1') =>
      p.call({
        path: '/__agg/diagnostics',
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          ...headers,
        },
        remote,
        body: JSON.stringify(value),
      });
    try {
      const result = await post({ operation: 'compare', base: 'main', head: 'feat/x' });
      expect(result.status).toBe(200);
      expect(result.json().base.sha).toHaveLength(40);
      expect(result.body).not.toContain(root);
      expect(
        (
          await post(
            { operation: 'compare', base: 'main', head: 'main' },
            { 'sec-fetch-site': 'cross-site' },
          )
        ).status,
      ).toBe(403);
      expect(
        (await post({ operation: 'compare', base: 'main', head: 'main' }, {}, '192.0.2.4')).status,
      ).toBe(403);
      expect(
        (
          await post(
            { operation: 'compare', base: 'main', head: 'main' },
            { 'content-type': 'text/plain' },
          )
        ).status,
      ).toBe(415);
      expect((await post({ operation: 'compare', base: '--bad', head: 'main' })).status).toBe(400);
      expect(
        (await post({ operation: 'compare', base: 'main', head: 'main', repo: root })).status,
      ).toBe(400);
      expect((await post({ operation: 'changes', sha: 'main' })).status).toBe(400);
      expect(
        (await post({ operation: 'changes', sha: 'a'.repeat(40), commitRepo: 'fork/r' })).status,
      ).toBe(400);
      expect(
        (await post({ operation: 'compare', base: 'main', head: 'main', pad: 'x'.repeat(20000) }))
          .status,
      ).toBe(413);
    } finally {
      await p.close();
    }
  });

  it('lists the default repo first, then the sibling repos — by id, never asking the browser for a path', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0);
    try {
      const res = await p.repos({ 'sec-fetch-site': 'same-origin' });
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.truncated).toBe(false);
      expect(body.repos.map((x: { name: string }) => x.name)).toEqual(['alpha', 'beta', 'gamma']);
      expect(body.repos[0]).toMatchObject({ id: 'default', isDefault: true });
      expect(body.repos[1]).toMatchObject({ id: repoIdFor(r.beta), isDefault: false });
      expect(body.repos[1].id).toMatch(/^[0-9a-f]{12}$/);
      expect(body.repos[2].label).toContain('group');
    } finally {
      await p.close();
    }
  });

  it('serves any listed repo by id; unknown ids are 404 and malformed ones 400', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0);
    try {
      // 直接用 id（例如 dev server 重開後打開 `?local=<id>` 的網址）：還沒掃描過也要找得到
      const beta = await p.snapshotOf(repoIdFor(r.beta));
      expect(beta.status).toBe(200);
      expect(beta.json().graph.commits).toHaveLength(3);
      expect(beta.json().graph.repo.name).toBe('beta');
      expect((await p.snapshotOf('default')).json().graph.commits).toHaveLength(2);
      expect((await p.request()).json().graph.commits).toHaveLength(2); // 省略 repo = 預設
      expect((await p.snapshotOf('0123456789ab')).status).toBe(404);
      for (const bad of ['../etc', r.beta, 'ABCDEF012345', '0123456789abc', '']) {
        expect((await p.snapshotOf(bad)).status, bad).toBe(400);
      }
      expect(
        (await p.snapshotOf(repoIdFor(r.beta), { 'sec-fetch-site': 'cross-site' })).status,
      ).toBe(403);
      expect((await p.repos({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await p.repos({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await p.repos({ origin: 'http://localhost:9999' })).status).toBe(403);
      expect((await p.repos({ origin: 'http://localhost:4200' })).status).toBe(200);
      expect((await p.call({ path: '/__agg/repos', method: 'DELETE' })).status).toBe(405);
    } finally {
      await p.close();
    }
  });

  it('pushes live updates for a selected (non-default) repo, tagged with its id', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0);
    try {
      const id = repoIdFor(r.beta);
      expect((await p.snapshotOf(id)).status).toBe(200);
      commit(r.beta, 'b4');
      await waitFor(() => p.sent.some((m) => m.data.repo === id), 8000);
      // HMR 會廣播給所有連線（含 `vite --host` 時的區網裝置）：非預設 repo 只通知、不帶內容
      const last = p.sent.filter((m) => m.data.repo === id).at(-1)!;
      expect(last.data.snapshot).toBeUndefined();
      expect((await p.snapshotOf(id)).json().graph.commits).toHaveLength(4);
      // 預設 repo 的 virtual module 不受影響
      expect(p.sent.every((m) => m.data.repo === id)).toBe(true);
    } finally {
      await p.close();
    }
  });

  it('keeps at most 4 non-default repos watched, and re-watches an evicted one when it is selected again', async () => {
    const base = realpathSync(tmp('agg-lru-'));
    const dirs = ['r0', 'r1', 'r2', 'r3', 'r4', 'main'].map((name) => {
      const dir = join(base, name);
      mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main');
      commit(dir, `${name} one`);
      return dir;
    });
    const p = await startPlugin(dirs[5]!, 0);
    try {
      for (const dir of dirs.slice(0, 5)) {
        expect((await p.snapshotOf(repoIdFor(dir))).status).toBe(200);
      }
      const first = repoIdFor(dirs[0]!);
      const last = repoIdFor(dirs[4]!);
      commit(dirs[0]!, 'r0 two'); // r0 是最久沒用的：已經停止監看
      commit(dirs[4]!, 'r4 two');
      await waitFor(() => p.sent.some((m) => m.data.repo === last), 8000);
      await sleep(600);
      expect(p.sent.some((m) => m.data.repo === first)).toBe(false);
      // 再選一次：拿到最新內容，而且之後的 commit 又會即時推送
      expect((await p.snapshotOf(first)).json().graph.commits).toHaveLength(2);
      commit(dirs[0]!, 'r0 three');
      await waitFor(() => p.sent.some((m) => m.data.repo === first), 8000);
    } finally {
      await p.close();
    }
  });

  it('opens a typed absolute path (or ~ path) only for same-origin JSON requests', async () => {
    const r = makeRoot();
    const elsewhere = realpathSync(tmp('agg-elsewhere-'));
    const delta = join(elsewhere, 'delta');
    mkdirSync(join(delta, 'src'), { recursive: true });
    git(delta, 'init', '-q', '-b', 'main');
    commit(delta, 'd1');
    const p = await startPlugin(r.alpha, 0);
    try {
      // 子資料夾也可以：解析成 repo 的根
      const ok = await p.addPath(join(delta, 'src'));
      expect(ok.status).toBe(200);
      const repo = ok.json().repo;
      expect(repo).toMatchObject({ id: repoIdFor(delta), name: 'delta', isDefault: false });
      expect((await p.snapshotOf(repo.id)).json().graph.commits).toHaveLength(1);
      // 加入後也出現在清單裡
      const listed = (await p.repos()).json().repos.map((x: { id: string }) => x.id);
      expect(listed).toContain(repo.id);
      // 預設 repo 本身 → 回傳 default，不重複列出
      expect((await p.addPath(r.alpha)).json().repo.id).toBe('default');

      expect((await p.addPath('relative/path')).json().error).toBe('not_absolute');
      expect((await p.addPath(join(elsewhere, 'missing'))).json().error).toBe('not_found');
      expect((await p.addPath(elsewhere)).json().error).toBe('not_git');
      expect((await p.addPath(42)).json().error).toBe('invalid_path');
      expect((await p.addPath('/tmp/\0x')).status).toBe(400);
      expect((await p.addPath('x'.repeat(5000))).status).toBe(400);

      // CSRF：跨站、沒有來源資訊、來源不符、不是 JSON、太大 → 一律拒絕，而且不會被加進清單
      const before = (await p.repos()).json().repos.length;
      expect((await p.addPath(r.beta, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await p.addPath(r.beta, { 'sec-fetch-site': 'none' })).status).toBe(403);
      expect((await p.addPath(r.beta, { 'sec-fetch-site': '' })).status).toBe(403);
      expect(
        (await p.addPath(r.beta, { 'sec-fetch-site': '', origin: 'http://evil.example' })).status,
      ).toBe(403);
      expect(
        (await p.addPath(r.beta, { 'sec-fetch-site': '', origin: 'http://localhost:4200' })).status,
      ).toBe(200);
      expect((await p.addPath(r.beta, { 'content-type': 'text/plain' })).status).toBe(415);
      expect(
        (await p.addPath(r.beta, { 'content-type': 'application/x-www-form-urlencoded' })).status,
      ).toBe(415);
      const big = await p.call({
        path: '/__agg/repos',
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ path: r.beta, pad: 'x'.repeat(20_000) }),
      });
      expect(big.status).toBe(413);
      const garbage = await p.call({
        path: '/__agg/repos',
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(garbage.status).toBe(400);
      expect((await p.repos()).json().repos.length).toBe(before);
    } finally {
      await p.close();
    }
  });

  it('only answers this machine: LAN clients (vite --host) see the default repo but cannot list, add or read others', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0);
    try {
      const lan = '192.168.1.23';
      const id = repoIdFor(r.beta);
      expect((await p.call({ path: '/__agg/repos', remote: lan })).json().error).toBe('local_only');
      expect((await p.call({ path: '/__agg/repos', remote: lan })).status).toBe(403);
      const post = await p.call({
        path: '/__agg/repos',
        method: 'POST',
        remote: lan,
        headers: { origin: 'http://localhost:4200', 'content-type': 'application/json' },
        body: JSON.stringify({ path: r.beta }),
      });
      expect(post.status).toBe(403);
      expect((await p.call({ url: `/?repo=${id}`, remote: lan })).status).toBe(403);
      expect((await p.call({ url: '/?repo=default', remote: lan })).status).toBe(200);
      for (const local of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
        expect((await p.call({ url: `/?repo=${id}`, remote: local })).status, local).toBe(200);
      }
    } finally {
      await p.close();
    }
  });

  it('remembers typed paths in the state file across dev server restarts (not in the browser)', async () => {
    const r = makeRoot();
    const elsewhere = realpathSync(tmp('agg-state-'));
    const delta = join(elsewhere, 'delta');
    mkdirSync(delta);
    git(delta, 'init', '-q', '-b', 'main');
    commit(delta, 'd1');
    const stateFile = join(elsewhere, 'cache', 'local-repos.json');
    const first = await startPlugin(r.alpha, 0, { stateFile });
    try {
      expect((await first.addPath(delta)).status).toBe(200);
      await waitFor(() => existsSync(stateFile));
    } finally {
      await first.close();
    }
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ paths: [delta] });
    const second = await startPlugin(r.alpha, 0, { stateFile });
    try {
      const ids = (await second.repos()).json().repos.map((x: { id: string }) => x.id);
      expect(ids).toContain(repoIdFor(delta));
      expect((await second.snapshotOf(repoIdFor(delta))).json().graph.commits).toHaveLength(1);
    } finally {
      await second.close();
    }
    // 壞掉的檔案 / 不存在的路徑 / 相對路徑：略過，不影響啟動
    writeFileSync(stateFile, JSON.stringify({ paths: ['relative', join(elsewhere, 'gone'), 7] }));
    const third = await startPlugin(r.alpha, 0, { stateFile });
    try {
      expect((await third.repos()).json().repos.map((x: { name: string }) => x.name)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
    } finally {
      await third.close();
    }
  });

  it('rejects UNC / device paths (realpath would reach out to a network host on Windows)', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0);
    try {
      for (const unc of ['//attacker/share', '\\\\attacker\\share', '\\\\?\\C:\\x']) {
        expect((await p.addPath(unc)).status, unc).toBe(400);
      }
    } finally {
      await p.close();
    }
  });

  it('stops watching a non-default repo nobody asked for in a while, and picks it up again when asked', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0, { idleMs: 300 });
    try {
      const id = repoIdFor(r.beta);
      expect((await p.snapshotOf(id)).status).toBe(200);
      await sleep(1200); // 掃過一次以上：已經停止監看
      commit(r.beta, 'b4');
      await sleep(800);
      expect(p.sent.some((m) => m.data.repo === id)).toBe(false);
      expect((await p.snapshotOf(id)).json().graph.commits).toHaveLength(4);
    } finally {
      await p.close();
    }
  });

  it('typing a path inside a git directory resolves to the repository itself (no duplicate entries)', async () => {
    const r = makeRoot();
    const bare = join(r.base, 'srv', 'b.git');
    git(r.base, 'clone', '-q', '--bare', r.beta, bare);
    const p = await startPlugin(r.alpha, 0);
    try {
      expect((await p.addPath(join(r.alpha, '.git'))).json().repo.id).toBe('default');
      expect((await p.addPath(join(r.alpha, '.git', 'refs'))).json().repo.id).toBe('default');
      expect((await p.addPath(join(r.beta, '.git'))).json().repo).toMatchObject({
        id: repoIdFor(r.beta),
        name: 'beta',
      });
      expect((await p.addPath(join(bare, 'refs'))).json().repo).toMatchObject({
        id: repoIdFor(bare),
        name: 'b',
      });
      const names = (await p.repos()).json().repos.map((x: { name: string }) => x.name);
      expect(names).toEqual(['alpha', 'b', 'beta', 'gamma']);
    } finally {
      await p.close();
    }
  });

  it('paths inside a linked worktree or a separate git dir collapse to one entry', async () => {
    const r = makeRoot();
    const wt = join(r.base, 'beta-wt');
    git(r.beta, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    const sep = join(r.base, 'sep-store');
    const sepWork = join(r.base, 'sep-work');
    mkdirSync(sepWork);
    git(sepWork, 'init', '-q', '-b', 'main', '--separate-git-dir', sep);
    commit(sepWork, 's1');
    const p = await startPlugin(r.alpha, 0);
    try {
      const wtGitDir = join(r.beta, '.git', 'worktrees', 'beta-wt');
      expect((await p.addPath(wtGitDir)).json().repo).toMatchObject({ id: repoIdFor(wt) });
      expect((await p.addPath(join(wtGitDir, 'logs'))).json().repo.id).toBe(repoIdFor(wt));
      const a = (await p.addPath(join(sep, 'refs'))).json().repo.id;
      expect((await p.addPath(join(sep, 'refs', 'heads'))).json().repo.id).toBe(a);
      expect((await p.addPath(sep)).json().repo.id).toBe(a);
    } finally {
      await p.close();
    }
  });

  it('a worktree of a bare repo maps back to the worktree (not the admin dir)', async () => {
    const r = makeRoot();
    const bare = join(r.base, 'hub.git');
    git(r.base, 'clone', '-q', '--bare', r.beta, bare);
    const wt = join(r.base, 'hub-wt');
    git(bare, 'worktree', 'add', '-q', wt, '-b', 'from-bare');
    const p = await startPlugin(r.alpha, 0);
    try {
      const admin = join(bare, 'worktrees', 'hub-wt');
      expect((await p.addPath(admin)).json().repo).toMatchObject({
        id: repoIdFor(wt),
        name: 'hub-wt',
      });
      expect((await p.addPath(join(bare, 'refs'))).json().repo.id).toBe(repoIdFor(bare));
    } finally {
      await p.close();
    }
  });

  it('keeps the user GIT_CEILING_DIRECTORIES (a folder under a ceiling is not swallowed by a repo above it)', async () => {
    const r = makeRoot();
    const inner = join(r.alpha, 'not-a-repo');
    mkdirSync(inner);
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = r.alpha;
    try {
      expect((await readGitSnapshot(inner)).code).toBe('not_git');
    } finally {
      if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
      else process.env['GIT_CEILING_DIRECTORIES'] = saved;
    }
  });

  it('starts watching once a repo that could not be opened becomes readable (e.g. after git init / safe.directory)', async () => {
    const r = makeRoot();
    const later = join(r.base, 'later');
    mkdirSync(join(later, '.git'), { recursive: true }); // 掃描看得到（有 .git），但還不是 repo
    const p = await startPlugin(r.alpha, 0);
    try {
      const id = repoIdFor(later);
      expect((await p.snapshotOf(id)).json().code).toBe('not_git');
      rmSync(join(later, '.git'), { recursive: true, force: true });
      git(later, 'init', '-q', '-b', 'main');
      commit(later, 'l1');
      expect((await p.snapshotOf(id)).json().graph.commits).toHaveLength(1);
      await sleep(300); // 監看是在背景裝上的
      commit(later, 'l2');
      await waitFor(() => p.sent.some((m) => m.data.repo === id), 8000);
    } finally {
      await p.close();
    }
  });

  it('ignores an inherited GIT_DIR / GIT_WORK_TREE (each repo is read from its own folder)', async () => {
    const r = makeRoot();
    const saved = { dir: process.env['GIT_DIR'], tree: process.env['GIT_WORK_TREE'] };
    process.env['GIT_DIR'] = join(r.gamma, '.git');
    process.env['GIT_WORK_TREE'] = r.gamma;
    try {
      expect((await readGitSnapshot(r.beta)).graph!.commits).toHaveLength(3);
      expect((await readGitSnapshot(r.alpha)).graph!.commits).toHaveLength(2);
    } finally {
      if (saved.dir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved.dir;
      if (saved.tree === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = saved.tree;
    }
  });

  it('AGG_DEFAULT_BRANCH / defaultBranch only applies to the default repo', async () => {
    const r = makeRoot();
    git(r.beta, 'branch', 'develop');
    git(r.alpha, 'branch', 'develop');
    const plugin = gitSnapshot({
      repoDir: r.alpha,
      pollMs: 0,
      stateFile: false,
      defaultBranch: 'develop',
    });
    const q = await startWith(plugin, r.alpha);
    try {
      const def = (await q.snapshotOf('default')).json().graph;
      expect(def.refs.find((x: { isDefault?: boolean }) => x.isDefault).name).toBe('develop');
      const beta = (await q.snapshotOf(repoIdFor(r.beta))).json().graph;
      expect(beta.refs.find((x: { isDefault?: boolean }) => x.isDefault).name).toBe('main');
    } finally {
      await q.close();
    }
  });

  it('the same plugin instance configured twice (server.restart) keeps pushing after the old server closes', async () => {
    const dir = tmp('agg-restart-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const plugin = gitSnapshot({ repoDir: dir, pollMs: 0, stateFile: false });
    const first = await startWith(plugin, dir);
    const second = await startWith(plugin, dir);
    await first.close(); // 舊 server 的 cleanup 不能停掉新 server 的監看
    try {
      commit(dir, 'two');
      await waitFor(
        () => second.sent.some((m) => m.data.snapshot?.graph?.commits.length === 2),
        8000,
      );
      expect(first.sent.some((m) => m.data.snapshot?.graph?.commits.length === 2)).toBe(false);
    } finally {
      await second.close();
    }
  });

  it('scans the configured roots (repoRoots) instead of the default repo siblings', async () => {
    const r = makeRoot();
    const other = realpathSync(tmp('agg-other-root-'));
    const zeta = join(other, 'zeta');
    mkdirSync(zeta);
    git(zeta, 'init', '-q', '-b', 'main');
    commit(zeta, 'z1');
    const p = await startPlugin(r.alpha, 0, { repoRoots: [other] });
    try {
      const names = (await p.repos()).json().repos.map((x: { name: string }) => x.name);
      expect(names).toEqual(['alpha', 'zeta']);
      expect((await p.snapshotOf(repoIdFor(r.beta))).status).toBe(404); // 不在範圍內
    } finally {
      await p.close();
    }
  });

  it(
    'depth: loads older history on request, keeps it for later reads, HMR pushes and the virtual module, rejects malformed values',
    { timeout: 30_000 },
    async () => {
      const dir = realpathSync(tmp('agg-depth-'));
      git(dir, 'init', '-q', '-b', 'main');
      for (let i = 0; i < 20; i++) commit(dir, `c${i}`);
      const p = await startPlugin(dir, 0, { repoRoots: [dir], maxCommits: 5 });
      const graphAt = async (url: string) => {
        const res = await p.call({ url });
        expect(res.status, url).toBe(200);
        return res.json().graph as { commits: Array<{ message: string }>; truncated: boolean };
      };
      try {
        const first = await graphAt('/');
        expect(first.commits).toHaveLength(5);
        expect(first.truncated).toBe(true);
        const deeper = await graphAt('/?repo=default&depth=12');
        expect(deeper.commits).toHaveLength(12);
        expect(deeper.truncated).toBe(true);
        expect((await graphAt('/')).commits).toHaveLength(12); // 之後沒帶 depth 也維持
        expect((await graphAt('/?depth=3')).commits).toHaveLength(12); // 只增不減
        expect((await graphAt('/?depth=0')).commits).toHaveLength(12); // 夾到 1
        // 新 commit 的 HMR 推送也是 12 筆（最新的一定在裡面）
        commit(dir, 'c20');
        const pushed = () =>
          p.sent.find((m) =>
            (m.data.snapshot?.graph?.commits as Array<{ message: string }> | undefined)?.some(
              (c) => c.message === 'c20',
            ),
          );
        await waitFor(() => pushed() !== undefined, 8000);
        expect(pushed()!.data.snapshot!.graph!.commits).toHaveLength(12);
        // 重新整理頁面拿到的 virtual module 也是
        const mod = (await p.plugin.load('\0virtual:git-snapshot'))!;
        expect(
          JSON.parse(mod.replace(/^export default /, '').replace(/;$/, '')).graph.commits,
        ).toHaveLength(12);
        // 上限是 MAX_DEPTH（5000）：超過的數字夾到上限
        const all = await graphAt('/?depth=99999999999');
        expect(all.commits).toHaveLength(21);
        expect(all.truncated).toBe(false);
        for (const bad of ['abc', '-1', '1.5', '', '1e3', '%205', '0x10', '1'.repeat(40)]) {
          const res = await p.call({ url: `/?depth=${bad}` });
          expect([res.status, res.json().error], bad).toEqual([400, 'invalid_depth']);
        }
      } finally {
        await p.close();
      }
    },
  );

  it('depth is kept per repository (LAN clients may page the default repo, never the others)', async () => {
    const r = makeRoot();
    const p = await startPlugin(r.alpha, 0, { maxCommits: 1 });
    try {
      const beta = repoIdFor(r.beta);
      expect((await p.snapshotOf(beta)).json().graph.commits).toHaveLength(1);
      expect((await p.call({ url: `/?repo=${beta}&depth=2` })).json().graph.commits).toHaveLength(
        2,
      );
      expect((await p.snapshotOf(beta)).json().graph.commits).toHaveLength(2);
      expect((await p.request()).json().graph.commits).toHaveLength(1); // 預設 repo 不受影響
      const lan = '192.168.1.23';
      expect((await p.call({ url: '/?depth=2', remote: lan })).json().graph.commits).toHaveLength(
        2,
      );
      expect((await p.call({ url: `/?repo=${beta}&depth=3`, remote: lan })).status).toBe(403);
    } finally {
      await p.close();
    }
  });
});
