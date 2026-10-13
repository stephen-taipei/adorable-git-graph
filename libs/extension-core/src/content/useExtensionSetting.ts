import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 一個記在 extension 本機儲存（chrome.storage.local，不是 github.com 的 localStorage）的 overlay 偏好設定。
 * 讀取完成前先用 `fallback`；讀寫失敗（例如 extension 剛更新、舊 content script）時只是不記住。
 * 另一個分頁的 overlay 改了同一個設定時跟著換。
 * `legacy`：storage 裡還沒有值時呼叫一次，回傳舊位置的值（遷移用，會寫回 storage）。
 */
export function useExtensionSetting<T>(
  key: string,
  fallback: T,
  isValid: (v: unknown) => v is T,
  legacy?: () => T | undefined,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  // 讀取回來之前使用者就切換過：以使用者的選擇為準
  const touched = useRef(false);
  const legacyRef = useRef(legacy);

  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(() => chrome.storage.local.get(key))
      .then(async (got) => {
        const saved = (got as Record<string, unknown>)[key];
        if (!alive || touched.current) return;
        if (isValid(saved)) return setValue(saved);
        const old = legacyRef.current?.();
        if (old === undefined) return;
        setValue(old);
        await chrome.storage.local.set({ [key]: old });
      })
      .catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const next: unknown = changes[key]?.newValue;
      if (area === 'local' && isValid(next)) setValue(next);
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
  }, [key, isValid]);

  const change = useCallback(
    (next: T) => {
      touched.current = true;
      setValue(next);
      void Promise.resolve()
        .then(() => chrome.storage.local.set({ [key]: next }))
        .catch(() => {});
    },
    [key],
  );
  return [value, change];
}
