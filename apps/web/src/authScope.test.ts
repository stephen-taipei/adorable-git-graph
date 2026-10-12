import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_KEY,
  SCOPE_KEY,
  TOKEN_KEY,
  initialAuth,
  opaqueId,
  readShared,
  saveCredential,
  syncAuth,
} from './authScope';
import type { AuthStores } from './authScope';

type Op = 'get' | 'set' | 'remove';

class FakeStorage implements Storage {
  readonly data = new Map<string, string>();
  readonly log: string[] = [];
  fail: (op: Op, key: string) => boolean = () => false;
  onGet?: (key: string) => void;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(key: string) {
    if (this.fail('get', key)) throw new Error('blocked');
    this.onGet?.(key);
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.fail('set', key)) throw new Error('blocked');
    this.log.push(`set ${key}`);
    this.data.set(key, value);
  }
  removeItem(key: string) {
    if (this.fail('remove', key)) throw new Error('blocked');
    this.log.push(`remove ${key}`);
    this.data.delete(key);
  }
}

/** Two tabs of one origin: shared localStorage, own sessionStorage. */
function origin() {
  const local = new FakeStorage();
  const tab = () => {
    const session = new FakeStorage();
    return { local: () => local, session: () => session } satisfies AuthStores;
  };
  return { local, tab };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('opaqueId', () => {
  it('works where only getRandomValues exists (plain-HTTP LAN page)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) });
    expect('randomUUID' in globalThis.crypto).toBe(false);
    const ids = new Set(Array.from({ length: 64 }, opaqueId));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('still returns an ID without any Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(opaqueId()).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('initialAuth', () => {
  it('restores the same tab scope on reload under the same credential', () => {
    const { local, tab } = origin();
    local.data.set(TOKEN_KEY, 'token-a');
    const a = tab();
    const first = initialAuth(a);
    expect(first).toMatchObject({ token: 'token-a', generation: '', tokenReadable: true });
    expect(initialAuth(a).nonce).toBe(first.nonce);
  });

  it('never restores a scope after another tab changed or cleared the credential', () => {
    for (const next of ['token-b', '']) {
      const { local, tab } = origin();
      local.data.set(TOKEN_KEY, 'token-a');
      const a = tab(),
        b = tab();
      const before = initialAuth(a);
      expect(saveCredential(initialAuth(b), next, b)).not.toBeNull();
      const after = initialAuth(a);
      expect(after.token).toBe(next);
      expect(after.nonce).not.toBe(before.nonce);
    }
  });

  it('ignores scope values of earlier builds', () => {
    const { tab } = origin();
    const a = tab();
    a.session().data.set(SCOPE_KEY, '0f6a7a4e-63f8-4e0e-9e0d-1f2d3c4b5a69');
    const auth = initialAuth(a);
    expect(auth.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.parse(a.session().data.get(SCOPE_KEY)!)).toEqual({
      v: 2,
      nonce: auth.nonce,
      generation: '',
    });
  });

  it('fails closed when the credential cannot be read', () => {
    const { local, tab } = origin();
    const a = tab();
    initialAuth(a);
    local.fail = (op, key) => op === 'get' && key === TOKEN_KEY;
    const auth = initialAuth(a);
    expect(auth).toMatchObject({ token: '', generation: null, tokenReadable: false });
    expect(a.session().data.has(SCOPE_KEY)).toBe(false);
  });

  it.each([
    ['scope read', (op: Op) => op === 'get'],
    ['scope write', (op: Op) => op === 'set'],
  ])('keeps working without a restorable scope after a %s failure', (_, fail) => {
    const { tab } = origin();
    const a = tab();
    const first = initialAuth(a);
    a.session().data.set(SCOPE_KEY, JSON.stringify({ v: 2, nonce: first.nonce, generation: 'x' }));
    a.session().fail = (op, key) => key === SCOPE_KEY && fail(op);
    const auth = initialAuth(a);
    expect(auth.tokenReadable).toBe(true);
    expect(auth.nonce).not.toBe(first.nonce);
    a.session().fail = () => false;
    expect(initialAuth(a).nonce).not.toBe(auth.nonce);
  });
});

describe('readShared', () => {
  it('retries a read torn by a concurrent write and gives up if it keeps changing', () => {
    const { local, tab } = origin();
    let writes = 1;
    local.onGet = (key) => {
      if (key === TOKEN_KEY && writes-- > 0) local.data.set(GENERATION_KEY, opaqueId());
    };
    expect(readShared(tab())).toEqual({ token: '', generation: local.data.get(GENERATION_KEY) });
    local.onGet = (key) => {
      if (key === TOKEN_KEY) local.data.set(GENERATION_KEY, opaqueId());
    };
    expect(() => readShared(tab())).toThrow();
  });
});

describe('syncAuth', () => {
  it('keeps the current scope while nothing changed', () => {
    const { tab } = origin();
    const a = tab();
    const auth = initialAuth(a);
    expect(syncAuth(auth, a)).toBe(auth);
  });

  it('adopts a credential or generation change with a new persisted scope', () => {
    const { local, tab } = origin();
    const a = tab();
    const auth = initialAuth(a);
    local.data.set(TOKEN_KEY, 'token-b');
    const changed = syncAuth(auth, a);
    expect(changed).toMatchObject({ token: 'token-b', tokenReadable: true });
    expect(changed.nonce).not.toBe(auth.nonce);
    expect(initialAuth(a).nonce).toBe(changed.nonce);
    local.data.set(GENERATION_KEY, opaqueId());
    expect(syncAuth(changed, a).nonce).not.toBe(changed.nonce);
  });

  it('never leaves a restorable scope when the new scope cannot be persisted', () => {
    const { local, tab } = origin();
    const a = tab();
    const auth = initialAuth(a);
    local.data.set(TOKEN_KEY, 'token-b');
    a.session().fail = (op) => op === 'set';
    const changed = syncAuth(auth, a);
    expect(changed.token).toBe('token-b');
    expect(a.session().data.has(SCOPE_KEY)).toBe(false);
  });
});

describe('saveCredential', () => {
  it('is a no-op only for the verified stored credential', () => {
    const { local, tab } = origin();
    local.data.set(TOKEN_KEY, 'token-a');
    const a = tab();
    const auth = initialAuth(a);
    expect(saveCredential(auth, 'token-a', a)).toBeNull();
    expect(saveCredential({ ...auth, tokenReadable: false }, 'token-a', a)).not.toBeNull();
  });

  it('rotates the tab scope, then the shared generation, then the credential', () => {
    const { local, tab } = origin();
    const a = tab();
    const saved = saveCredential(initialAuth(a), 'token-b', a)!;
    expect(local.log).toEqual([`set ${GENERATION_KEY}`, `set ${TOKEN_KEY}`]);
    expect(JSON.parse(a.session().data.get(SCOPE_KEY)!)).toEqual({
      v: 2,
      nonce: saved.nonce,
      generation: saved.generation,
    });
    expect(local.data.get(GENERATION_KEY)).toBe(saved.generation);
  });

  it('writes nothing when the credential cannot be read first', () => {
    const { local, tab } = origin();
    local.data.set(TOKEN_KEY, 'token-a');
    const a = tab();
    const auth = initialAuth(a);
    local.fail = (op, key) => op === 'get' && key === TOKEN_KEY;
    expect(() => saveCredential(auth, '', a)).toThrow();
    expect(local.data.get(TOKEN_KEY)).toBe('token-a');
    expect(local.log).toEqual([]);
  });

  it.each([
    ['scope write', 'session', 'set', SCOPE_KEY, 'token-a'],
    ['generation write', 'local', 'set', GENERATION_KEY, 'token-a'],
    ['credential write', 'local', 'set', TOKEN_KEY, 'token-a'],
  ] as const)(
    'throws without changing the credential on %s failure',
    (_, area, op, key, stored) => {
      const { local, tab } = origin();
      local.data.set(TOKEN_KEY, 'token-a');
      const a = tab();
      const auth = initialAuth(a);
      (area === 'local' ? local : a.session()).fail = (o, k) => o === op && k === key;
      expect(() => saveCredential(auth, 'token-b', a)).toThrow();
      expect(local.data.get(TOKEN_KEY)).toBe(stored);
    },
  );

  it('throws when the written credential cannot be verified', () => {
    const { local, tab } = origin();
    const a = tab();
    const auth = initialAuth(a);
    let written = false;
    local.fail = (op, key) => {
      if (op === 'set' && key === TOKEN_KEY) written = true;
      return op === 'get' && key === TOKEN_KEY && written;
    };
    expect(() => saveCredential(auth, 'token-b', a)).toThrow();
  });

  it('keeps credential material out of the generation and scope records', () => {
    const { local, tab } = origin();
    const a = tab();
    saveCredential(initialAuth(a), 'secret-token', a);
    const hash = createHash('sha256').update('secret-token').digest('hex');
    for (const value of [local.data.get(GENERATION_KEY)!, a.session().data.get(SCOPE_KEY)!]) {
      expect(value).not.toContain('secret-token');
      expect(value).not.toContain(hash);
    }
  });
});
