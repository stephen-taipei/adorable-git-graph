import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * content script 啟動時先讀好的設定（見 preloadExtensionSettings）。overlay 第一次 render 就用它，
 * 不會先以預設值畫一輪再改（例如「關閉動畫」不能先播一段動畫才關掉）。
 */
const preloaded = new Map<string, unknown>();
let preloadedKeys = new Set<string>();

/** 在第一次 render 之前讀好這些設定。讀取失敗就當作沒有存過（hook 之後還會再讀一次）。 */
export async function preloadExtensionSettings(keys: readonly string[]): Promise<void> {
  try {
    const got = (await chrome.storage.local.get([...keys])) as Record<string, unknown>;
    for (const key of keys) if (key in got) preloaded.set(key, got[key]);
    preloadedKeys = new Set(keys);
  } catch {
    /* 沒有 storage API / extension 剛更新：退回 hook 自己讀 */
  }
}

/**
 * 一個記在 extension 本機儲存（chrome.storage.local，不是 github.com 的 localStorage）的 overlay 偏好設定。
 * 有預先讀好（preloadExtensionSettings）就直接用；否則讀取完成前先用 `fallback`。
 * 讀寫失敗（例如 extension 剛更新、舊 content script）時只是不記住。另一個分頁的 overlay 改了同一個設定時跟著換。
 * `legacy`：storage 裡沒有值時取舊位置的值（遷移用，會寫回 storage；可以有副作用，例如刪掉舊的值）。
 */
export function useExtensionSetting<T>(
  key: string,
  fallback: T,
  isValid: (v: unknown) => v is T,
  legacy?: () => T | undefined,
): [T, (next: T) => void] {
  // 從 legacy 拿到、還沒寫進 storage 的值
  const migrate = useRef<T | undefined>(undefined);
  const [value, setValue] = useState<T>(() => {
    const saved = preloaded.get(key);
    if (isValid(saved)) return saved;
    // 已經確定 storage 裡沒有：現在就遷移舊的值（第一次 render 就是對的）
    if (preloadedKeys.has(key) && legacy) {
      const old = legacy();
      if (old !== undefined) {
        migrate.current = old;
        return old;
      }
    }
    return fallback;
  });
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
        if (isValid(saved)) {
          preloaded.set(key, saved);
          return setValue(saved);
        }
        const old = migrate.current ?? legacyRef.current?.();
        migrate.current = undefined;
        if (old === undefined) return;
        setValue(old);
        preloaded.set(key, old);
        await chrome.storage.local.set({ [key]: old });
      })
      .catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const next: unknown = changes[key]?.newValue;
      if (area === 'local' && isValid(next)) {
        preloaded.set(key, next);
        setValue(next);
      }
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
      migrate.current = undefined;
      preloaded.set(key, next);
      setValue(next);
      void Promise.resolve()
        .then(() => chrome.storage.local.set({ [key]: next }))
        .catch(() => {});
    },
    [key],
  );
  return [value, change];
}
