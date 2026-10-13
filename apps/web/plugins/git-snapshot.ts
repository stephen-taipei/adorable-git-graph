import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync, statSync, watch } from 'node:fs';
import type { Dirent, FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import {
  GIT_LOG_FORMAT,
  GIT_REF_FORMAT,
  buildGitGraphData,
  parseGitLog,
  parseForEachRef,
  selectRefs,
  coverage,
  isDiagnosticRequest,
} from '@adorable/graph-core';
import { createLocalDiagnostics } from './diagnostics.ts';
import {
  DEFAULT_REPO,
  HMR_EVENT,
  REPOS_ENDPOINT,
  SNAPSHOT_ENDPOINT,
  DIAGNOSTICS_ENDPOINT,
  MAX_DEPTH,
  isRepoId,
  snapshotKey,
} from '../src/protocol.ts';
import type {
  GitSnapshot,
  LocalRepo,
  ReposResponse,
  SnapshotErrorCode,
  SnapshotEvent,
} from '../src/protocol.ts';

export type { GitSnapshot };
export { snapshotKey };

const execFileAsync = promisify(execFile);

export interface SnapshotOptions {
  /** 預設：環境變數 AGG_REPO_DIR，否則為執行 vite 的目錄（git 會自動往上找 repo 根）。 */
  repoDir?: string;
  /** 最多讀幾筆 commit。預設 300（環境變數 AGG_MAX_COMMITS）。 */
  maxCommits?: number;
  /** 最多畫幾條 branch。預設 8（環境變數 AGG_MAX_BRANCHES）。 */
  maxBranches?: number;
  /** 明確指定 default branch（環境變數 AGG_DEFAULT_BRANCH）。 */
  defaultBranch?: string;
  /** 安全網：每隔幾毫秒比對一次 ref 清單（0 = 關閉）。預設 2000。 */
  pollMs?: number;
  /** 細節（可能含本機路徑）只往這裡送，絕不放進快照。 */
  onWarn?: (message: string) => void;
  /**
   * dev 時畫面上「選擇本機 repo」清單要掃描的資料夾。
   * 預設：環境變數 AGG_REPO_ROOTS（以 `path.delimiter` 分隔，可用 `~`），否則為預設 repo 的上一層（也就是它的兄弟資料夾）。
   */
  repoRoots?: string[];
  /** 從每個根目錄往下找幾層。預設 3（環境變數 AGG_REPO_SCAN_DEPTH）。 */
  scanDepth?: number;
  /**
   * 記住「開啟其他路徑…」加入的 repo 的檔案（dev server 重新啟動後清單裡還在）。`false` = 不記。
   * 預設：環境變數 AGG_LOCAL_REPOS_FILE，否則放在使用者的 state 目錄（Vite 不會提供的地方）：
   * `$XDG_STATE_HOME`（預設 `~/.local/state`）或 Windows 的 `%LOCALAPPDATA%` 底下的
   * `adorable-git-graph/local-repos-<這個專案路徑的雜湊>.json`。
   */
  stateFile?: string | false;
  /** 非預設 repo 多久沒有人要快照就停止監看。預設 10 分鐘（主要是給測試調短用）。 */
  idleMs?: number;
}

/**
 * 預設的 state 檔位置。不能放在專案裡（例如 node_modules/.cache）：那在 Vite 的 root / fs.allow 底下，
 * `vite --host` 時區網裡的裝置可以直接把它當靜態檔案讀走。
 */
export function defaultStateFile(root: string, key?: string): string | false {
  // 相對路徑一律不算（XDG 規範也這麼要求）：會變成相對於 cwd，也就是 Vite 的 root
  const abs = (p: string | undefined) => (p && isAbsolute(p) ? p : undefined);
  const home = abs(homedir());
  const base =
    process.platform === 'win32'
      ? (abs(process.env['LOCALAPPDATA']) ?? (home && join(home, 'AppData', 'Local')))
      : (abs(process.env['XDG_STATE_HOME']) ?? (home && join(home, '.local', 'state')));
  if (!base) return false; // 沒有安全的位置：不記
  // `key`：不依附某個專案路徑的使用者（npm CLI 每個版本裝在不同的 npx 快取目錄，但清單應該延續）
  const project = key ?? createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  return join(base, 'adorable-git-graph', `local-repos-${project}.json`);
}

const intFromEnv = (name: string): number | undefined => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 預設最多讀幾筆 commit（畫面捲到底時可以再要更多，見 RepoSession.want）。 */
const defaultMaxCommits = (opts: SnapshotOptions): number =>
  opts.maxCommits ?? intFromEnv('AGG_MAX_COMMITS') ?? 300;

let gitBinary: { path: string | undefined; bin: string | null } | undefined;

/**
 * git 執行檔的絕對路徑（只在 PATH 的絕對路徑項目裡找）。
 * 不能直接執行 `'git'`：cwd 是使用者選的 repo，Windows 的 libuv 會先在 cwd 找 `git.exe`，
 * POSIX 的 PATH 若含空字串或相對路徑也會在 cwd 找——選到一個放了 git 執行檔的 repo 就會執行它。
 */
export function findGit(): string | null {
  const path = process.env['PATH'];
  if (gitBinary && gitBinary.path === path) return gitBinary.bin;
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  let bin: string | null = null;
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      // resolve：Windows 的 `\\bin` 這種只有根目錄的項目也算 isAbsolute，執行時卻會依 cwd 的磁碟機解析
      bin = resolve(file);
      break;
    } catch {
      /* 不在這裡 */
    }
  }
  gitBinary = { path, bin };
  return bin;
}

/**
 * 指向「某一個 repo」的變數（git 自己的清單：`git rev-parse --local-env-vars`）：dev server 若繼承了它們
 * （從 git hook 啟動、shell 為 dotfiles 匯出 GIT_DIR…），選單裡每個 repo 都會變成同一個。
 * GIT_CEILING_DIRECTORIES 之類限制「往上找」的設定是使用者刻意的，保留。
 */
const REPO_LOCATING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
];

function gitEnv(): NodeJS.ProcessEnv {
  // 唯讀操作也避免 index 鎖，LC_ALL 讓輸出格式（含錯誤訊息）穩定
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  for (const name of REPO_LOCATING_ENV) delete env[name];
  return env;
}

const diagnosticGitSupport = new Map<string, Promise<boolean>>();
/** Missing promisor objects must never cause implicit downloads or write refs/index. */
export async function runDiagnosticGit(
  repoDir: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const bin = findGit();
  if (!bin) throw new Error('git_unavailable');
  const env = gitEnv();
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG(?:_|$)/.test(key) || /^GIT_(?:GLOB|NOGLOB|ICASE)_PATHSPECS$/.test(key))
      delete env[key];
  }
  let supported = diagnosticGitSupport.get(bin);
  if (!supported) {
    supported = execFileAsync(bin, ['--no-lazy-fetch', '--version'], { env, timeout: 5000 }).then(
      () => true,
      () => false,
    );
    diagnosticGitSupport.set(bin, supported);
  }
  if (!(await supported)) throw new Error('safe_git_unavailable');
  try {
    const pending = execFileAsync(
      bin,
      [
        '--no-pager',
        '--no-lazy-fetch',
        '--no-replace-objects',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'log.showSignature=false',
        '-c',
        'color.ui=false',
        '-C',
        repoDir,
        ...args,
      ],
      { env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal },
    );
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout;
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const code = (err as { code?: unknown }).code;
    throw Object.assign(new Error('git_query_failed'), {
      code: typeof code === 'number' ? code : undefined,
    });
  }
}

