import type { DetailSize } from '@adorable/graph-ui';
import { useExtensionSetting } from './useExtensionSetting';

/** 詳情面板大小記在 extension 的本機儲存（不是 github.com 的 localStorage），下次打開 overlay 還是同一個大小。 */
export const DETAIL_SIZE_KEY = 'detailSize';

export const isDetailSize = (v: unknown): v is DetailSize => v === 'normal' || v === 'wide';

export function useDetailSize(): [DetailSize, (size: DetailSize) => void] {
  return useExtensionSetting<DetailSize>(DETAIL_SIZE_KEY, 'normal', isDetailSize);
}
