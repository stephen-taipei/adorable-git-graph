import { useCallback, useState } from 'react';
import type { SetStateAction } from 'react';
import type { CommitInspection } from './DiagnosticsPanel';

/** 依 scope 記下的值：scope 換掉之後讀到的就是 fallback（不用另外 effect 去清）。 */
export interface Scoped<T> {
  scope: object;
  value: T;
}

export const scopedValue = <T>(entry: Scoped<T>, scope: object, fallback: T): T =>
  entry.scope === scope ? entry.value : fallback;

export type SetSelectedSha = (
  value: SetStateAction<string | null>,
  /** true：保留「比較與變更」面板正在檢視的 commit（預設選取別的 commit 會把它清掉）。 */
  preserveInspection?: boolean,
) => void;

export interface SelectionState {
  selectedSha: string | null;
  /** 選取是不是屬於目前的 scope（否則還沒有可以存的選取）。 */
  selectionInScope: boolean;
  setSelectedSha: SetSelectedSha;
  /** 診斷面板改檢視別的 commit：取消列表的選取（但保留新的檢視）。 */
  onInspectionChange: (value?: CommitInspection) => void;
  /** 使用者每次主動選取（點列、鍵盤、跳轉）就 +1，傳給 DiagnosticsPanel 的 selectionRevision。 */
  selectionRevision: number;
  bumpSelectionRevision: () => void;
}

/** 列表選取的 commit：依診斷 scope 隔離，與「比較與變更」面板的檢視互斥。 */
export function useSelection(
  scope: object,
  setInspection: (value?: CommitInspection) => void,
): SelectionState {
  const [selection, setSelection] = useState<Scoped<string | null>>(() => ({
    scope,
    value: null,
  }));
  const selectedSha = scopedValue(selection, scope, null);
  const setSelectedSha = useCallback<SetSelectedSha>(
    (value, preserveInspection = false) => {
      if (!preserveInspection) setInspection(undefined);
      setSelection((previous) => ({
        scope,
        value: typeof value === 'function' ? value(scopedValue(previous, scope, null)) : value,
      }));
    },
    [scope, setInspection],
  );
  const onInspectionChange = useCallback(
    (value?: CommitInspection) => {
      if (value) setSelectedSha(null, true);
      setInspection(value);
    },
    [setSelectedSha, setInspection],
  );
  const [selectionRevision, setSelectionRevision] = useState(0);
  const bumpSelectionRevision = useCallback(() => setSelectionRevision((value) => value + 1), []);
  return {
    selectedSha,
    selectionInScope: selection.scope === scope,
    setSelectedSha,
    onInspectionChange,
    selectionRevision,
    bumpSelectionRevision,
  };
}
