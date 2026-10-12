import { type DiagnosticAdapter, type DiagnosticRequest } from '@adorable/graph-core';
import { sendToBackground, type BgResponse } from '../shared/messages';
import type { RepoRef } from '../shared/repo';

/** Only background accesses the token. Content receives diagnostic data, never credentials. */
export function createExtensionAdapter(repo: RepoRef, generation?: string): DiagnosticAdapter {
  const request = <T>(query: DiagnosticRequest, signal?: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      if (!generation) {
        reject(new Error('source_changed'));
        return;
      }
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void sendToBackground({ type: 'diagnostic-cancel', requestId }).catch(() => {});
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      sendToBackground<BgResponse<T>>({
        type: 'diagnostic',
        owner: repo.owner,
        repo: repo.repo,
        requestId,
        generation,
        query,
      })
        .then((response) => {
          if (signal?.aborted) return;
          if (response?.ok) resolve(response.data);
          else reject(new Error(response?.error.code ?? 'diagnostic_unavailable'));
        }, reject)
        .finally(() => signal?.removeEventListener('abort', cancel));
    });
  // Every operation reaches the auth barrier, including immutable cache hits in background.
  return {
    context: { commit: repo.commit, pullRequest: repo.pullRequest },
    compare: (base, head, signal) => request({ operation: 'compare', base, head }, signal),
    changes: (sha, parent, signal, commitRepo) =>
      request({ operation: 'changes', sha, parent, commitRepo }, signal),
    patch: (base, head, path, previousPath, signal, headRepo) =>
      request({ operation: 'patch', base, head, path, previousPath, headRepo }, signal),
    pullRequest: (number, signal) => request({ operation: 'pull-request', number }, signal),
  };
}
