import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailSize } from '@adorable/graph-ui';

/** 詳情面板大小記在 extension 的本機儲存（不是 github.com 的 localStorage），下次打開 overlay 還是同一個大小。 */
export const DETAIL_SIZE_KEY = 'detailSize';

export const isDetailSize = (v: unknown): v is DetailSize => v === 'normal' || v === 'wide';

/** 讀取完成前先用 'normal'；讀寫失敗（例如 extension 剛更新、舊 content script）時只是不記住。 */
export function useDetailSize(): [DetailSize, (size: DetailSize) => void] {
  const [size, setSize] = useState<DetailSize>('normal');
  // 讀取回來之前使用者就切換過：以使用者的選擇為準
  const touched = useRef(false);

  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => chrome.storage.local.get(DETAIL_SIZE_KEY))
      .then((got) => {
        const saved = (got as Record<string, unknown>)[DETAIL_SIZE_KEY];
        if (alive && !touched.current && isDetailSize(saved)) setSize(saved);
      })
      .catch(() => {});
    // 另一個分頁的 overlay 切換了：跟著換
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const next: unknown = changes[DETAIL_SIZE_KEY]?.newValue;
      if (area === 'local' && isDetailSize(next)) setSize(next);
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      /* 沒有 storage API：只是不同步 */
    }
    return () => {
      alive = false;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {
        /* ignore */
      }
    };
  }, []);

  const change = useCallback((next: DetailSize) => {
    touched.current = true;
    setSize(next);
    void Promise.resolve()
      .then(() => chrome.storage.local.set({ [DETAIL_SIZE_KEY]: next }))
      .catch(() => {});
  }, []);
  return [size, change];
}