/** 不經 shell（execFile），參數全是我們組出來的 ref 名稱，不會被當成選項。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const bin = findGit();
  if (!bin) throw Object.assign(new Error('git is not installed'), { code: 'ENOENT' });
  // `-C` 而不是 spawn 的 cwd：spawn 會等子行程 chdir 完才回來，目錄在卡住的網路磁碟上時整個 dev server 會跟著停住；
  // 交給 git 自己 chdir，卡住的只有那個子行程（60 秒後被砍掉）
  let supported = diagnosticGitSupport.get(bin);
  if (!supported) {
    supported = execFileAsync(bin, ['--no-lazy-fetch', '--version'], {
      env: gitEnv(),
      timeout: 5000,
    }).then(
      () => true,
      () => false,
    );
    diagnosticGitSupport.set(bin, supported);
  }
  if (!(await supported)) throw new Error('safe_git_unavailable');
  const { stdout } = await execFileAsync(
    bin,
    [
      '--no-pager',
      '--no-lazy-fetch',
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'log.showSignature=false',
      '-C',
      cwd,
      ...args,
    ],
    {
      maxBuffer: 256 * 1024 * 1024,
      // 網路磁碟卡住等：不要讓 git 子行程與等待中的請求永遠掛著
      timeout: 60_000,
      env: gitEnv(),
    },
  );
  return stdout;
}

const gitOrUndefined = (cwd: string, args: string[]) =>
  git(cwd, args).then(
    (s) => s.trim() || undefined,
    () => undefined,
  );

class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(message: string, code: SnapshotErrorCode) {
    super(message);
    this.code = code;
  }
}

/** repo 的位置（工作樹的根；bare repo 則是 git 目錄本身）與顯示名稱。 */
async function resolveRepo(repoDir: string): Promise<{ dir: string; name: string }> {
  try {
    const top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim();
    return { dir: top, name: basename(top) };
  } catch (err) {
    // ENOENT 也可能是 cwd 剛好不見了：只有真的找不到 git 才說沒安裝
    if (findGit() === null) throw new SnapshotError('git is not installed', 'no_git');
    // git ≥ 2.35.2 拒絕別的使用者擁有的 repo（外接硬碟、WSL / Docker 掛載…）。不要自己加 safe.directory：那是在防 repo 裡的設定
    if (/detected dubious ownership/.test(String((err as { stderr?: unknown }).stderr ?? '')))
      throw new SnapshotError(
        'Git refused to open this repository because it is owned by another user (see git config safe.directory).',
        'unsafe_repo',
      );
  }
  const gitDir = await gitOrUndefined(repoDir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir)
    throw new SnapshotError('The configured directory is not inside a git repository.', 'not_git');
  // bare：.../project.git；在 .git 內：.../project/.git
  const named = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  const name = basename(named).replace(/\.git$/, '') || 'repository';
  // linked worktree 的 git 目錄（<main>/.git/worktrees/<wt>、<bare>.git/worktrees/<wt>）：gitdir 檔記著工作樹的 .git。
  // 要在 bare 判斷之前：main 是 bare repo 時，共用設定的 core.bare=true 會讓這裡也被當成 bare
  const [linked, common] = await Promise.all(
    ['gitdir', 'commondir'].map((file) =>
      readFile(join(gitDir, file), 'utf8').then(
        (s) => s.trim(),
        () => '',
      ),
    ),
  );
  if (linked && common) {
    const top = await gitOrUndefined(dirname(resolve(gitDir, linked)), [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (top) return { dir: top, name: basename(top) };
  }
  // 指到 git 目錄裡面（<repo>/.git、<bare>.git/refs…）時回傳 repo 本身的位置：清單與 id 才不會重複
  const bare = (await gitOrUndefined(repoDir, ['rev-parse', '--is-bare-repository'])) === 'true';
  if (bare) return { dir: gitDir, name };
  if (basename(gitDir) === '.git') {
    const top = await gitOrUndefined(dirname(gitDir), ['rev-parse', '--show-toplevel']);
    if (top) return { dir: top, name: basename(top) };
  }
  // 其他非 bare 的 git 目錄（--separate-git-dir 等）：用 git 目錄本身，裡面任何路徑都收斂成同一筆
  return { dir: gitDir, name };
}

export async function readGitSnapshot(
  repoDir: string,
  opts: SnapshotOptions = {},
): Promise<GitSnapshot> {
  const generatedAt = Date.now();
  // 錯誤訊息會被烤進 bundle / 經由 endpoint 送出，所以一律不含本機路徑；細節給 onWarn（終端機）。
  // transient：git 自己出錯（gc / fetch 進行中等），保留上一張好的圖；其餘是確定的失敗，要如實顯示。
  const fail = (error: string, code: SnapshotErrorCode, transient = false): GitSnapshot => ({
    graph: null,
    error,
    code,
    generatedAt,
    ...(transient ? { transient: true } : {}),
  });
  // 非同步且有時限：使用者選的路徑可能在卡住的網路磁碟上
  const probe = stalledDirs.has(repoDir)
    ? 'timeout'
    : await within(repoDir, stat(repoDir), STALL_MS).then(
        (r) => (r === 'timeout' ? 'timeout' : 'ok'),
        (err: { code?: string }) =>
          err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'ok',
      );
  if (probe === 'missing')
    return fail('The configured repository directory does not exist.', 'missing_dir');
  if (probe === 'timeout')
    return fail('The repository folder is not responding (a network drive?).', 'git_error', true);

  try {
    const { dir, name } = await resolveRepo(repoDir);
    const maxCommits = defaultMaxCommits(opts);
    const maxBranches = opts.maxBranches ?? intFromEnv('AGG_MAX_BRANCHES') ?? 8;

    const [refsText, originHead, currentBranch, remoteUrl, shallow] = await Promise.all([
      git(dir, [
        'for-each-ref',
        '--sort=-committerdate',
        `--format=${GIT_REF_FORMAT}`,
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ]),
      gitOrUndefined(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
      gitOrUndefined(dir, ['branch', '--show-current']),
      gitOrUndefined(dir, ['config', '--get', 'remote.origin.url']),
      gitOrUndefined(dir, ['rev-parse', '--is-shallow-repository']),
    ]);

    const allRefs = parseForEachRef(refsText);
    const selected = selectRefs(allRefs, {
      defaultBranch: opts.defaultBranch ?? process.env['AGG_DEFAULT_BRANCH'],
      originHead,
      currentBranch,
      maxBranches,
    });

    // branch 一個都沒有（CI 的 detached HEAD 等）時改從 HEAD 往回走
    const detachedTip = selected.logRefs.length
      ? undefined
      : await gitOrUndefined(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const logRefs = selected.logRefs.length ? selected.logRefs : detachedTip ? [detachedTip] : [];

    // 先把選好的 ref 解析成 sha，再交給 git log：避免讀取途中 ref 移動造成「branch 標籤落後最新 commit」的不一致快照
    const tips = selected.refs.length ? [...new Set(selected.refs.map((r) => r.sha))] : logRefs;
    const logArgs = (n: number, starts: string[]) => [
      // 使用者的 git 設定不能影響輸出：log.showSignature 會在每筆前塞 gpg 輸出，
      // i18n.logOutputEncoding 非 UTF-8 時作者名與標題會變成亂碼
      '-c',
      'log.showSignature=false',
      '-c',
      'i18n.logOutputEncoding=UTF-8',
      'log',
      '-z',
      '--no-show-signature',
      '--date-order',
      `--format=${GIT_LOG_FORMAT}`,
      '-n',
      String(n),
      ...starts,
      '--',
    ];
    let logText = tips.length ? await git(dir, logArgs(maxCommits, tips)) : '';
    // 其他 branch 很活躍時，default / 目前 branch 的 tip 可能比「最新 N 筆」還舊而整個被擠掉
    // （圖上就沒有 default 的小球與皇冠）：保證它們一定讀得到。
    // 讀到的一律是 `--date-order` 的前 N 筆（往更早的歷史多讀時只會接在後面，不會插進已經顯示的列中間）：
    // tip 不在裡面就把 N 加大到包含它；只有比 MAX_DEPTH 還深時才另外補上它最近的一段（不再是前綴）。
    const guaranteed = [
      ...new Set(
        selected.refs.filter((r) => r.isDefault || r.name === currentBranch).map((r) => r.sha),
      ),
    ];
    if (logText && guaranteed.length) {
      const loaded = new Set(parseGitLog(logText).map((c) => c.sha));
      const missing = guaranteed.filter((sha) => !loaded.has(sha));
      if (missing.length) {
        const order = (
          await git(dir, ['rev-list', '--date-order', '-n', String(MAX_DEPTH), ...tips, '--'])
        )
          .split('\n')
          .filter(Boolean);
        const position = new Map(order.map((sha, i) => [sha, i]));
        const deepest = Math.max(-1, ...missing.map((sha) => position.get(sha) ?? -1));
        if (deepest + 1 > maxCommits) logText = await git(dir, logArgs(deepest + 1, tips));
        // `git log -n` 把多個起點合起來算，所以要每個起點分開讀
        for (const sha of missing) {
          if (!position.has(sha))
            logText += await git(dir, logArgs(Math.min(maxCommits, 60), [sha]));
        }
      }
    }

    const graph = buildGitGraphData({
      logText,
      selected,
      allRefs,
      remoteUrl,
      fallbackName: name,
      currentBranch,
    });
    // shallow clone 的邊界 commit 看起來像 root：至少要讓畫面標示「更早的歷史已省略」
    if (shallow === 'true') graph.truncated = true;
    const branchTotal = allRefs.filter((r) => r.kind === 'branch').length;
    const branchLoaded = graph.refs.filter((r) => r.kind === 'branch').length;
    const omittedRefs = graph.refs.length < allRefs.length;
    graph.coverage = {
      source: 'local',
      observedAt: generatedAt,
      remoteRefsAreLocal: true,
      refs: coverage(
        omittedRefs ? 'partial' : 'complete',
        omittedRefs ? ['ref_selection'] : [],
        branchLoaded,
        branchTotal,
      ),
      commits: coverage(
        graph.truncated ? 'partial' : 'complete',
        [
          ...(shallow === 'true' ? ['shallow'] : []),
          ...(graph.truncated && shallow !== 'true' ? ['history_limit'] : []),
        ],
        graph.commits.length,
      ),
    };
    return { graph, generatedAt };
  } catch (err) {
    if (err instanceof SnapshotError) return fail(err.message, err.code);
    opts.onWarn?.(
      `could not read git history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail('Could not read the git history (git reported an error).', 'git_error', true);
  }
}

/** ref 清單 + HEAD 的簽章：很便宜，用來偵測「有沒有變」。 */
async function refsSignature(repoDir: string): Promise<string> {
  const [refs, head, sym] = await Promise.all([
    gitOrUndefined(repoDir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    gitOrUndefined(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    gitOrUndefined(repoDir, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  return `${refs ?? ''}\n${head ?? ''}\n${sym ?? ''}`;
}

/**
 * 監看 git 目錄中會影響圖的檔案（HEAD、packed-refs、refs/**）。
 *
 * 不用 `fs.watch(..., { recursive: true })`：git 以「寫 .lock 再 rename 蓋掉原檔」更新 ref，
 * Node 在 Linux 的遞迴實作是逐 inode 監看，被蓋掉的檔案之後就不再通知，第二次 commit 起就收不到事件。
 * 監看「目錄」則能看到 rename 進來的新檔，所以改成逐層非遞迴監看目錄，遇到新目錄就補上。
 */
export function watchGitRefs(
  gitDirs: string[],
  onChange: () => void,
  /** 最多監看幾個目錄（inotify 是全使用者共用的額度）；超過的交給輪詢安全網。 */
  maxDirs = 512,
): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const drop = (dir: string) => {
    watchers.get(dir)?.close();
    watchers.delete(dir);
  };

  /** `replace`：同名目錄可能被刪掉又重建（git gc / pack-refs / branch 刪除重建）。核心會悄悄丟掉舊 inode 的監看，所以要換新的。 */
  const add = (
    dir: string,
    handler: (event: string, filename: string | null) => void,
    replace = false,
  ) => {
    if (closed) return;
    if (watchers.has(dir)) {
      if (!replace) return;
      drop(dir);
    }
    if (watchers.size >= maxDirs) return;
    try {
      const w = watch(dir, { persistent: false }, (event, filename) =>
        handler(event, filename ? String(filename) : null),
      );
      w.on('error', () => drop(dir));
      watchers.set(dir, w);
    } catch {
      /* 目錄消失 / 達到 inotify 上限：交給輪詢安全網 */
    }
  };

  const watchTree = (dir: string, replace = false, root = false) => {
    // 只走真的目錄：git 不會在 refs 底下建 symlink，跟著連結走可能把整個磁碟同步讀一遍（輪詢會補上其餘的變化）。
    // 例外是 <gitDir>/refs 本身（git-new-workdir 之類的佈局會把它做成 symlink），它底下的仍然不跟。
    try {
      if (!(root ? statSync : lstatSync)(dir).isDirectory()) return;
    } catch {
      return;
    }
    add(
      dir,
      (event, filename) => {
        if (filename) {
          const child = join(dir, filename);
          try {
            if (lstatSync(child).isDirectory()) watchTree(child, event === 'rename');
          } catch {
            drop(child); // 已被刪除：放掉舊的監看，之後重建時才會重新加上
          }
        }
        onChange();
      },
      replace,
    );
    // 超過上限（或監看失敗）就不再往下走
    if (!watchers.has(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchTree(join(dir, entry.name), replace);
      }
    } catch {
      /* ignore */
    }
  };

  for (const gitDir of gitDirs) {
    add(gitDir, (_event, filename) => {
      if (filename === null || filename === 'HEAD' || filename === 'packed-refs') onChange();
      if (filename === 'refs') watchTree(join(gitDir, 'refs'), true, true);
    });
    watchTree(join(gitDir, 'refs'), false, true);
  }

  return () => {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

// ───────────────────────── 本機 repo 清單（dev server 的 repo 選擇器） ─────────────────────────

/** 不往裡面找的資料夾：套件 / 建置產物 / 系統目錄（另外所有 `.` 開頭的資料夾也都略過）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'tmp',
  'temp',
  'Library',
  'AppData',
  'Applications',
  'System',
  'Windows',
  'proc',
  'sys',
  'dev',
  'snap',
]);

export interface DiscoverOptions {
  /** 從根目錄往下找幾層（根目錄本身是第 0 層）。預設 3。 */
  maxDepth?: number;
  /** 最多讀幾個資料夾。預設 5000。 */
  maxDirs?: number;
  /** 最多回報幾個 repo。預設 300。 */
  maxRepos?: number;
  /** 掃描的時間上限（毫秒）。預設 3000。 */
  timeBudgetMs?: number;
}

/**
 * 卡住的目錄（掛掉的網路磁碟等）：之後的掃描直接略過，等它哪天回應了才恢復。
 * 卡住的 fs 呼叫會一直佔著一條 libuv 執行緒（預設只有 4 條，Vite 讀檔也靠它們），所以同時最多容忍 MAX_STALLED 個，
 * 超過就不再冒險開新的 readdir（這次掃描到此為止，清單沿用上一次的結果）。
 */
const stalledDirs = new Set<string>();
const STALL_MS = 1000;
const MAX_STALLED = 2;

/** 最多等 `ms`：網路磁碟卡住時 fs 呼叫可能永遠不回來，不能讓整個掃描（和等它的請求）跟著卡住。 */
async function within<T>(key: string, op: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((ok) => {
    timer = setTimeout(ok, Math.max(0, ms), 'timeout');
  });
  try {
    const result = await Promise.race([op, timeout]);
    if (result === 'timeout') {
      stalledDirs.add(key);
      op.then(
        () => stalledDirs.delete(key),
        () => stalledDirs.delete(key),
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const isBareRepo = (entries: Dirent[]) => {
  const has = (name: string, dir: boolean) =>
    entries.some((e) => e.name === name && (dir ? e.isDirectory() : e.isFile()));
  return has('HEAD', false) && has('objects', true) && has('refs', true);
};

/**
 * 找出 roots 底下的 git repository（一般 repo、worktree、`*.git` 的 bare repo）。
 * 只看資料夾裡有沒有 `.git`：不執行 git（不會碰到陌生 repo 的設定）、不跟隨 symlink、不往 repo 裡面找（submodule 等）。
 * 所有 fs 呼叫都是非同步且有時限的（不會卡住 dev server）。回傳排序過的 realpath；碰到上限就停下並標記 truncated。
 */
export async function discoverRepos(
  roots: string[],
  opts: DiscoverOptions = {},
): Promise<{ repos: string[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 5000;
  const maxRepos = opts.maxRepos ?? 300;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 3000);
  let truncated = false;
  /** 還能不能再發一個可能卡住的 fs 呼叫；不行就停在這裡 */
  const budget = (): number => {
    const left = Math.min(STALL_MS, deadline - Date.now());
    return left > 0 && stalledDirs.size < MAX_STALLED ? left : 0;
  };
  /** `listOnly`：只看它本身是不是 repo，不往裡面找（名字叫 build / tmp / vendor… 的資料夾） */
  const queue: Array<{ dir: string; depth: number; listOnly?: boolean }> = [];
  for (const root of roots) {
    const ms = budget();
    if (!ms || stalledDirs.has(root)) {
      truncated = true;
      continue;
    }
    const dir = await within(root, realpath(root), ms).catch(() => null);
    if (dir === 'timeout') truncated = true;
    // 不存在 / 卡住 / 整個磁碟（/、C:\）：略過
    else if (dir && parse(dir).root !== dir) queue.push({ dir, depth: 0 });
  }
  const found = new Set<string>();
  const seen = new Set<string>();
  const listed = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const ms = budget();
    if (seen.size >= maxDirs || found.size >= maxRepos || !ms) {
      truncated = true;
      break;
    }
    const { dir, depth, listOnly } = queue[i]!;
    if (seen.has(dir) || listed.has(dir)) continue;
    if (stalledDirs.has(dir)) {
      truncated = true;
      continue;
    }
    if (listOnly) {
      // 只看 <dir>/.git 在不在（不讀整個 node_modules / vendor，也不算進 maxDirs）
      listed.add(dir);
      const git = await within(dir, stat(join(dir, '.git')), ms).catch(() => null);
      if (git === 'timeout') truncated = true;
      else if (git && found.size < maxRepos) found.add(dir);
      continue;
    }
    seen.add(dir);
    const entries = await within(dir, readdir(dir, { withFileTypes: true }), ms).catch(() => null);
    if (entries === 'timeout') truncated = true;
    if (!entries || entries === 'timeout') continue;
    if (entries.some((e) => e.name === '.git') || (dir.endsWith('.git') && isBareRepo(entries))) {
      found.add(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      // Dirent.isDirectory() 對 symlink 是 false：不會被連結帶到範圍外或繞圈
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // 名字剛好叫 build / tmp / vendor… 的 repo 還是要列出來，只是不往裡面找
      queue.push({ dir: join(dir, e.name), depth: depth + 1, listOnly: SKIP_DIRS.has(e.name) });
    }
  }
  return { repos: [...found].sort(), truncated };
}

/** 瀏覽器只拿得到這個 id（realpath 的短雜湊）：選 repo 時只送 id，永遠不會把路徑送回 server。 */
export const repoIdFor = (realDir: string): string =>
  createHash('sha256').update(realDir).digest('hex').slice(0, 12);

const expandHome = (p: string): string =>
  p === '~' ? homedir() : /^~[/\\]/.test(p) ? join(homedir(), p.slice(2)) : p;

/** 顯示用：家目錄縮寫成 `~`。 */
const labelFor = (dir: string): string => {
  const home = homedir();
  return dir === home ? '~' : dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
};

const rootsFromEnv = (): string[] | undefined => {
  const raw = process.env['AGG_REPO_ROOTS']?.trim();
  return raw
    ? raw
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
};

interface SessionHooks {
  options: SnapshotOptions;
  warn: (message: string) => void;
  /** 內容有變（新 commit / checkout / fetch…）時呼叫。第一次讀取不算。 */
  onUpdate: (snap: GitSnapshot) => void;
}

/** 一個 repo 的快照與監看：讀取 → 比較 → 有變才通知。 */
export class RepoSession {
  last: GitSnapshot | undefined;
  private key: string | undefined;
  private staleWarned = false;
  private inflight: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  /** 監看已經裝好了（start 時 repo 還打不開，例如 safe.directory，就要等能讀了再裝一次） */
  private watching = false;
  private starting: Promise<void> | undefined;
  private teardown: () => void = () => {};
  /** 畫面要求過的 commit 數（infinite scroll）。之後的讀取與 HMR 推送都讀 max(預設, depth) 筆。 */
  private depth = 0;
  readonly dir: string;
  private readonly hooks: SessionHooks;

  constructor(dir: string, hooks: SessionHooks) {
    this.dir = dir;
    this.hooks = hooks;
  }

  /** 往更早的歷史多讀一些：只增不減（停止監看後重新開啟的 session 會回到預設）。 */
  want(depth: number): void {
    this.depth = Math.max(this.depth, depth);
  }

  async read(): Promise<GitSnapshot> {
    const snap = await readGitSnapshot(this.dir, {
      ...this.hooks.options,
      maxCommits: Math.max(defaultMaxCommits(this.hooks.options), this.depth),
      onWarn: this.hooks.warn,
    });
    if (snap.graph) this.staleWarned = false;
    // 暫時性的 git 錯誤（例如 gc / fetch 進行中）不要把好好的畫面換成錯誤頁；
    // 目錄不見、不是 repo 這類確定的失敗則如實顯示（否則畫面會永遠停在舊圖，使用者還看不出來）。
    if (!snap.graph && snap.transient && this.last?.graph) {
      if (!this.staleWarned)
        this.hooks.warn('keeping the last good snapshot until git can be read again');
      this.staleWarned = true;
      return this.last;
    }
    this.last = snap;
    return snap;
  }

  /** 一次只跑一個；執行中又來要求就在結束後再跑一輪（不漏）。 */
  sync(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          const snap = await this.read();
          if (snap.graph && !this.watching && !this.stopped && this.startedOnce) void this.start();
          const next = snapshotKey(snap);
          if (next === this.key) continue;
          const first = this.key === undefined;
          this.key = next;
          if (!first && !this.stopped) this.hooks.onUpdate(snap);
        } while (this.again);
      } catch (err) {
        this.hooks.warn(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private startedOnce = false;

  /** 監看 .git（HEAD、packed-refs、refs/**），外加輪詢 ref 簽章的安全網。可以重複呼叫：裝好了就什麼都不做。 */
  start(): Promise<void> {
    this.startedOnce = true;
    if (this.watching || this.stopped) return Promise.resolve();
    return (this.starting ??= this.startOnce().finally(() => {
      this.starting = undefined;
    }));
  }

  private async startOnce(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let stopWatching = () => {};
    this.teardown = () => {
      clearTimeout(timer);
      clearTimeout(poll);
      stopWatching();
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.sync(), 250);
    };
    try {
      const dirs = [
        ...new Set(
          (
            await Promise.all([
              git(this.dir, ['rev-parse', '--absolute-git-dir']),
              git(this.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
            ])
          ).map((s) => s.trim()),
        ),
      ];
      if (this.stopped) return;
      const startingSignature = await refsSignature(this.dir);
      if (this.stopped) return;
      stopWatching = watchGitRefs(dirs, onChange);
      this.watching = true;
      // Reconcile the snapshot with refs observed after installing native watchers.
      await this.sync();
      if (this.stopped) return;

      // 安全網：檔案監看可能漏事件（網路磁碟、inotify 上限…），偶爾比對一次 ref 簽章
      // 一次只跑一輪：上一輪的 git 還沒回來（網路磁碟很慢）就不要再疊新的行程
      const pollMs = this.hooks.options.pollMs ?? 2000;
      if (pollMs > 0) {
        let sig = startingSignature;
        const tick = () => {
          if (this.stopped) return;
          poll = setTimeout(() => {
            void refsSignature(this.dir).then((next) => {
              if (next !== sig) {
                sig = next;
                void this.sync();
              }
              tick();
            });
          }, pollMs);
          poll.unref();
        };
        tick();
      }
    } catch {
      // 不是 git repo：沒東西可監看，endpoint 仍可手動重抓
    }
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }
}

/** 只回應這台電腦上的請求（`vite --host` 時，區網裡的其他裝置不能列出 / 讀取 / 加入其他 repo）。 */
export const isLoopback = (req: IncomingMessage): boolean => {
  const address = req.socket?.remoteAddress ?? '';
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
};

/** Windows 的 UNC / 裝置路徑（`\\server\share`、`\\?\`、`//host/x`）：realpath 會去連網路主機，一律不接受。 */
const isRemotePath = (p: string): boolean => /^[\\/]{2}/.test(p);

interface RepoEntry extends LocalRepo {
  dir: string;
}

const toPublic = ({ id, name, label, isDefault }: RepoEntry): LocalRepo => ({
  id,
  name,
  label,
  isDefault,
});

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body ?? null));
};

/**
 * 只回應同源頁面；`direct` 時也允許沒有 fetch metadata 的直接請求（網址列、curl）。
 * 其他 localhost 埠上的頁面不能偷看本機 commit、未推送的 branch 與資料夾位置。
 * Origin 必須與實際連線的 protocol、Host 及 port 一致；fetch metadata 不能覆寫衝突的 Origin。
 */
export function isSameOrigin(req: IncomingMessage, direct: boolean): boolean {
  const target = requestOrigin(req);
  if (!target) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const url = new URL(origin);
      if (
        url.origin !== target.origin ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        return false;
    } catch {
      return false;
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || (direct && site === 'none');
  return origin !== undefined || direct;
}

function requestOrigin(req: IncomingMessage): URL | undefined {
  const host = req.headers.host;
  if (!host || /[\s\\/@?#,]/.test(host)) return;
  try {
    const protocol = (req.socket as TLSSocket | undefined)?.encrypted ? 'https' : 'http';
    return new URL(`${protocol}://${host}`);
  } catch {
    return;
  }
}

/** Keep the local data boundary even when Vite's general allowedHosts check is disabled. */
export function isAllowedHost(req: IncomingMessage, allowedHosts: string[]): boolean {
  const origin = requestOrigin(req);
  if (!origin) return false;
  const host = origin.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost')) return true;
  return allowedHosts.some((value) => {
    const allowed = value.toLowerCase().replace(/\.$/, '');
    return allowed.startsWith('.')
      ? host === allowed.slice(1) || host.endsWith(allowed)
      : host === allowed;
  });
}

/**
 * 讀取 request body（最多 `limit` bytes）。超過時丟掉其餘內容、讀完才回報錯誤，413 才送得到瀏覽器
 * （馬上 destroy 會連 socket 一起關掉，瀏覽器只會看到連線被重設）；大得離譜（> 1 MB）才直接斷線。
 */
const readBody = (req: IncomingMessage, limit: number) =>
  new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > 1024 * 1024) req.destroy();
    });
    req.on('end', () =>
      size > limit
        ? fail(new Error('request body too large'))
        : ok(Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', fail);
    req.on('close', () => fail(new Error('request aborted')));
  });

/** 同時監看幾個「非預設」repo；超過就停掉最久沒用的那個（之後再選到時會重新開始監看）。 */
const MAX_SESSIONS = 4;
/** 非預設 repo 多久沒有人要快照就停止監看（畫面顯示中的 repo 每 2 分鐘會重抓一次）。 */
const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
/** 使用者手動加入的路徑最多記幾個。 */
const MAX_ADDED = 50;
const SCAN_TTL_MS = 5000;

/** `depth` 參數：省略是 undefined、不合法是 null，其餘夾在 [1, MAX_DEPTH]。 */
const parseDepth = (raw: string | null): number | null | undefined => {
  if (raw === null) return undefined;
  if (!/^\d{1,32}$/.test(raw)) return null;
  return Math.min(MAX_DEPTH, Math.max(1, Number(raw)));
};

const VIRTUAL_ID = 'virtual:git-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** 廣播的內容：預設 repo 帶著快照（它本來就在畫面的 bundle / 首頁裡），其他 repo 只通知「有變」。 */
export const snapshotEvent = (repo: string, snapshot: GitSnapshot): SnapshotEvent =>
  repo === DEFAULT_REPO ? { repo, snapshot } : { repo };

/**
 * 掛載本機 repo 的 HTTP endpoint 的地方：Vite dev server（`pnpm start`）或 npm CLI 的獨立 server。
 * 兩者共用同一套 endpoint 與檢查；差別只在「怎麼掛 handler」與「怎麼把更新推給畫面」（HMR / SSE）。
 */
export interface LocalRepoHost {
  options: SnapshotOptions;
  /** 預設 repo（AGG_REPO_DIR / --repo） */
  repoDir: string;
  stateFile: string | false;
  /** 除了 IP / localhost 以外允許的 Host（Vite 的 server.allowedHosts） */
  allowedHosts: string[];
  warn: (message: string) => void;
  /** connect 風格：處理 `path`（含其下的路徑與 query）的請求 */
  use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
  /** 某個 repo 的快照有變：推送給畫面（廣播內容用 snapshotEvent 決定） */
  push: (repo: string, snapshot: GitSnapshot) => void;
  /** 已經建立的預設 repo session（Vite 的 virtual module 共用同一個）；省略就自己建立 */
  defaultSession?: RepoSession;
}

export interface LocalRepoService {
  /** 停止所有監看與計時器 */
  close: () => void;
  /** 預設 repo 目前的快照（SSE 連線建立時先送一份） */
  defaultSnapshot: () => GitSnapshot | undefined;
}

/**
 * 提供 `virtual:git-snapshot`（建置 / 啟動當下預設 repo 的 git 歷史），
 * dev 時監看 .git，有新 commit / checkout / fetch 就透過 HMR 即時推送新快照；
 * 另外提供本機 repo 清單與任一 repo 的快照，讓畫面可以切換要看哪個本機 repo。
 * `bake: false`：建置時不把 git 歷史烤進 bundle（npm CLI 的畫面由 server 提供快照）。
 */
export function gitSnapshot(
  options: SnapshotOptions = {},
  { bake = true }: { bake?: boolean } = {},
): Plugin {
  let allowedHosts: string[] = [];
  let repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? process.cwd();
  let warn: (m: string) => void = options.onWarn ?? ((m) => console.warn(`[git-snapshot] ${m}`));
  let push: (repo: string, snap: GitSnapshot) => void = () => {};
  let stateFile: string | false = options.stateFile ?? process.env['AGG_LOCAL_REPOS_FILE'] ?? false;
  let main: RepoSession | undefined;
  // 建置時（沒有 dev server）也要能讀，所以 lazily 建立；dev 時 configureServer 再讓它開始監看
  const mainSession = () =>
    (main ??= new RepoSession(repoDir, {
      options,
      warn: (m) => warn(m),
      onUpdate: (snap) => push(DEFAULT_REPO, snap),
    }));

  return {
    name: 'adorable-git-snapshot',
    configResolved(config) {
      allowedHosts = [
        ...(Array.isArray(config.server?.allowedHosts) ? config.server.allowedHosts : []),
        ...(typeof config.server?.host === 'string' ? [config.server.host] : []),
      ];
      repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? config.root;
      stateFile =
        options.stateFile ?? process.env['AGG_LOCAL_REPOS_FILE'] ?? defaultStateFile(config.root);
      warn = options.onWarn ?? ((m) => config.logger.warn(`[git-snapshot] ${m}`));
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      if (!bake) return 'export default undefined;';
      const session = mainSession();
      const snap = session.last ?? (await session.read());
      return `export default ${JSON.stringify(snap)};`;
    },
    async configureServer(server) {
      // vitest 只是借用 Vite 的轉換管線，不需要讀 git 也不需要監看
      if (process.env['VITEST']) return;
      // The virtual module also contains local history. Guard every HTTP entry
      // before Vite transforms or serves cached module bytes, including aliases
      // and query variants of virtual:git-snapshot.
      server.middlewares.use((req, res, next) => {
        if (!isAllowedHost(req, allowedHosts) || !isSameOrigin(req, true))
          return sendJson(res, 403, { error: 'forbidden' });
        next();
      });
      push = (repo, snapshot) => {
        // 預設 repo 也是 virtual module：重新整理頁面時要拿到新的 module，而不是舊快取
        if (repo === DEFAULT_REPO) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
        // HMR 會廣播給所有連線（`vite --host` 時含區網裡的裝置）：預設 repo 的內容本來就在 bundle 裡，
        // 其他 repo 只通知「有變」，畫面再經由只回應本機的 endpoint 去拿
        server.ws.send({ type: 'custom', event: HMR_EVENT, data: snapshotEvent(repo, snapshot) });
      };
      // 每個 dev server 用自己的預設 session：同一個 plugin 實例被重新設定時（例如 server.restart()），
      // 舊 server 關閉時的 cleanup 只能停掉它自己的監看，不能把新 server 的也停掉
      main?.stop();
      main = undefined;
      const def = mainSession();
      const service = await serveLocalRepos({
        options,
        repoDir,
        stateFile,
        allowedHosts,
        warn: (m) => warn(m),
        use: (path, handler) => server.middlewares.use(path, handler),
        push: (repo, snap) => push(repo, snap),
        defaultSession: def,
      });
      // dev server（含 vitest 的無 httpServer 模式）關閉時一定要放掉 watcher / timer，否則行程無法結束
      const cleanup = () => {
        service.close();
        if (main === def) main = undefined;
      };
      const close = server.close.bind(server);
      server.close = async () => {
        cleanup();
        await close();
      };
      server.httpServer?.once('close', cleanup);
    },
  };
}

/** 本機 repo 的 endpoint（快照 / 清單 / 加入路徑 / 診斷）與監看。Vite plugin 與 npm CLI 共用。 */
export async function serveLocalRepos(host: LocalRepoHost): Promise<LocalRepoService> {
  const { options, repoDir, stateFile, allowedHosts, warn, use, push } = host;
  const def =
    host.defaultSession ??
    new RepoSession(repoDir, { options, warn, onUpdate: (snap) => push(DEFAULT_REPO, snap) });
  await def.sync();
  await def.start();

  // 預設 repo 的實際位置：清單去重用，也是預設的掃描根目錄（它的上一層）
  const resolved = await resolveRepo(repoDir).catch(() => ({
    dir: repoDir,
    name: basename(resolve(repoDir)),
  }));
  const defaultDir = await realpath(resolved.dir).catch(() => resolve(resolved.dir));
  const defaultEntry: RepoEntry = {
    id: DEFAULT_REPO,
    dir: defaultDir,
    name: resolved.name,
    label: labelFor(defaultDir),
    isDefault: true,
  };
  const roots = (options.repoRoots ?? rootsFromEnv() ?? [dirname(defaultDir)]).map((p) =>
    resolve(expandHome(p)),
  );
  const scanDepth = options.scanDepth ?? intFromEnv('AGG_REPO_SCAN_DEPTH') ?? 3;

  // ── 清單：掃描結果（短暫快取）+ 使用者手動加入的路徑（記在 stateFile） ──
  const added = new Map<string, RepoEntry>();
  const entryFor = (dir: string, name = basename(dir).replace(/\.git$/, '') || basename(dir)) => {
    const id = repoIdFor(dir);
    return { id, dir, name, label: labelFor(dir), isDefault: false };
  };
  if (stateFile) {
    try {
      const saved: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
      const paths = (saved as { paths?: unknown } | null)?.paths;
      const dirs = (Array.isArray(paths) ? paths.slice(0, MAX_ADDED) : []).filter(
        (dir): dir is string =>
          typeof dir === 'string' && isAbsolute(dir) && !isRemotePath(dir) && dir !== defaultDir,
      );
      // 已經不存在的就不列了。一個一個檢查、總共最多等 1 秒，碰到第一個卡住的就停（剩下的照列）：
      // 卡住的 stat 會一直佔著 libuv 執行緒，不能讓它吃掉掃描的額度或 Vite 讀檔要用的執行緒
      const alive: boolean[] = [];
      const until = Date.now() + 1000;
      let checking = true;
      for (const dir of dirs) {
        const left = Math.min(500, until - Date.now());
        if (!checking || left <= 0 || stalledDirs.size >= MAX_STALLED - 1) {
          alive.push(true);
          continue;
        }
        const result = await within(dir, stat(dir), left).then(
          (r) => (r === 'timeout' ? 'timeout' : 'ok'),
          (err: { code?: string }) =>
            err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'gone' : 'ok',
        );
        if (result === 'timeout') checking = false;
        alive.push(result !== 'gone');
      }
      dirs.forEach((dir, i) => {
        if (!alive[i]) return;
        const entry = entryFor(dir);
        added.set(entry.id, entry);
      });
    } catch {
      /* 還沒有檔案 / 壞掉：當作空的 */
    }
  }
  let saving = Promise.resolve();
  const saveAdded = () => {
    if (!stateFile) return;
    const file = stateFile;
    const body = JSON.stringify({ paths: [...added.values()].map((e) => e.dir) }, null, 2);
    // 依序寫入；先寫暫存檔再 rename，中途中斷也不會留下半個檔案。
    // 暫存檔用不會重複的名字 + 'wx'：已經存在的檔案或 symlink 不會被跟著寫進去
    saving = saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${body}\n`, { mode: 0o600, flag: 'wx' });
        await rename(tmp, file);
      })
      .catch((err: unknown) => warn(`could not remember the added repositories: ${String(err)}`));
  };
  let discovered = new Map<string, RepoEntry>();
  let truncated = false;
  let scannedAt = -Infinity;
  let scanning: Promise<void> | undefined;
  const rescan = (maxAgeMs: number): Promise<void> => {
    if (scanning) return scanning;
    if (Date.now() - scannedAt < maxAgeMs) return Promise.resolve();
    scanning = discoverRepos(roots, { maxDepth: scanDepth })
      .then((result) => {
        const next = new Map<string, RepoEntry>();
        for (const dir of result.repos) {
          if (dir === defaultDir) continue;
          const entry = entryFor(dir);
          next.set(entry.id, entry);
        }
        // 掃描被中斷（上限 / 時間 / 卡住的磁碟）：沒掃到的不代表不見了，沿用上一次的結果
        if (result.truncated)
          for (const [id, entry] of discovered) if (!next.has(id)) next.set(id, entry);
        discovered = next;
        truncated = result.truncated;
        scannedAt = Date.now();
      })
      .catch((err: unknown) => warn(`could not scan for repositories: ${String(err)}`))
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  };

  const list = (): ReposResponse => {
    const others = [...new Map([...discovered, ...added]).values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.label.localeCompare(b.label),
    );
    return { repos: [defaultEntry, ...others].map(toPublic), truncated };
  };

  // ── 每個 repo 一個 session（快照 + 監看）；非預設的最多留 MAX_SESSIONS 個 ──
  let closed = false;
  const sessions = new Map<string, { entry: RepoEntry; session: RepoSession; usedAt: number }>();
  const opening = new Map<string, Promise<RepoSession | undefined>>();

  const findEntry = async (id: string): Promise<RepoEntry | undefined> => {
    const hit = () => sessions.get(id)?.entry ?? added.get(id) ?? discovered.get(id);
    if (hit()) return hit();
    // 例如 dev server 重新啟動後直接打開 `?local=<id>` 的網址：清單還沒掃過
    await rescan(2000);
    return hit();
  };

  const sessionFor = (id: string): Promise<RepoSession | undefined> => {
    if (id === DEFAULT_REPO) return Promise.resolve(def);
    const open = sessions.get(id);
    if (open) {
      // LRU：移到最後
      open.usedAt = Date.now();
      sessions.delete(id);
      sessions.set(id, open);
      return Promise.resolve(open.session);
    }
    let pending = opening.get(id);
    if (!pending) {
      pending = (async () => {
        const entry = await findEntry(id);
        if (!entry || closed) return undefined;
        const session = new RepoSession(entry.dir, {
          // AGG_DEFAULT_BRANCH 是給預設 repo 的；其他 repo 用它自己的 origin/HEAD → main → master…
          // （'' 會蓋過環境變數，selectRefs 會略過空字串）
          options: { ...options, defaultBranch: '' },
          warn: (m) => warn(`${entry.name}: ${m}`),
          onUpdate: (snap) => push(id, snap),
        });
        sessions.set(id, { entry, session, usedAt: Date.now() });
        for (const [oldId, old] of sessions) {
          if (sessions.size <= MAX_SESSIONS) break;
          old.session.stop();
          sessions.delete(oldId);
        }
        await session.start();
        return session;
      })().finally(() => opening.delete(id));
      opening.set(id, pending);
    }
    return pending;
  };

  // 看過一次就一直輪詢（每 2 秒 3 個 git 行程）太浪費：久沒人要的停掉，再選到時會重新開始
  const idleMs = options.idleMs && options.idleMs > 0 ? options.idleMs : IDLE_MS;
  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const [id, open] of sessions) {
        if (open.usedAt >= cutoff) continue;
        open.session.stop();
        sessions.delete(id);
      }
    },
    Math.min(SWEEP_MS, idleMs),
  );
  sweep.unref();

  /** 使用者輸入的路徑：必須是絕對路徑（可用 ~）、存在、而且在 git repo 裡。回傳的 repo 之後一樣只用 id 存取。 */
  const addRepo = async (input: unknown): Promise<{ status: number; body: unknown }> => {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0')) {
      return { status: 400, body: { error: 'invalid_path' } };
    }
    const wanted = expandHome(input.trim());
    if (!isAbsolute(wanted)) return { status: 400, body: { error: 'not_absolute' } };
    if (isRemotePath(wanted)) return { status: 400, body: { error: 'invalid_path' } };
    let dir: string;
    try {
      dir = await realpath(wanted);
      if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
    } catch {
      return { status: 404, body: { error: 'not_found' } };
    }
    let top: string;
    let name: string;
    try {
      const repo = await resolveRepo(dir);
      top = await realpath(repo.dir);
      name = repo.name;
    } catch (err) {
      const code =
        err instanceof SnapshotError && err.code === 'unsafe_repo' ? err.code : 'not_git';
      return { status: 422, body: { error: code } };
    }
    if (top === defaultDir) return { status: 200, body: { repo: toPublic(defaultEntry) } };
    const id = repoIdFor(top);
    const entry = discovered.get(id) ?? added.get(id) ?? entryFor(top, name);
    added.delete(id);
    added.set(id, entry);
    for (const oldId of added.keys()) {
      if (added.size <= MAX_ADDED) break;
      added.delete(oldId);
    }
    saveAdded();
    return { status: 200, body: { repo: toPublic(entry) } };
  };

  use(DIAGNOSTICS_ENDPOINT, (req, res) => {
    if (!isAllowedHost(req, allowedHosts)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!isLoopback(req) || !isSameOrigin(req, false))
      return sendJson(res, 403, { error: 'local_only' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
      return sendJson(res, 415, { error: 'unsupported_media_type' });
    const ctrl = new AbortController();
    req.once('aborted', () => ctrl.abort());
    res.once('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });
    void readBody(req, 16384)
      .then(
        async (raw) => {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(raw);
          } catch {
            return sendJson(res, 400, { error: 'invalid_request' });
          }
          if (!body || Array.isArray(body) || typeof body !== 'object')
            return sendJson(res, 400, { error: 'invalid_request' });
          if (
            !isDiagnosticRequest(body) ||
            body.operation === 'pull-request' ||
            (body as Record<string, unknown>)['commitRepo'] !== undefined ||
            (body as Record<string, unknown>)['headRepo'] !== undefined
          )
            return sendJson(res, 400, { error: 'invalid_request' });
          const id = (body as Record<string, unknown>)['repo'] ?? DEFAULT_REPO;
          if (typeof id !== 'string' || !isRepoId(id))
            return sendJson(res, 400, { error: 'invalid_repo' });
          const entry = id === DEFAULT_REPO ? defaultEntry : await findEntry(id);
          if (!entry) return sendJson(res, 404, { error: 'unknown_repo' });
          const adapter = createLocalDiagnostics(entry.dir, (args, signal) =>
            runDiagnosticGit(entry.dir, args, signal),
          );
          let data: unknown;
          switch (body['operation']) {
            case 'compare':
              data = await adapter.compare(body.base, body.head, ctrl.signal);
              break;
            case 'changes':
              data = await adapter.changes(body.sha, body.parent, ctrl.signal);
              break;
            case 'patch':
              data = await adapter.patch(
                body.base,
                body.head,
                body.path,
                body.previousPath,
                ctrl.signal,
              );
              break;
            default:
              return sendJson(res, 400, { error: 'invalid_operation' });
          }
          if (!ctrl.signal.aborted) sendJson(res, 200, data);
        },
        () => sendJson(res, 413, { error: 'too_large' }),
      )
      .catch(() => {
        if (!ctrl.signal.aborted) sendJson(res, 422, { error: 'diagnostic_unavailable' });
      });
  });

  use(SNAPSHOT_ENDPOINT, (req, res) => {
    if (!isAllowedHost(req, allowedHosts)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!isSameOrigin(req, true)) return sendJson(res, 403, { error: 'forbidden' });
    let id: string;
    let depth: number | null | undefined;
    try {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      id = params.get('repo') ?? DEFAULT_REPO;
      // infinite scroll：要更早的歷史就帶 depth（這個 repo 之後的讀取與 HMR 推送都至少讀這麼多筆）
      depth = parseDepth(params.get('depth'));
    } catch {
      id = '';
    }
    if (!isRepoId(id)) return sendJson(res, 400, { error: 'invalid_repo' });
    if (depth === null) return sendJson(res, 400, { error: 'invalid_depth' });
    if (id !== DEFAULT_REPO && !isLoopback(req)) return sendJson(res, 403, { error: 'local_only' });
    void sessionFor(id)
      .then(async (session) => {
        if (!session) return sendJson(res, 404, { error: 'unknown_repo' });
        if (depth) session.want(depth);
        await session.sync();
        sendJson(res, 200, session.last);
      })
      .catch((err: unknown) => {
        warn(`snapshot request failed: ${String(err)}`);
        sendJson(res, 500, { error: 'internal' });
      });
  });

  use(REPOS_ENDPOINT, (req, res) => {
    if (!isAllowedHost(req, allowedHosts)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'GET' && req.method !== 'POST')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    // 本機的資料夾結構與其他 repo 只給這台電腦看（`vite --host` 時區網裡的裝置只看得到預設 repo）
    if (!isLoopback(req)) return sendJson(res, 403, { error: 'local_only' });
    if (req.method === 'GET') {
      if (!isSameOrigin(req, true)) return sendJson(res, 403, { error: 'forbidden' });
      void rescan(SCAN_TTL_MS).then(() => sendJson(res, 200, list()));
      return;
    }
    // POST：這會讓 server 去讀使用者輸入的路徑：只接受同源頁面送來的 JSON
    // （跨站的 form / no-cors 請求送不出 application/json，fetch 則會先被 CORS preflight 擋下）
    if (!isSameOrigin(req, false)) return sendJson(res, 403, { error: 'forbidden' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'unsupported_media_type' });
    }
    void readBody(req, 8192).then(
      async (raw) => {
        let path: unknown;
        try {
          path = (JSON.parse(raw) as { path?: unknown } | null)?.path;
        } catch {
          path = undefined;
        }
        const result = await addRepo(path);
        sendJson(res, result.status, result.body);
      },
      () => sendJson(res, 413, { error: 'too_large' }),
    );
  });

  // 關閉時一定要放掉 watcher / timer，否則行程無法結束
  const close = () => {
    closed = true;
    clearInterval(sweep);
    def.stop();
    for (const { session } of sessions.values()) session.stop();
    sessions.clear();
  };
  return { close, defaultSnapshot: () => def.last };
}
