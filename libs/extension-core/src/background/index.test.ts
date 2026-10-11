const webcrypto = globalThis.crypto;
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), diagnostics: vi.fn() }));
vi.mock('@adorable/graph-core', async (original) => ({
  ...(await original<typeof import('@adorable/graph-core')>()),
  fetchGitHubGraph: mocks.fetch,
  createGitHubDiagnostics: mocks.diagnostics,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});
type Data = Record<string, unknown>;
async function harness(
  store: Data,
  remove: (keys: string[]) => Promise<void> = async (keys) => {
    keys.forEach((k) => delete store[k]);
  },
) {
  let message: ((req: unknown, sender: unknown, reply: (data: any) => void) => boolean) | undefined;
  let changed: ((changes: unknown, area: string) => void) | undefined;
  const sent: unknown[] = [];
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('__AGG_API_BASE__', 'https://api.github.com');
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'fixture-extension',
      onMessage: {
        addListener: (fn: typeof message) => {
          message = fn;
        },
      },
      openOptionsPage: vi.fn(),
    },
    storage: {
      local: {
        get: async (key: string | null) => (key === null ? { ...store } : { [key]: store[key] }),
        set: async (values: Data) => Object.assign(store, values),
        remove,
      },
      onChanged: {
        addListener: (fn: typeof changed) => {
          changed = fn;
        },
      },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (_id: number, value: unknown) => {
        sent.push(value);
      },
    },
    action: {
      onClicked: { addListener: vi.fn() },
      setBadgeBackgroundColor: vi.fn(),
      setBadgeText: vi.fn(),
    },
  });
  await import('./index.ts');
  return {
    sent,
    changed: (settings: unknown) => changed!({ settings }, 'local'),
    call: (req: unknown) =>
      new Promise<any>((resolve) => {
        message!(req, { id: 'fixture-extension', tab: { id: 7 } }, resolve);
      }),
  };
}
const graph = (name: string) => ({
  repo: { owner: 'o', name, defaultBranch: 'main' },
  commits: [],
  refs: [],
  fetchedAt: Date.now(),
});
const cacheKey = 'cache:o/r##5x60';
describe('background credential scope and fork diagnostics', () => {
  it('waits for delayed invalidation and never returns an old-token private graph', async () => {
    const old = graph('old-private'),
      fresh = graph('new-public'),
      store: Data = {
        settings: { token: 'fixture-old-token' },
        [cacheKey]: { graph: old, savedAt: Date.now(), credentialScope: 'old-scope' },
      };
    let release: () => void = () => {};
    let clearing = false;
    const h = await harness(store, async (keys) => {
      clearing = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      keys.forEach((k) => delete store[k]);
    });
    mocks.fetch.mockResolvedValue(fresh);
    store.settings = { token: '' };
    h.changed({});
    const pending = h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    await vi.waitFor(() => expect(clearing).toBe(true));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    release();
    const result = await pending;
    expect(result.data).toEqual({ graph: fresh, fromCache: false });
    expect(JSON.stringify(result)).not.toContain('old-private');
    expect(mocks.fetch.mock.calls[0]![2].token).toBeUndefined();
  });
  it('refuses legacy or wrong-scope cache entries even after background restart', async () => {
    const store: Data = {
      settings: { token: '' },
      [cacheKey]: { savedAt: Date.now(), graph: graph('old-private') },
    };
    const fresh = graph('fresh');
    mocks.fetch.mockResolvedValue(fresh);
    const h = await harness(store);
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect(first.data.fromCache).toBe(false);
    const second = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect(second.data.fromCache).toBe(true);
    expect(second.data.graph.repo.name).toBe('fresh');
    expect(JSON.stringify(second)).not.toContain('credentialScope');
  });
  it('fails closed when invalidation fails and recovers on an explicit cache retry', async () => {
    let fail = true;
    const store: Data = {
      settings: { token: '' },
      [cacheKey]: { savedAt: Date.now(), graph: graph('old-private') },
    };
    const h = await harness(store, async (keys) => {
      if (fail) throw new Error('fixture removal failure');
      keys.forEach((k) => delete store[k]);
    });
    mocks.fetch.mockResolvedValue(graph('fresh'));
    h.changed({});
    const denied = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect(denied.ok).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'data-invalidated' }));
    fail = false;
    expect((await h.call({ type: 'clear-cache' })).ok).toBe(true);
    expect((await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' })).ok).toBe(true);
  });
  it('preserves explicit fork repo across independent changes and patch requests', async () => {
    const changes = vi.fn().mockResolvedValue({ sha: 'a'.repeat(40) }),
      patch = vi.fn().mockResolvedValue({ patch: null });
    mocks.diagnostics.mockReturnValue({ changes, patch });
    const h = await harness({ settings: { token: 'fixture-token' } });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'fixture-1',
      query: { operation: 'changes', sha: 'a'.repeat(40), commitRepo: 'fork/r' },
    });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'fixture-2',
      query: {
        operation: 'patch',
        base: 'b'.repeat(40),
        head: 'a'.repeat(40),
        path: 'x',
        headRepo: 'fork/r',
      },
    });
    expect(changes.mock.calls[0]![3]).toBe('fork/r');
    expect(patch.mock.calls[0]![5]).toBe('fork/r');
    expect(mocks.diagnostics).toHaveBeenCalledTimes(2);
  });
});
