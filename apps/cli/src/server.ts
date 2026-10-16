// `npx adorable-git-graph`：不需要 Vite 的獨立 server。
// 提供預先建置好的畫面（dist/web，以 VITE_AGG_SERVER=1 建置：不含任何 git 歷史），
// 與 `pnpm start` 相同的本機 repo endpoint（共用 libs/git-local，即 @adorable/git-local），即時更新改用 SSE。
// 只綁 127.0.0.1；Host / Origin 檢查與 dev server 相同（DNS rebinding、其他 localhost 埠的頁面都讀不到）。
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPO,
  EVENTS_ENDPOINT,
  defaultStateFile,
  isAllowedHost,
  isSameOrigin,
  sendJson,
  serveLocalRepos,
  snapshotEvent,
} from '@adorable/git-local';
import type { GitSnapshot } from '@adorable/git-local';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4200;
/** 沒有指定 --port 時，4200 被占用就往後找幾個 */
const PORT_TRIES = 20;
const HEARTBEAT_MS = 25_000;

const HELP = `Usage: adorable-git-graph [repo] [options]

Shows a cartoon-style, animated git graph of a local repository in your browser.
Read-only: it only runs read-only git commands. Listens on ${HOST} only.

Arguments:
  repo                 Repository to show (default: AGG_REPO_DIR, else the current directory).
                       Other repositories next to it can be picked in the page.

Options:
  -p, --port <port>    Port to listen on (default: ${DEFAULT_PORT}, or the next free one)
      --no-open        Do not open the browser
  -h, --help           Show this help
  -v, --version        Show the version

Environment: AGG_MAX_COMMITS, AGG_MAX_BRANCHES, AGG_DEFAULT_BRANCH, AGG_REPO_ROOTS,
AGG_REPO_SCAN_DEPTH, AGG_LOCAL_REPOS_FILE (see the README).`;

export interface CliOptions {
  repo: string;
  port: number | undefined;
  open: boolean;
}

const expandHome = (p: string): string =>
  p === '~'
    ? homedir()
    : p.startsWith('~/') || p.startsWith('~\\')
      ? resolve(homedir(), p.slice(2))
      : p;

