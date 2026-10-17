import { format, getCatalog, memo, plural } from './catalog';
import type { PluralForms } from './catalog';
import type { Locale } from './locales';

export interface Messages {
  replay: string;
  latest: string;
  refresh: string;
  close: string;
  settings: string;
  loading: string;
  loadingSub: string;
  emptyTitle: string;
  emptySub: string;
  errorTitle: string;
  retry: string;
  crashTitle: string;
  crashSub: string;
  reload: string;
  commits: (n: number) => string;
  branches: (n: number) => string;
  tags: (n: number) => string;
  authors: (n: number) => string;
  merges: (n: number) => string;
  lastCommit: (rel: string) => string;
  truncated: string;
  webglFail: string;
  disableAnimations: string;
  refreshFailed: string;
  // 列表 / 搜尋
  listLabel: string;
  colGraph: string;
  colMessage: string;
  colAuthor: string;
  colDate: string;
  colCommit: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  noMatches: string;
  matchCount: (current: number, total: number) => string;
  nextMatch: string;
  prevMatch: string;
  branchFilterLabel: string;
  focusBranch: (name: string) => string;
  branchTitle: (name: string, sha: string, commits: number, ahead: number, base: string) => string;
  filtering: (n: number, total: number) => string;
  startOfHistory: string;
  // 更早的歷史（infinite scroll）
  loadMore: string;
  loadingMore: string;
  loadMoreFailed: string;
  loadedMore: (n: number) => string;
  /** 頁尾（載入更早的歷史的按鈕與訊息）在無障礙樹裡的群組名稱 */
  olderHistory: string;
  // 標籤
  headLabel: string;
  mergeLabel: string;
  remoteLabel: string;
  defaultLabel: string;
  tagLabel: string;
  moreRefs: (n: number) => string;
  // 詳情
  detailTitle: string;
  closeDetail: string;
  copySha: string;
  copyShaFull: string;
  copied: string;
  copyFailed: string;
  openCommit: string;
  fullSha: string;
  authorLabel: string;
  dateLabel: string;
  parentsLabel: string;
  childrenLabel: string;
  noParents: string;
  mergeOf: (n: number) => string;
  refsLabel: string;
  containedIn: string;
  containedInNote: string;
  noMessage: string;
  prevCommit: string;
  nextCommit: string;
  /** 詳情面板大小的切換鈕（aria-pressed＝目前是寬版）：名稱固定，不隨狀態改變 */
  detailWide: string;
  kinds: Record<string, string>;
  errors: Record<string, string>;
  rateLimitReset: (time: string) => string;
  addToken: string;
  /** GitHub API 剩餘額度偏低的提示（見 graph-core 的 isRateLimitLow） */
  quotaLow: (remaining: number, limit: number) => string;
}

/** viewer 用的字串（由 catalog 的 viewer 區塊產生；同一個語系只產生一次）。 */
export function getMessages(locale: Locale): Messages {
  return memo(locale, 'viewer', () => {
    const v = getCatalog(locale).viewer;
    const p = (forms: PluralForms) => (n: number) => plural(locale, forms, n);
    return {
      ...v,
      commits: p(v.commits),
      branches: p(v.branches),
      tags: p(v.tags),
      authors: p(v.authors),
      merges: p(v.merges),
      lastCommit: (time) => format(v.lastCommit, { time }),
      matchCount: (current, total) => format(v.matchCount, { current, total }),
      focusBranch: (name) => format(v.focusBranch, { name }),
      branchTitle: (name, sha, commits, ahead, base) => {
        const head = format(v.branchTitle, {
          name,
          sha,
          commits: plural(locale, v.commits, commits),
        });
        return ahead > 0 ? `${head} · ${plural(locale, v.branchAhead, ahead, { base })}` : head;
      },
      filtering: (n, total) => plural(locale, v.filtering, total, { n, total }),
      loadedMore: p(v.loadedMore),
      moreRefs: (n) => format(v.moreRefs, { n }),
      mergeOf: p(v.mergeOf),
      rateLimitReset: (time) => format(v.rateLimitReset, { time }),
      quotaLow: (remaining, limit) => format(v.quotaLow, { remaining, limit }),
    } satisfies Messages;
  });
}
