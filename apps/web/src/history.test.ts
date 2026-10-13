import { describe, expect, it } from 'vitest';
import { getMessages } from '@adorable/graph-ui';
import { HISTORY_PAGE, hasMore, localHistoryError, nextDepth, settled } from './history';
import { MAX_DEPTH } from './protocol';
import { LOCAL_ONLY } from './localRepos';
import { locale, messagesFor } from './i18n';

describe('nextDepth', () => {
  it('asks for one more page than what is loaded', () => {
    expect(nextDepth(300)).toBe(300 + HISTORY_PAGE);
    expect(nextDepth(100)).toBe(100 + HISTORY_PAGE);
  });

  it('never goes past MAX_DEPTH or below one page', () => {
    expect(nextDepth(MAX_DEPTH - 10)).toBe(MAX_DEPTH);
    expect(nextDepth(MAX_DEPTH + 500)).toBe(MAX_DEPTH);
    expect(nextDepth(0)).toBe(1 + HISTORY_PAGE);
  });
});

describe('hasMore', () => {
  it('follows the truncated flag', () => {
    expect(hasMore(true, 300, undefined)).toBe(true);
    expect(hasMore(false, 300, undefined)).toBe(false);
    expect(hasMore(undefined, 300, undefined)).toBe(false);
  });

  it('stops at MAX_DEPTH', () => {
    expect(hasMore(true, MAX_DEPTH, undefined)).toBe(false);
    expect(hasMore(true, MAX_DEPTH - 1, undefined)).toBe(true);
  });

  it('stops when the last load did not add anything, until the count changes', () => {
    const paging = settled(300, 300);
    expect(paging).toEqual({ loading: false, exhaustedAt: 300 });
    expect(hasMore(true, 300, paging)).toBe(false);
    // 有新 commit（數量變多）：再給一次機會
    expect(hasMore(true, 301, paging)).toBe(true);
  });

  it('keeps going after a load that added commits', () => {
    const paging = settled(300, 600);
    expect(paging).toEqual({ loading: false });
    expect(hasMore(true, 600, paging)).toBe(true);
  });

  it('is still "more" while loading or after an error (the viewer shows those states)', () => {
    expect(hasMore(true, 300, { loading: true })).toBe(true);
    expect(hasMore(true, 300, { loading: false, error: 'network' })).toBe(true);
  });
});

describe('localHistoryError', () => {
  it('passes only the reason: the viewer adds "Could not load older history" itself', () => {
    for (const l of ['zh-TW', 'en'] as const) {
      const prefix = getMessages(l).loadMoreFailed;
      for (const r of ['unknown', LOCAL_ONLY, null] as const) {
        const reason = localHistoryError(r);
        expect(reason).toBe(
          messagesFor(locale).historyErrors[
            r === 'unknown' ? 'unknown' : r === LOCAL_ONLY ? 'localOnly' : 'offline'
          ],
        );
        expect(reason).not.toContain(prefix);
        // 在兩種語系裡原因都不帶 viewer 的前綴（不會變成「載入失敗 · 載入失敗…」）
        const m = messagesFor(l).historyErrors;
        for (const text of [m.offline, m.unknown, m.localOnly]) {
          expect(text).not.toContain(prefix);
          expect(text).not.toMatch(/[。.]$/);
        }
      }
    }
  });
});
