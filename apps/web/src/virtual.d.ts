declare module 'virtual:git-snapshot' {
  import type { GitSnapshot } from '@adorable/git-local/protocol';
  /** npm CLI 的建置不烤快照（由 server 提供）：undefined */
  const snapshot: GitSnapshot | undefined;
  export default snapshot;
}
