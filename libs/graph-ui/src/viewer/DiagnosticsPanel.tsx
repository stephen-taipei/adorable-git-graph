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
import { getCatalog } from '../i18n';
import type { Catalog, Locale } from '../i18n';
import { copyText } from './format';

type Key = Exclude<keyof Catalog['diag'], 'reasonLabels'>;
const tr = (loc: Locale, key: Key) => getCatalog(loc).diag[key];
const time = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? new Date(value).toISOString() : 'unknown';
const reasonLabel = (loc: Locale, reason: string): string | undefined =>
  (getCatalog(loc).diag.reasonLabels as Record<string, string>)[reason];
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
              <li key={i}>{reasonLabel(locale, reason) ?? tr(locale, 'incomplete')}</li>
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
      {layout.truncated && <span>{tr(locale, 'historyTruncated')}</span>}
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
export interface CommitInspection {
  sha: string;
  repo?: string;
}
export interface DiagnosticsPanelProps {
  scope: object;
  open: boolean;
  adapter?: DiagnosticAdapter;
  layout: GraphLayout;
  selectedSha?: string | null;
  selectionRevision?: number;
  inspection?: CommitInspection;
  onInspectionChange: (inspection?: CommitInspection) => void;
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
  inspection,
  onInspectionChange,
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
                onGoto(c.sha);
              } else onInspectionChange({ sha: c.sha, repo: commitRepo });
            }}
          >
            <code>{c.sha}</code>
          </button>{' '}
          {c.subject}
          {layout.repo.url?.startsWith('https://github.com/') && (
            <a
              href={
                commitRepo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(commitRepo)
                  ? `https://github.com/${commitRepo}/commit/${c.sha}`
                  : `${layout.repo.url}/commit/${c.sha}`
              }
              target="_blank"
              rel="noreferrer"
            >
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
