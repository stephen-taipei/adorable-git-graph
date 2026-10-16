import type { DiagnosticAdapter, DiagnosticRequest } from '@adorable/graph-core';
import { DIAGNOSTICS_ENDPOINT } from '@adorable/git-local/protocol';

/** No filesystem paths or GitHub credentials cross the local diagnostic protocol. */
export function createLocalAdapter(repo: string): DiagnosticAdapter {
  const request = async <T>(body: DiagnosticRequest, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, repo }),
      signal,
    });
    if (!response.ok)
      throw new Error(response.status === 403 ? 'local_only' : 'diagnostic_unavailable');
    return response.json() as Promise<T>;
  };
  return {
    compare: (base, head, signal) => request({ operation: 'compare', base, head }, signal),
    changes: (sha, parent, signal) =>
      request({ operation: 'changes', sha, ...(parent ? { parent } : {}) }, signal),
    patch: (base, head, path, previousPath, signal) =>
      request(
        { operation: 'patch', base, head, path, ...(previousPath ? { previousPath } : {}) },
        signal,
      ),
  };
}
