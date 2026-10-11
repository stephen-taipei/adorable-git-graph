import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  isFullSha,
  isSafeRef,
  type ChangedFile,
  type CommitChangesResult,
  type ComparisonResult,
  type Coverage,
  type DiagnosticAdapter,
  type FilePatchResult,
  type GraphLayout,
  type PinnedRef,
  type PullRequestSummary,
} from '@adorable/graph-core';
import type { Locale } from '../i18n';
import { copyText } from './format';

const wording = {
  title: ['唯讀診斷', 'Read-only diagnostics'],
  graph: ['圖形涵蓋範圍', 'Graph coverage'],
  source: ['來源', 'Source'],
  refs: ['Refs', 'Refs'],
  commits: ['Commits', 'Commits'],
  files: ['變更檔案', 'Changed files'],
  patch: ['Diff', 'Diff'],
  observed: ['取得時間', 'Observed at'],
  unknown: ['未知', 'Unknown'],
  complete: ['完整', 'Complete'],
  partial: ['部分', 'Partial'],
  unavailable: ['無法取得', 'Unavailable'],
  base: ['Base', 'Base'],
  head: ['Head', 'Head'],
  compare: ['比較', 'Compare'],
  loading: ['載入中…', 'Loading…'],
  failed: [
    '查詢無法完成。請重新查詢或核對來源權限。',
    'Query unavailable. Retry or check source permissions.',
  ],
  ahead: ['Head 獨有 commit 數', 'Head-only count'],
  behind: ['Base 獨有 commit 數', 'Base-only count'],
  ancestor: ['Base 是 head 的祖先', 'Base is an ancestor of head'],
  yes: ['是', 'Yes'],
  no: ['否', 'No'],
  mergeBase: ['Merge base', 'Merge base'],
  semantics: ['檔案語意：merge-base → head', 'File semantics: merge-base → head'],
  note: [
    '祖先關係不代表 patch 等價、修改目前仍有效或已部署。',
    'Ancestry does not establish patch equivalence, current effectiveness, or deployment.',
  ],
  selected: ['Commit 變更', 'Commit changes'],
  select: [
    '選取 commit 後可查看 parent → commit 的變更。',
    'Select a commit to inspect parent → commit changes.',
  ],
  parent: ['比較 parent', 'Compare parent'],
  root: ['已確認 root：empty tree → commit', 'Verified root: empty tree → commit'],
  copy: ['複製含 SHA 的摘要', 'Copy summary with SHAs'],
  copied: ['已複製', 'Copied'],
  copyFailed: ['複製失敗', 'Copy failed'],
  usePr: ['使用 PR base/head', 'Use PR base/head'],
  none: ['完整清單沒有項目。', 'No entries in the complete list.'],
  incomplete: ['此清單不足以判定沒有變更。', 'This list cannot establish absence of changes.'],
  disabled: [
    '此來源只提供快照；診斷查詢無法使用。',
    'This source provides a snapshot only; diagnostics are unavailable.',
  ],
  textMissing: [
    '未取得文字 patch。可能是 binary、大型檔案或來源未提供。',
    'Text patch unavailable: binary, large, or omitted by the provider.',
  ],
  localRemote: [
    'Remote refs 是本機觀察值。未執行 fetch。',
    'Remote refs are local observations. No fetch was run.',
  ],
  reasons: ['完整性說明', 'Coverage notes'],
  github: ['回 GitHub 核對', 'Verify on GitHub'],
  binary: ['Binary', 'Binary'],
  draft: ['草稿', 'Draft'],
  fullSha: ['固定 SHA', 'Pinned SHA'],
  open: ['開啟診斷', 'Open diagnostics'],
  close: ['收合診斷', 'Close diagnostics'],
} as const;
type Key = keyof typeof wording;
const tr = (loc: Locale, key: Key) => wording[key][loc === 'zh-TW' ? 0 : 1];
const time = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : 'unknown';
const reasonLabels: Record<string, [string, string]> = {
  history_limit: ['歷史讀取達上限', 'History limit'],
  display_window: ['圖形顯示範圍有限', 'Display window'],
  branch_selection: ['只載入選取分支', 'Selected branches only'],
  branch_page_limit: ['分支清單可能超過一頁', 'Branch page limit'],
  tag_page_limit: ['Tag 清單可能超過一頁', 'Tag page limit'],
  tags_unavailable: ['Tag 查詢失敗，無法確認完整清單', 'Tag query failed; full list unknown'],
  tags_outside_history: ['Tag 可能位於已載入歷史之外', 'Tags outside loaded history'],
  shallow_history: ['Shallow 歷史不足', 'Shallow history'],
  file_limit: ['檔案清單達上限', 'File limit'],
  patch_limit: ['Patch 已截斷', 'Patch truncated'],
  patch_truncated: ['Patch 已截斷', 'Patch truncated'],
  statistics_unavailable: ['部分統計無法取得', 'Statistics unavailable'],
  missing_objects: ['缺少 Git 物件', 'Missing Git objects'],
  refs_unavailable: ['Ref 無法解析', 'Refs unavailable'],
  no_common_ancestor: [
    '沒有共同祖先；檔案比較無法使用',
    'No common ancestor; file comparison unavailable',
  ],
  multiple_merge_bases: [
    '有多個 merge base；未選擇檔案基準',
    'Multiple merge bases; no file base selected',
  ],
  commit_limit: ['獨有 commit 清單達上限', 'Unique commit limit'],
  provider_patch_completeness_unknown: [
    '無法確認來源 patch 是否完整',
    'Provider patch completeness unknown',
  ],
  patch_missing_binary_or_large: ['來源未提供 patch', 'Provider omitted patch'],
};
function CoverageText({ value, locale }: { value?: Coverage; locale: Locale }) {
  return (
    <span className="agg-diag-coverage-text">
      {tr(locale, value?.status ?? 'unknown')}
      {value?.loaded !== undefined ? ` (${value.loaded}/${value.total ?? '?'})` : ''}
      {Boolean(value?.reasons.length) && (
        <details>
          <summary>{tr(locale, 'reasons')}</summary>
          <ul>
            {value!.reasons.map((reason, i) => (
              <li key={i}>
                {reasonLabels[reason]?.[locale === 'zh-TW' ? 0 : 1] ?? tr(locale, 'incomplete')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </span>
  );
}
export function CoverageNotice({ layout, locale }: { layout: GraphLayout; locale: Locale }) {
  return (
    <aside className="agg-diag-coverage" aria-label={tr(locale, 'graph')}>
      <strong>{tr(locale, 'graph')}</strong>
      {layout.truncated && <span>{locale === 'zh-TW' ? '歷史已截斷' : 'History truncated'}</span>}
      <span>
        {tr(locale, 'source')}: {layout.coverage?.source ?? 'unknown'}
      </span>
      <span>
        Refs: <CoverageText value={layout.coverage?.refs} locale={locale} />
      </span>
      <span>
        Commits: <CoverageText value={layout.coverage?.commits} locale={locale} />
      </span>
      <span>
        {tr(locale, 'observed')}: {time(layout.coverage?.observedAt ?? layout.fetchedAt)}
      </span>
      {layout.coverage?.remoteRefsAreLocal && <span>{tr(locale, 'localRemote')}</span>}
    </aside>
  );
}
type Kind = 'compare' | 'changes' | 'patch' | 'pr';
export interface DiagnosticsPanelProps {
  scope: object;
  open: boolean;
  adapter?: DiagnosticAdapter;
  layout: GraphLayout;
  selectedSha?: string | null;
  selectionRevision?: number;
  sourceKey: string;
  locale: Locale;
  onGoto: (sha: string) => void;
  onOpenChange?: (open: boolean) => void;
}
export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const [boundary, setBoundary] = useState(() => ({ scope: props.scope, revision: 0 }));
  let current = boundary;
  if (boundary.scope !== props.scope) {
    current = { scope: props.scope, revision: boundary.revision + 1 };
    setBoundary(current);
  }
  return <ScopedDiagnosticsPanel key={current.revision} {...props} />;
}

function ScopedDiagnosticsPanel({
  open,
  adapter,
  layout,
  selectedSha,
  selectionRevision,
  sourceKey,
  locale,
  onGoto,
  onOpenChange,
}: DiagnosticsPanelProps) {
  const id = useId();
  const defaults = () => {
    const base = layout.branches.find((b) => b.isDefault) ?? layout.branches[0];
    return {
      base: base?.name ?? '',
      head:
        (
          layout.branches.find((b) => b.isCurrent && b.name !== base?.name) ??
          layout.branches.find((b) => b.name !== base?.name) ??
          base
        )?.name ?? '',
    };
  };
  const [inputs, setInputs] = useState(defaults);
  const [pins, setPins] = useState<{ base?: PinnedRef; head?: PinnedRef }>({});
  const [inspection, setInspection] = useState<{ sha: string; repo?: string }>();
  useEffect(() => setInspection(undefined), [selectedSha, selectionRevision]);
  const [comparison, setComparison] = useState<ComparisonResult>();
  const [changes, setChanges] = useState<CommitChangesResult>();
  const [parent, setParent] = useState<{ sha: string; value: string }>();
  const [pr, setPr] = useState<PullRequestSummary>();
  const [patch, setPatch] = useState<{ key: string; value: FilePatchResult }>();
  const [busy, setBusy] = useState<Partial<Record<Kind, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Kind, boolean>>>({});
  const [copy, setCopy] = useState<'copy' | 'copied' | 'copyFailed'>('copy');
  const requests = useRef(new Map<Kind, AbortController>());
  const stop = (kind: Kind) => {
    requests.current.get(kind)?.abort();
    requests.current.delete(kind);
    setBusy((b) => ({ ...b, [kind]: false }));
  };
  const start = (kind: Kind) => {
    stop(kind);
    const ctrl = new AbortController();
    requests.current.set(kind, ctrl);
    setBusy((b) => ({ ...b, [kind]: true }));
    setErrors((e) => ({ ...e, [kind]: false }));
    return ctrl;
  };
  const live = (kind: Kind, ctrl: AbortController) =>
    requests.current.get(kind) === ctrl && !ctrl.signal.aborted;
  const done = (kind: Kind, ctrl: AbortController) => {
    if (live(kind, ctrl)) {
      requests.current.delete(kind);
      ctrl.abort();
      setBusy((b) => ({ ...b, [kind]: false }));
    }
  };
  useEffect(() => {
    return () => {
      requests.current.forEach((c) => c.abort());
      requests.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!open) {
      requests.current.forEach((c) => c.abort());
      requests.current.clear();
      setBusy({});
    }
  }, [open]);
  const target = inspection?.sha ?? selectedSha ?? adapter?.context?.commit;
  const parentValue = parent && parent.sha === target ? parent.value : undefined;
  useEffect(() => {
    stop('patch');
    setPatch(undefined);
    setChanges(undefined);
    if (!open || !adapter || !target) return;
    const ctrl = start('changes');
    void (async () => {
      const resolved = isFullSha(target)
        ? target
        : (await adapter.compare(target, target, ctrl.signal)).head.sha;
      if (!isFullSha(resolved)) throw new Error('Invalid SHA');
      const result = await adapter.changes(resolved, parentValue, ctrl.signal, inspection?.repo);
      if (live('changes', ctrl)) {
        if (result.error) setErrors((e) => ({ ...e, changes: true }));
        else setChanges(result);
      }
    })()
      .catch(() => {
        if (live('changes', ctrl)) setErrors((e) => ({ ...e, changes: true }));
      })
      .finally(() => done('changes', ctrl));
    return () => {
      if (requests.current.get('changes') === ctrl) stop('changes');
    };
  }, [adapter, sourceKey, open, target, parentValue, inspection?.repo]);
  useEffect(() => {
    if (!open || !adapter?.pullRequest || !adapter.context?.pullRequest) return;
    const ctrl = start('pr');
    void adapter
      .pullRequest(adapter.context.pullRequest, ctrl.signal)
      .then((result) => {
        if (live('pr', ctrl)) setPr(result);
      })
      .catch(() => {
        if (live('pr', ctrl)) setErrors((e) => ({ ...e, pr: true }));
      })
      .finally(() => done('pr', ctrl));
    return () => {
      if (requests.current.get('pr') === ctrl) stop('pr');
    };
  }, [adapter, sourceKey, open]);
  const compare = async (event: FormEvent) => {
    event.preventDefault();
    if (!adapter) return;
    stop('patch');
    setPatch(undefined);
    setComparison(undefined);
    setCopy('copy');
    const ctrl = start('compare');
    try {
      const result = await adapter.compare(
        pins.base ?? inputs.base.trim(),
        pins.head ?? inputs.head.trim(),
        ctrl.signal,
      );
      if (live('compare', ctrl)) setComparison(result);
    } catch {
      if (live('compare', ctrl)) setErrors((e) => ({ ...e, compare: true }));
    } finally {
      done('compare', ctrl);
    }
  };
  const showPatch = async (
    base: string | null,
    head: string,
    file: ChangedFile,
    headRepo?: string,
  ) => {
    if (!adapter) return;
    const ctrl = start('patch');
    setPatch(undefined);
    try {
      const value = await adapter.patch(
        base,
        head,
        file.path,
        file.previousPath,
        ctrl.signal,
        headRepo,
      );
      if (live('patch', ctrl)) setPatch({ key: JSON.stringify([base, head, file.path]), value });
    } catch {
      if (live('patch', ctrl)) setErrors((e) => ({ ...e, patch: true }));
    } finally {
      done('patch', ctrl);
    }
  };
  const fileRows = (
    entries: ChangedFile[],
    c: Coverage,
    base: string | null,
    head: string,
    canPatch = true,
    headRepo?: string,
  ) => (
    <>
      <CoverageText value={c} locale={locale} />
      {!entries.length && <p>{tr(locale, c.status === 'complete' ? 'none' : 'incomplete')}</p>}
      <ul className="agg-diag-files">
        {entries.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              disabled={!adapter || !canPatch || busy.patch}
              onClick={() => void showPatch(base, head, file, headRepo)}
              aria-label={`${tr(locale, 'patch')}: ${file.path}`}
            >
              <code>{file.path}</code>
            </button>
            <small>
              {file.previousPath ? `${file.previousPath} → ` : ''}
              {file.status} · +{file.additions ?? '?'} / −{file.deletions ?? '?'}
              {file.binary === true ? ` · ${tr(locale, 'binary')}` : ''}
            </small>
            {patch?.key === JSON.stringify([base, head, file.path]) && (
              <div className="agg-diag-patch">
                <CoverageText value={patch.value.coverage} locale={locale} />
                <small>
                  {tr(locale, 'observed')}: {time(patch.value.observedAt)}
                </small>
                {patch.value.patch === null ? (
                  <p>{tr(locale, 'textMissing')}</p>
                ) : (
                  <pre>{patch.value.patch}</pre>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
  const commitRows = (entries: ComparisonResult['headCommits'], commitRepo?: string) => (
    <ul className="agg-diag-commits">
      {entries.map((c) => (
        <li key={c.sha}>
          <button
            type="button"
            disabled={!isFullSha(c.sha)}
            onClick={() => {
              if (layout.nodes.some((n) => n.sha === c.sha)) {
                setInspection(undefined);
                onGoto(c.sha);
              } else setInspection({ sha: c.sha, repo: commitRepo });
            }}
          >
            <code>{c.sha}</code>
          </button>{' '}
          {c.subject}
          {layout.repo.url?.startsWith('https://github.com/') && (
            <a href={`${layout.repo.url}/commit/${c.sha}`} target="_blank" rel="noreferrer">
              {' '}
              ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
  const githubUrl =
    comparison && layout.repo.url?.startsWith('https://github.com/')
      ? `${layout.repo.url}/compare/${comparison.base.sha}...${comparison.head.repo && comparison.head.repo !== `${layout.repo.owner}/${layout.repo.name}` ? `${comparison.head.repo.split('/')[0]}:` : ''}${comparison.head.sha}`
      : undefined;
  return (
    <section className="agg-diagnostics" aria-label={tr(locale, 'title')}>
      <button
        className="agg-diag-toggle"
        type="button"
        aria-label={tr(locale, open ? 'close' : 'open')}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => onOpenChange?.(!open)}
      >
        {tr(locale, 'title')} <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="agg-diag-body" id={`${id}-body`}>
          {!adapter && <p role="status">{tr(locale, 'disabled')}</p>}
          <form className="agg-diag-compare" onSubmit={compare}>
            {(['base', 'head'] as const).map((side) => (
              <label key={side}>
                {tr(locale, side)}
                <input
                  aria-label={tr(locale, side)}
                  list={`${id}-refs`}
                  value={inputs[side]}
                  onChange={(e) => {
                    setInputs((v) => ({ ...v, [side]: e.target.value }));
                    setPins((v) => ({ ...v, [side]: undefined }));
                  }}
                  autoComplete="off"
                />
                {pins[side] && (
                  <small>
                    {pins[side]!.repo} · {tr(locale, 'fullSha')}: {pins[side]!.sha}
                  </small>
                )}
              </label>
            ))}
            <datalist id={`${id}-refs`}>
              {layout.branches.map((b) => (
                <option key={b.name} value={b.name} />
              ))}
            </datalist>
            <button
              className="agg-cta agg-cta--sm"
              type="submit"
              disabled={
                !adapter ||
                busy.compare ||
                !isSafeRef(inputs.base.trim()) ||
                !isSafeRef(inputs.head.trim())
              }
            >
              {tr(locale, busy.compare ? 'loading' : 'compare')}
            </button>
          </form>
          {Object.entries(errors).some(([, v]) => v) && <p role="alert">{tr(locale, 'failed')}</p>}
          {(busy.pr || busy.changes || busy.patch) && <p role="status">{tr(locale, 'loading')}</p>}
          {pr && (
            <section className="agg-diag-section">
              <h3>
                PR #{pr.number} · {pr.title}
              </h3>
              <p>
                {pr.state}
                {pr.draft ? ` · ${tr(locale, 'draft')}` : ''}
              </p>
              <p>
                Base:{' '}
                <code>
                  {pr.base.repo} · {pr.base.name} · {pr.base.sha}
                </code>
              </p>
              <p>
                Head:{' '}
                <code>
                  {pr.head.repo} · {pr.head.name} · {pr.head.sha}
                </code>
              </p>
              <small>
                {tr(locale, 'observed')}: {time(pr.observedAt)}
              </small>
              <p>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  {tr(locale, 'github')}
                </a>
              </p>
              <button
                type="button"
                onClick={() => {
                  setInputs({ base: pr.base.name, head: pr.head.name });
                  setPins({ base: pr.base, head: pr.head });
                }}
              >
                {tr(locale, 'usePr')}
              </button>
            </section>
          )}
          {comparison && (
            <section className="agg-diag-section">
              <h3>{tr(locale, 'compare')}</h3>
              <dl className="agg-diag-facts">
                <dt>Base SHA</dt>
                <dd>
                  <code>
                    {comparison.base.repo} {comparison.base.name} ·{' '}
                    {comparison.base.sha || 'unknown'}
                  </code>
                </dd>
                <dt>Head SHA</dt>
                <dd>
                  <code>
                    {comparison.head.repo} {comparison.head.name} ·{' '}
                    {comparison.head.sha || 'unknown'}
                  </code>
                </dd>
                <dt>{tr(locale, 'mergeBase')}</dt>
                <dd>
                  <code>{comparison.mergeBase ?? 'unknown'}</code>
                </dd>
                <dt>{tr(locale, 'ahead')}</dt>
                <dd>{comparison.ahead ?? tr(locale, 'unknown')}</dd>
                <dt>{tr(locale, 'behind')}</dt>
                <dd>{comparison.behind ?? tr(locale, 'unknown')}</dd>
                <dt>{tr(locale, 'ancestor')}</dt>
                <dd>{tr(locale, comparison.ancestor)}</dd>
                <dt>{tr(locale, 'observed')}</dt>
                <dd>{time(comparison.observedAt)}</dd>
                <dt>Commits</dt>
                <dd>
                  <CoverageText value={comparison.commitsCoverage} locale={locale} />
                </dd>
              </dl>
              <p>{tr(locale, 'note')}</p>
              <h4>Head-only commits</h4>
              {commitRows(comparison.headCommits, comparison.head.repo)}
              <h4>Base-only commits</h4>
              {commitRows(comparison.baseCommits, comparison.base.repo)}
              <h4>{tr(locale, 'files')}</h4>
              <p>{tr(locale, 'semantics')}</p>
              {fileRows(
                comparison.files,
                comparison.filesCoverage,
                comparison.mergeBase,
                comparison.head.sha,
                Boolean(comparison.mergeBase),
                comparison.head.repo,
              )}
              <p>
                {githubUrl && (
                  <a href={githubUrl} target="_blank" rel="noreferrer">
                    {tr(locale, 'github')}
                  </a>
                )}
              </p>
              <button
                type="button"
                onClick={() =>
                  void (async () => {
                    const value = JSON.stringify(
                      {
                        source: layout.coverage?.source ?? 'unknown',
                        repo: layout.repo.url ?? `${layout.repo.owner}/${layout.repo.name}`,
                        base: comparison.base,
                        head: comparison.head,
                        mergeBase: comparison.mergeBase,
                        ancestor: comparison.ancestor,
                        ahead: comparison.ahead,
                        behind: comparison.behind,
                        semantics: comparison.semantics,
                        observedAt: time(comparison.observedAt),
                        commitsCoverage: comparison.commitsCoverage,
                        filesCoverage: comparison.filesCoverage,
                        link: githubUrl,
                        note: tr(locale, 'note'),
                      },
                      null,
                      2,
                    );
                    setCopy((await copyText(value)) ? 'copied' : 'copyFailed');
                  })()
                }
              >
                {tr(locale, copy)}
              </button>
            </section>
          )}
          <section className="agg-diag-section">
            <h3>{tr(locale, 'selected')}</h3>
            {!target && <p>{tr(locale, 'select')}</p>}
            {changes && (
              <>
                <p>
                  <code>{changes.sha}</code>
                </p>
                {changes.parents.length > 0 ? (
                  <label>
                    {tr(locale, 'parent')}
                    <select
                      aria-label={tr(locale, 'parent')}
                      value={changes.parentSha ?? ''}
                      onChange={(e) => setParent({ sha: target!, value: e.target.value })}
                    >
                      {changes.parents.map((p, i) => (
                        <option value={p} key={p}>
                          {p}
                          {i === 0 ? ' · first parent' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p>{tr(locale, 'root')}</p>
                )}
                <p>
                  parent → commit:{' '}
                  <code>
                    {changes.parentSha ?? 'empty tree'} → {changes.sha}
                  </code>
                </p>
                <small>
                  {tr(locale, 'observed')}: {time(changes.observedAt)}
                </small>
                {fileRows(
                  changes.files,
                  changes.filesCoverage,
                  changes.parentSha,
                  changes.sha,
                  true,
                  inspection?.repo,
                )}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
