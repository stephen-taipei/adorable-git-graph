// Vite 的接線：把 @adorable/git-local 的本機 repo 執行環境掛到 dev server（`pnpm start`）上，
// 並提供 `virtual:git-snapshot`、以 HMR 推送更新。讀 git、endpoint 與檢查本身都在 libs/git-local（npm CLI 共用）。
import type { Plugin } from 'vite';
import {
  RepoSession,
  defaultStateFile,
  isAllowedHost,
  isSameOrigin,
  sendJson,
  serveLocalRepos,
  snapshotEvent,
} from '@adorable/git-local';
import type { GitSnapshot, SnapshotOptions } from '@adorable/git-local';
import { DEFAULT_REPO, HMR_EVENT } from '@adorable/git-local/protocol';

const VIRTUAL_ID = 'virtual:git-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

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
