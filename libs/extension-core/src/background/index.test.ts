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
  options: {
    get?: (key: string | null) => Promise<Data>;
    set?: (values: Data) => Promise<unknown>;
    notify?: () => Promise<void>;
  } = {},
) {
  let message: ((req: unknown, sender: unknown, reply: (data: any) => void) => boolean) | undefined;
  let changed: ((changes: unknown, area: string) => void) | undefined;
  const sent: unknown[] = [];
  const call = (req: unknown) =>
    new Promise<any>((resolve) => {
      message!(req, { id: 'fixture-extension', tab: { id: 7 } }, resolve);
    });
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
      sendMessage: call,
    },
    storage: {
      local: {
        get:
          options.get ??
          (async (key: string | null) => (key === null ? { ...store } : { [key]: store[key] })),
        set: options.set ?? (async (values: Data) => Object.assign(store, values)),
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
        await options.notify?.();
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
    call,
  };
}
const graph = (name: string) => ({
  repo: { owner: 'o', name, defaultBranch: 'main' },
  commits: [],
  refs: [],
  fetchedAt: Date.now(),
});
const cacheKey = 'cache:o/r##5x60';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function actualGraphFixture(holdOldRepo = false) {
  const actual =
    await vi.importActual<typeof import('@adorable/graph-core')>('@adorable/graph-core');
  mocks.fetch.mockImplementation(actual.fetchGitHubGraph);
  const oldGate = deferred(),
    repoStarts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      const old = auth === 'Bearer fixture-old-token',
        label = old ? 'old-private' : 'fresh-public';
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      if (path === '/repos/o/r') {
        repoStarts.push(auth);
        if (old && holdOldRepo) await oldGate.promise;
        return json({ name: 'r', default_branch: 'main', owner: { login: 'o' } });
      }
      if (path === '/repos/o/r/branches') return json([{ name: 'main', commit: { sha } }]);
      if (path === '/repos/o/r/pulls' || path === '/repos/o/r/tags') return json([]);
      if (path === '/repos/o/r/commits')
        return json([{ sha, parents: [], commit: { message: label } }]);
      throw new Error('Unexpected fixture path: ' + path);
    }),
  );
  return { repoStarts, releaseOld: oldGate.resolve };
}
const graphRequest = { type: 'fetch-graph', owner: 'o', repo: 'r' } as const;
describe('graph consumer authorization barriers', () => {
  it('still coalesces same-scope consumers after each has read settings', async () => {
    const fixture = await actualGraphFixture(true);
    const store: Data = { settings: { token: 'fixture-old-token', cacheMinutes: 0 } };
    let reads = 0;
    const h = await harness(store, undefined, {
      get: async (key) => {
        if (key === 'settings') reads++;
        return key === null ? { ...store } : { [key]: store[key] };
      },
    });
    const first = h.call(graphRequest);
    try {
      await vi.waitFor(() => expect(fixture.repoStarts).toHaveLength(1));
      const second = h.call(graphRequest);
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
      expect(fixture.repoStarts).toHaveLength(1);
      fixture.releaseOld();
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.data.diagnosticGeneration).toBe(b.data.diagnosticGeneration);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    } finally {
      fixture.releaseOld();
    }
  });
  it('removes a late old cache write after the new scope has cleared and answered', async () => {
    const fixture = await actualGraphFixture(),
      writeGate = deferred();
    const store: Data = { settings: { token: 'fixture-old-token' } };
    let oldWriteStarted = false;
    const h = await harness(store, undefined, {
      set: async (values) => {
        const entry = values[cacheKey] as { graph: { commits: { message: string }[] } } | undefined;
        if (entry?.graph.commits[0]?.message === 'old-private') {
          oldWriteStarted = true;
          await writeGate.promise;
        }
        Object.assign(store, values);
      },
    });
    const old = h.call(graphRequest);
    try {
      await vi.waitFor(() => expect(oldWriteStarted).toBe(true));
      store.settings = { token: '' };
      const fresh = await h.call(graphRequest);
      expect(fresh.ok).toBe(true);
      expect(fresh.data.graph.commits[0].message).toBe('fresh-public');
      writeGate.resolve();
      expect(await old).toMatchObject({ ok: false, error: { code: 'source_changed' } });
      expect(store[cacheKey]).toBeUndefined();
      expect(fixture.repoStarts).toHaveLength(2);
    } finally {
      writeGate.resolve();
    }
  });
  it('does not let one consumer deadline abort the shared graph producer', async () => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    const fixture = await actualGraphFixture(true);
    const store: Data = { settings: { token: 'fixture-old-token', cacheMinutes: 0 } };
    const h = await harness(store),
      first = h.call(graphRequest);
    try {
      await vi.waitFor(() => expect(fixture.repoStarts).toHaveLength(1));
      const second = h.call(graphRequest);
      await vi.waitFor(() => expect(deadlines).toHaveLength(3));
      const producerSignal = mocks.fetch.mock.calls[0]![2].signal as AbortSignal;
      deadlines[0]!.abort(new DOMException('Fixture deadline', 'TimeoutError'));
      expect(await first).toMatchObject({
        ok: false,
        error: { code: 'network', message: 'Query timed out' },
      });
      expect(producerSignal.aborted).toBe(false);
      fixture.releaseOld();
      expect((await second).ok).toBe(true);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    } finally {
      fixture.releaseOld();
      timeout.mockRestore();
    }
  });
  it.each(['fixture-new-token', ''])(
    'does not coalesce a pending old-token graph after storage changes to %s',
    async (nextToken) => {
      const fixture = await actualGraphFixture(true);
      const store: Data = { settings: { token: 'fixture-old-token' } };
      const h = await harness(store),
        old = h.call(graphRequest);
      try {
        await vi.waitFor(() => expect(fixture.repoStarts).toHaveLength(1));
        store.settings = { token: nextToken }; // deliberately no onChanged
        const next = h.call(graphRequest);
        await vi.waitFor(() => expect(fixture.repoStarts).toHaveLength(2));
        const fresh = await next;
        expect(fresh.ok).toBe(true);
        expect(fresh.data.graph.commits[0].message).toBe('fresh-public');
        expect(fixture.repoStarts[1]).toBe(nextToken ? 'Bearer ' + nextToken : '');
        fixture.releaseOld();
        expect(await old).toMatchObject({ ok: false, error: { code: 'source_changed' } });
        expect(JSON.stringify(store[cacheKey] ?? null)).not.toContain('old-private');
        expect(JSON.stringify(fresh)).not.toMatch(/fixture-.*token|credentialScope/);
      } finally {
        fixture.releaseOld();
      }
    },
  );
  it('rejects a lone late producer after an unnotified storage change', async () => {
    const fixture = await actualGraphFixture(true);
    const store: Data = { settings: { token: 'fixture-old-token' } },
      h = await harness(store);
    const old = h.call(graphRequest);
    try {
      await vi.waitFor(() => expect(fixture.repoStarts).toHaveLength(1));
      store.settings = { token: '' };
      fixture.releaseOld();
      expect(await old).toMatchObject({ ok: false, error: { code: 'source_changed' } });
      expect(store[cacheKey]).toBeUndefined();
      expect(fixture.repoStarts).toHaveLength(1);
    } finally {
      fixture.releaseOld();
    }
  });
  it('rejects an old cache snapshot when storage changes during its read', async () => {
    const fixture = await actualGraphFixture(),
      cacheGate = deferred();
    const store: Data = { settings: { token: 'fixture-old-token' } };
    let holdCache = false,
      cacheReadStarted = false;
    const h = await harness(store, undefined, {
      get: async (key) => {
        const snapshot = key === null ? { ...store } : { [key]: store[key] };
        if (key === cacheKey && holdCache) {
          holdCache = false;
          cacheReadStarted = true;
          await cacheGate.promise;
        }
        return snapshot;
      },
    });
    const warm = await h.call(graphRequest);
    expect(warm.data.graph.commits[0].message).toBe('old-private');
    holdCache = true;
    const pending = h.call(graphRequest);
    try {
      await vi.waitFor(() => expect(cacheReadStarted).toBe(true));
      store.settings = { token: '' };
      cacheGate.resolve();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'source_changed' } });
      const fresh = await h.call(graphRequest);
      expect(fresh.data.graph.commits[0].message).toBe('fresh-public');
      expect(fresh.data.fromCache).toBe(false);
      expect(fresh.data.diagnosticGeneration).not.toBe(warm.data.diagnosticGeneration);
      expect(fixture.repoStarts).toHaveLength(2);
    } finally {
      cacheGate.resolve();
    }
  });
});
const complete = { status: 'complete', reasons: [], loaded: 1, total: 1 };
const sha = 'a'.repeat(40);
const parent = 'b'.repeat(40);
function provider(label: string) {
  return {
    pullRequest: vi.fn().mockResolvedValue({ label, number: 5 }),
    compare: vi.fn().mockResolvedValue({ label }),
    changes: vi.fn().mockResolvedValue({
      sha,
      parents: [parent],
      parentSha: parent,
      files: [
        { path: `${label}.txt`, status: 'modified', additions: 1, deletions: 0, binary: false },
      ],
      filesCoverage: complete,
      observedAt: Date.now(),
    }),
    patch: vi.fn().mockResolvedValue({
      baseSha: parent,
      headSha: sha,
      path: 'x',
      patch: `${label}-content`,
      binary: false,
      coverage: complete,
      observedAt: Date.now(),
    }),
  };
}
describe('background credential scope and fork diagnostics', () => {
  it.each(
    (['compare', 'changes', 'patch', 'pullRequest'] as const).flatMap((operation) =>
      ['fixture-new-token', ''].map((nextToken) => ({ operation, nextToken })),
    ),
  )(
    'rejects pending $operation after unnotified storage change to "$nextToken"',
    async ({ operation, nextToken }) => {
      const old = provider('old-private'),
        fresh = provider('new-public'),
        gate = deferred();
      const original = old[operation].getMockImplementation()!;
      old[operation].mockImplementationOnce(async () => {
        await gate.promise; // The provider deliberately ignores abort.
        return original();
      });
      const store: Data = { settings: { token: 'fixture-old-token', cacheMinutes: 0 } };
      const h = await harness(store);
      mocks.fetch.mockResolvedValue(graph('r'));
      mocks.diagnostics.mockImplementation((_o, _r, options) =>
        options.token === 'fixture-old-token' ? old : fresh,
      );
      const first = await h.call(graphRequest);
      const queries = {
        compare: { operation: 'compare', base: 'main', head: 'topic' },
        changes: { operation: 'changes', sha },
        patch: { operation: 'patch', base: parent, head: sha, path: 'x' },
        pullRequest: { operation: 'pull-request', number: 5 },
      } as const;
      const request = (requestId: string, generation: string) =>
        h.call({
          type: 'diagnostic',
          owner: 'o',
          repo: 'r',
          requestId,
          generation,
          query: queries[operation],
        });
      const pending = request('pending-private', first.data.diagnosticGeneration);
      try {
        await vi.waitFor(() => expect(old[operation]).toHaveBeenCalledTimes(1));
        store.settings = { token: nextToken }; // No notification or second consumer.
        gate.resolve();
        expect(await pending).toMatchObject({ ok: false, error: { code: 'source_changed' } });
        const next = await h.call(graphRequest);
        expect(next.ok).toBe(true);
        expect(next.data.diagnosticGeneration).not.toBe(first.data.diagnosticGeneration);
        const result = await request('fresh-observation', next.data.diagnosticGeneration);
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).toContain('new-public');
        expect(JSON.stringify(result)).not.toMatch(/old-private|fixture-.*token|credentialScope/);
        expect(fresh[operation]).toHaveBeenCalledTimes(1);
        expect(mocks.diagnostics.mock.calls.at(-1)![2].token).toBe(nextToken || undefined);
      } finally {
        gate.resolve();
      }
    },
  );
  it('never mixes warmed changes or patches with a new-token comparison during delayed clearing', async () => {
    const old = provider('old-private'),
      fresh = provider('new-public');
    const store: Data = { settings: { token: 'fixture-old-token' } };
    let release = () => {};
    let clearing = false;
    const h = await harness(store, async (keys) => {
      clearing = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      keys.forEach((k) => delete store[k]);
    });
    mocks.fetch.mockResolvedValue(graph('r'));
    mocks.diagnostics.mockImplementation((_o, _r, options) =>
      options.token === 'fixture-old-token' ? old : fresh,
    );
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    const { createExtensionAdapter } = await import('../content/diagnostics');
    const adapter = createExtensionAdapter(
      { owner: 'o', repo: 'r' },
      first.data.diagnosticGeneration,
    );
    await adapter.changes(sha);
    await adapter.patch(parent, sha, 'x');
    await adapter.changes(sha);
    await adapter.patch(parent, sha, 'x');
    expect(old.changes).toHaveBeenCalledTimes(1);
    expect(old.patch).toHaveBeenCalledTimes(1);
    try {
      store.settings = { token: 'fixture-new-token' };
      h.changed({ newValue: store.settings });
      await vi.waitFor(() => expect(clearing).toBe(true));
      const results = await Promise.allSettled([
        adapter.compare('main', 'topic'),
        adapter.changes(sha),
        adapter.patch(parent, sha, 'x'),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(fresh.compare).not.toHaveBeenCalled();
      expect(fresh.changes).not.toHaveBeenCalled();
      expect(fresh.patch).not.toHaveBeenCalled();
      expect(h.sent).toContainEqual({ type: 'data-invalidated' });
      release();
      const next = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
      expect(next.data.diagnosticGeneration).not.toBe(first.data.diagnosticGeneration);
      const nextAdapter = createExtensionAdapter(
        { owner: 'o', repo: 'r' },
        next.data.diagnosticGeneration,
      );
      expect((await nextAdapter.changes(sha)).files[0]!.path).toBe('new-public.txt');
      expect((await nextAdapter.patch(parent, sha, 'x')).patch).toBe('new-public-content');
      expect(JSON.stringify(next)).not.toMatch(/fixture-(old|new)-token|credentialScope/);
    } finally {
      release();
    }
  });
  it('rejects old graph generation when settings change before the storage notification', async () => {
    const old = provider('old-private'),
      fresh = provider('new-public');
    const store: Data = { settings: { token: 'fixture-old-token' } };
    const h = await harness(store);
    mocks.fetch.mockResolvedValue(graph('r'));
    mocks.diagnostics.mockImplementation((_o, _r, options) =>
      options.token === 'fixture-old-token' ? old : fresh,
    );
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    store.settings = { token: 'fixture-new-token' };
    const result = await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'old-observation',
      generation: first.data.diagnosticGeneration,
      query: { operation: 'compare', base: 'main', head: 'topic' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    expect(fresh.compare).not.toHaveBeenCalled();
    const next = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect(next.data.diagnosticGeneration).not.toBe(first.data.diagnosticGeneration);
    h.changed({ newValue: { token: 'fixture-old-token' } });
    const afterDelayedEvent = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'latest-observation',
      generation: afterDelayedEvent.data.diagnosticGeneration,
      query: { operation: 'compare', base: 'main', head: 'topic' },
    });
    expect(mocks.diagnostics.mock.calls.at(-1)![2].token).toBe('fixture-new-token');
  });
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
    expect(h.sent).toContainEqual({ type: 'data-invalidated' });
    release();
    const result = await pending;
    expect(result.data).toMatchObject({ graph: fresh, fromCache: false });
    expect(JSON.stringify(result)).not.toContain('old-private');
    expect(mocks.fetch.mock.calls[0]![2].token).toBeUndefined();
  });
  it('serializes delayed settings observations and never adopts a delayed event payload', async () => {
    const store: Data = { settings: { token: 'fixture-old-token' } };
    let block = false,
      reads = 0,
      release = () => {};
    const h = await harness(store, undefined, {
      get: async (key) => {
        const value = key === null ? { ...store } : { [key]: store[key] };
        if (key === 'settings') {
          reads++;
          if (block) {
            block = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        }
        return value;
      },
    });
    mocks.fetch.mockResolvedValue(graph('r'));
    const p = provider('private');
    mocks.diagnostics.mockReturnValue(p);
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    const readsBeforeBlock = reads;
    block = true;
    const oldRequest = h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'delayed-read',
      generation: first.data.diagnosticGeneration,
      query: { operation: 'compare', base: 'main', head: 'topic' },
    });
    await vi.waitFor(() => expect(reads).toBe(readsBeforeBlock + 1));
    store.settings = { token: 'fixture-new-token' };
    const freshGraph = h.call({ type: 'fetch-graph', owner: 'o', repo: 'r', force: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(readsBeforeBlock + 1);
    release();
    const newGraph = await freshGraph;
    expect(newGraph.ok).toBe(true);
    expect((await oldRequest).ok).toBe(false);
    store.settings = { token: 'fixture-third-token' };
    const third = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r', force: true });
    h.changed({ newValue: { token: 'fixture-new-token' } });
    const afterEvent = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'latest-read',
      generation: afterEvent.data.diagnosticGeneration,
      query: { operation: 'compare', base: 'main', head: 'topic' },
    });
    expect(mocks.diagnostics.mock.calls.at(-1)![2].token).toBe('fixture-third-token');
    expect(third.data.diagnosticGeneration).not.toBe(newGraph.data.diagnosticGeneration);
  });
  it('rejects an in-flight result even when the provider ignores abort', async () => {
    const store: Data = { settings: { token: 'fixture-old-token' } };
    const h = await harness(store);
    mocks.fetch.mockResolvedValue(graph('r'));
    let release = () => {};
    const p = provider('old-private');
    p.compare.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ label: 'old-private' });
        }),
    );
    mocks.diagnostics.mockReturnValue(p);
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    const pending = h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'pending-private',
      generation: first.data.diagnosticGeneration,
      query: { operation: 'compare', base: 'main', head: 'topic' },
    });
    await vi.waitFor(() => expect(p.compare).toHaveBeenCalledTimes(1));
    store.settings = { token: 'fixture-new-token' };
    h.changed({ newValue: store.settings });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    release();
  });
  it('cancels one request without poisoning a reused adapter and rejects an aborted cache read', async () => {
    const h = await harness({ settings: { token: '' } });
    mocks.fetch.mockResolvedValue(graph('r'));
    const p = provider('public');
    let release = () => {};
    p.changes.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sha, filesCoverage: complete });
        }),
    );
    mocks.diagnostics.mockReturnValue(p);
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    const request = (requestId: string) =>
      h.call({
        type: 'diagnostic',
        owner: 'o',
        repo: 'r',
        requestId,
        generation: first.data.diagnosticGeneration,
        query: { operation: 'changes', sha },
      });
    const pending = request('cancel-me');
    await vi.waitFor(() => expect(p.changes).toHaveBeenCalledTimes(1));
    await h.call({ type: 'diagnostic-cancel', requestId: 'cancel-me' });
    expect((await pending).ok).toBe(false);
    release();
    expect((await request('next-request')).ok).toBe(true);
    expect(mocks.diagnostics).toHaveBeenCalledTimes(1);
    expect(mocks.diagnostics.mock.calls[0]![2].signal).toBeUndefined();
    const { createExtensionAdapter } = await import('../content/diagnostics');
    const adapter = createExtensionAdapter(
      { owner: 'o', repo: 'r' },
      first.data.diagnosticGeneration,
    );
    await adapter.changes(sha);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.changes(sha, undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(p.changes).toHaveBeenCalledTimes(2);
  });
  it('fences restarted backgrounds, deduplicates recovery, and keeps legacy requests out of loops', async () => {
    const store: Data = { settings: { token: '' } };
    mocks.fetch.mockResolvedValue(graph('r'));
    mocks.diagnostics.mockReturnValue(provider('public'));
    const firstHost = await harness(store);
    const first = await firstHost.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    vi.resetModules();
    const nextHost = await harness(store);
    const old = (requestId: string, generation?: string) =>
      nextHost.call({
        type: 'diagnostic',
        owner: 'o',
        repo: 'r',
        requestId,
        generation,
        query: { operation: 'changes', sha },
      });
    expect((await old('old-one', first.data.diagnosticGeneration)).error.code).toBe(
      'source_changed',
    );
    expect((await old('old-two', first.data.diagnosticGeneration)).error.code).toBe(
      'source_changed',
    );
    expect((await old('legacy')).error.code).toBe('source_changed');
    await vi.waitFor(() => expect(nextHost.sent).toHaveLength(1));
    const next = await nextHost.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect(next.data.diagnosticGeneration).not.toBe(first.data.diagnosticGeneration);
    expect((await old('new', next.data.diagnosticGeneration)).ok).toBe(true);
  });
  it('fails closed for diagnostic cache reads until failed clearing is explicitly retried', async () => {
    let fail = true;
    const store: Data = { settings: { token: '' } };
    const h = await harness(store, async (keys) => {
      if (fail) throw new Error('fixture removal failure');
      keys.forEach((key) => delete store[key]);
    });
    mocks.fetch.mockResolvedValue(graph('r'));
    const p = provider('public');
    mocks.diagnostics.mockReturnValue(p);
    const first = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    expect((await h.call({ type: 'clear-cache' })).ok).toBe(false);
    const request = () =>
      h.call({
        type: 'diagnostic',
        owner: 'o',
        repo: 'r',
        requestId: 'cache-barrier',
        generation: first.data.diagnosticGeneration,
        query: { operation: 'compare', base: 'main', head: 'topic' },
      });
    expect((await request()).ok).toBe(false);
    expect(p.compare).not.toHaveBeenCalled();
    fail = false;
    await h.call({ type: 'clear-cache' });
    expect((await request()).ok).toBe(true);
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
    const changes = vi.fn().mockResolvedValue({ sha, filesCoverage: complete }),
      patch = vi.fn().mockResolvedValue({ patch: null, coverage: complete });
    mocks.diagnostics.mockReturnValue({ changes, patch });
    const h = await harness({ settings: { token: 'fixture-token' } });
    mocks.fetch.mockResolvedValue(graph('r'));
    const initial = await h.call({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'fixture-1',
      generation: initial.data.diagnosticGeneration,
      query: { operation: 'changes', sha: 'a'.repeat(40), commitRepo: 'fork/r' },
    });
    await h.call({
      type: 'diagnostic',
      owner: 'o',
      repo: 'r',
      requestId: 'fixture-2',
      generation: initial.data.diagnosticGeneration,
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
    expect(mocks.diagnostics).toHaveBeenCalledTimes(1);
  });
});
