import { useCallback, useState } from 'react';
import type { DetailSize } from '../scene/geometry';

const ANIMATION_OFF_KEY = 'agg:animation-off';

/**
 * 「關閉動畫」開關。給了 `controlled` 就是 controlled（由使用端決定存在哪裡）；
 * 沒給就由 viewer 自己記在 localStorage（`agg:animation-off`）。
 */
export function useAnimationOff(
  controlled: boolean | undefined,
  onChange: ((off: boolean) => void) | undefined,
): [boolean, () => void] {
  const [own, setOwn] = useState(() => {
    if (controlled !== undefined) return false;
    try {
      return localStorage.getItem(ANIMATION_OFF_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const animationOff = controlled ?? own;
  const isControlled = controlled !== undefined;
  const toggle = useCallback(() => {
    const next = !animationOff;
    if (!isControlled) {
      setOwn(next);
      try {
        localStorage.setItem(ANIMATION_OFF_KEY, String(next));
      } catch {
        /* optional */
      }
    }
    onChange?.(next);
  }, [animationOff, isControlled, onChange]);
  return [animationOff, toggle];
}

/** 詳情面板的大小：給了 `controlled` 就是 controlled，沒給就由 viewer 自己記（預設 'normal'）。 */
export function useDetailSize(
  controlled: DetailSize | undefined,
  onChange: ((size: DetailSize) => void) | undefined,
): [DetailSize, () => void] {
  const [own, setOwn] = useState<DetailSize>('normal');
  const detailSize = controlled ?? own;
  const isControlled = controlled !== undefined;
  const toggle = useCallback(() => {
    const next: DetailSize = detailSize === 'wide' ? 'normal' : 'wide';
    if (!isControlled) setOwn(next);
    onChange?.(next);
  }, [detailSize, isControlled, onChange]);
  return [detailSize, toggle];
}