/** 回傳 'help' / 'version'，或解析好的選項。不認得的選項直接丟錯（不要默默忽略打錯的參數）。 */
export function parseArgs(argv: string[], env = process.env): CliOptions | 'help' | 'version' {
  let repo: string | undefined;
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') return 'help';
    if (arg === '-v' || arg === '--version') return 'version';
    if (arg === '--no-open') open = false;
    else if (arg === '-p' || arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.startsWith('--port=') ? arg.slice(7) : argv[++i];
      if (!value || !/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error(`Invalid port: ${value ?? '(missing)'}`);
      port = Number(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg} (see --help)`);
    else if (repo === undefined) repo = arg;
    else throw new Error(`Unexpected argument: ${arg} (only one repository can be given)`);
  }
  const dir = repo ?? env['AGG_REPO_DIR'] ?? process.cwd();
  return { repo: resolve(expandHome(dir)), port, open };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** 預先建置的畫面。只提供 webRoot 底下的檔案；`/` 是 index.html。 */
function staticFiles(webRoot: string): Handler {
  const root = resolve(webRoot);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (pathname.includes('\0')) return sendJson(res, 400, { error: 'bad_request' });
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) return sendJson(res, 404, { error: 'not_found' });
    void stat(file)
      .then(async (info) => {
        if (!info.isFile()) return sendJson(res, 404, { error: 'not_found' });
        const body = await readFile(file);
        res.statusCode = 200;
        res.setHeader(
          'content-type',
          MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        );
        res.setHeader('content-length', body.length);
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'same-origin');
        // vite 的 assets 檔名帶內容雜湊；其他（index.html）每次都要重新確認
        res.setHeader(
          'cache-control',
          pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
        res.end(req.method === 'HEAD' ? undefined : body);
      })
      .catch(() => sendJson(res, 404, { error: 'not_found' }));
  };
}

/** 用 SSE 推送快照更新（取代 dev server 的 HMR）。 */
function liveEvents() {
  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, data: unknown) =>
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    broadcast(repo: string, snapshot: GitSnapshot) {
      const event = snapshotEvent(repo, snapshot);
      for (const res of clients) send(res, event);
    },
    handler(current: () => GitSnapshot | undefined): Handler {
      return (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        // 每次連上（含 server 重新啟動後 EventSource 自己重連）先送一份預設 repo 的快照
        const snap = current();
        if (snap) send(res, snapshotEvent(DEFAULT_REPO, snap));
        clients.add(res);
        req.once('close', () => clients.delete(res));
      };
    },
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      fail(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      ok(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface RunningServer {
  url: string;
  defaultSnapshot: () => GitSnapshot | undefined;
  close: () => Promise<void>;
}

/** 啟動 server（不開瀏覽器、不裝 signal handler：給 main 與測試用）。 */
export async function startServer(
  options: Pick<CliOptions, 'repo' | 'port'>,
  webRoot = fileURLToPath(new URL('./web/', import.meta.url)),
): Promise<RunningServer> {
  const warn = (message: string) => console.warn(`[adorable-git-graph] ${message}`);
  const routes: [string, Handler][] = [];
  const live = liveEvents();
  const service = await serveLocalRepos({
    options: {},
    repoDir: options.repo,
    stateFile: process.env['AGG_LOCAL_REPOS_FILE'] ?? defaultStateFile(options.repo, 'cli'),
    allowedHosts: [],
    warn,
    use: (path, handler) => void routes.push([path, handler]),
    push: (repo, snapshot) => live.broadcast(repo, snapshot),
  });
  routes.push([EVENTS_ENDPOINT, live.handler(service.defaultSnapshot)]);
  const files = staticFiles(webRoot);

  const server = createServer((req, res) => {
    // 與 dev server 相同：每個請求（含畫面本身）都要是 localhost / IP 的 Host 且同源
    if (!isAllowedHost(req, []) || !isSameOrigin(req, true))
      return sendJson(res, 403, { error: 'forbidden' });
    const url = req.url ?? '/';
    const pathname = url.split('?')[0]!;
    for (const [path, handler] of routes) {
      if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
      // connect 的 use(path)：handler 看到的是去掉掛載路徑後的網址
      const rest = url.slice(path.length);
      req.url = rest.startsWith('/') ? rest : `/${rest}`;
      return handler(req, res);
    }
    files(req, res);
  });

  let port: number;
  if (options.port !== undefined) port = await listen(server, options.port);
  else {
    let found: number | undefined;
    for (let i = 0; i < PORT_TRIES && found === undefined; i++) {
      try {
        found = await listen(server, DEFAULT_PORT + i);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    if (found === undefined) {
      service.close();
      live.close();
      throw new Error(
        `Ports ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_TRIES - 1} are in use; pick one with --port.`,
      );
    }
    port = found;
  }

  let closing: Promise<void> | undefined;
  return {
    url: `http://${HOST}:${port}/`,
    defaultSnapshot: service.defaultSnapshot,
    close: () =>
      (closing ??= new Promise<void>((done) => {
        service.close();
        live.close();
        server.close(() => done());
        server.closeAllConnections();
      })),
  };
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed === 'help') return void console.log(HELP);
  if (parsed === 'version') return void console.log(await readVersion());
  const running = await startServer(parsed);
  console.log(`\n  Adorable Git Graph  ${running.url}`);
  console.log(`  repo: ${parsed.repo}`);
  console.log('  read-only · press Ctrl+C to stop\n');
  const snap = running.defaultSnapshot();
  if (snap && !snap.graph) console.warn(`  ⚠ ${snap.error ?? 'Could not read this repository.'}\n`);
  if (parsed.open) openBrowser(running.url);
  const stop = () => {
    void running.close().then(() => process.exit(0));
    // 第二次 Ctrl+C：不等了
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
