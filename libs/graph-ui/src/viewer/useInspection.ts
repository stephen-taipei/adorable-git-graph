import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isFullSha } from '@adorable/graph-core';
import type { GraphLayout } from '@adorable/graph-core';
import type { CommitInspection } from './DiagnosticsPanel';

/** sessionStorage 裡「比較與變更」面板的檢視狀態（只有 sha / repo 與開關，不含診斷內容或憑證）。 */
export interface SavedInspection {
  inspection?: CommitInspection;
  open: boolean;
}

export const inspectionStorageKey = (viewerStateKey: string) => `agg:inspection:${viewerStateKey}`;

/** 解析存下的檢視狀態；格式不對、sha 不完整或 repo 不像 `owner/name` 一律當作沒有。 */
export function parseSavedInspection(raw: string | null): SavedInspection | undefined {
  try {
    const saved = JSON.parse(raw ?? 'null');
    if (!saved || saved.version !== 1 || typeof saved.open !== 'boolean') return;
    const value = saved.inspection;
    if (value === undefined) return { open: saved.open };
    if (
      !value ||
      !isFullSha(value.sha) ||
      (value.repo !== undefined &&
        (typeof value.repo !== 'string' ||
          value.repo.length > 256 ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo)))
    )
      return;
    return {
      open: saved.open,
      inspection: { sha: value.sha, ...(value.repo ? { repo: value.repo } : {}) },
    };
  } catch {
    /* optional metadata storage */
  }
}

/** 要寫進 sessionStorage 的內容（與 parseSavedInspection 對應）。 */
export const serializeInspection = (inspection: CommitInspection | undefined, open: boolean) =>
  JSON.stringify({ version: 1, inspection, open });

function readSavedInspection(viewerStateKey?: string): SavedInspection | undefined {
  if (!viewerStateKey) return;
  try {
    return parseSavedInspection(sessionStorage.getItem(inspectionStorageKey(viewerStateKey)));
  } catch {
    /* optional metadata storage */
  }
}

export interface UseInspectionOptions {
  /** 診斷範圍（title / 來源 / adapter / viewerStateKey 任一改變就換一個新物件）。 */
  scope: object;
  /** 關閉再打開時用來恢復檢視狀態的 key；沒給就不存。 */
  viewerStateKey?: string;
  /** 目前是否已經有圖（state.kind === 'ready'）。 */
  ready: boolean;
  /** 目前的圖：有圖才寫入 sessionStorage。 */
  layout: GraphLayout | null;
  /** 沒有存下的狀態時，面板一開始是否打開（例如帶著 commit / PR context 開啟）。 */
  defaultOpen: boolean;
}

export interface InspectionState {
  inspection: CommitInspection | undefined;
  setInspection: (value?: CommitInspection) => void;
  diagnosticsOpen: boolean;
  setDiagnosticsOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * 「比較與變更」面板正在檢視的 commit 與面板開關，依 scope 隔離，並以 viewerStateKey 存在 sessionStorage：
 * 關掉 overlay 再打開時恢復；換了 scope（換 repo / 來源 / adapter）就清掉。
 */
export function useInspection({
  scope,
  viewerStateKey,
  ready,
  layout,
  defaultOpen,
}: UseInspectionOptions): InspectionState {
  const [inspectionState, setInspectionState] = useState(() => {
    const saved = readSavedInspection(viewerStateKey);
    return {
      scope,
      value: saved?.inspection,
      initialOpen: saved?.open,
      canRestore: !viewerStateKey && !ready,
    };
  });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(
    inspectionState.initialOpen ?? defaultOpen,
  );
  if (inspectionState.scope !== scope) {
    // A freshly mounted overlay obtains its opaque generation asynchronously.
    // Restore once before its first ready commit; active scope changes clear it.
    const restored =
      inspectionState.canRestore && ready ? readSavedInspection(viewerStateKey) : undefined;
    setInspectionState({
      scope,
      value: restored?.inspection,
      initialOpen: undefined,
      canRestore: inspectionState.canRestore && !ready,
    });
    if (restored) setDiagnosticsOpen(restored.open);
  }
  const inspection = inspectionState.scope === scope ? inspectionState.value : undefined;
  const setInspection = useCallback(
    (value?: CommitInspection) => {
      setInspectionState({ scope, value, initialOpen: undefined, canRestore: false });
    },
    [scope],
  );

  useEffect(() => {
    if (!viewerStateKey || !layout || inspectionState.scope !== scope) return;
    try {
      sessionStorage.setItem(
        inspectionStorageKey(viewerStateKey),
        serializeInspection(inspection, diagnosticsOpen),
      );
    } catch {
      /* store metadata only, never diagnostic contents or credentials */
    }
  }, [viewerStateKey, layout, inspection, diagnosticsOpen, inspectionState.scope, scope]);

  return { inspection, setInspection, diagnosticsOpen, setDiagnosticsOpen };
}
