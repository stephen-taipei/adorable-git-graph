// Credential scope for the web viewer. The credential lives in shared
// localStorage next to a non-secret generation that changes on every write.
// Each tab binds its opaque viewer scope (sessionStorage) to the generation
// it observed, so a tab restores saved viewer state only when the credential
// it now reads is the one that state was saved under. No credential value or
// fingerprint is derived into the generation, the scope or the viewer key.

export const TOKEN_KEY = 'agg.github-token';
export const GENERATION_KEY = 'agg:auth-generation:v1';
/** Holds a JSON scope record; plain-UUID values of earlier builds never match. */
export const SCOPE_KEY = 'agg:viewer-auth-nonce:v1';

const ID = /^[a-f0-9]{32}$/;

export interface Auth {
  token: string;
  /** Shared generation this tab observed; '' before any versioned write, null if unreadable. */
  generation: string | null;
  /** Opaque tab-scoped viewer scope. */
  nonce: string;
  tokenReadable: boolean;
}

export interface AuthStores {
  local(): Storage;
  session(): Storage;
}

const browserStores: AuthStores = {
  local: () => localStorage,
  session: () => sessionStorage,
};

/**
 * Non-secret opaque ID. `crypto.randomUUID` exists only in secure contexts;
 * `getRandomValues` also works on plain-HTTP LAN pages.
 */
export function opaqueId(): string {
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    // Uniqueness is all a scope needs; it is never a secret.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
}

/** Credential and generation from one consistent read; throws if unreadable or changing. */
export function readShared(stores: AuthStores = browserStores): {
  token: string;
  generation: string;
} {
  const local = stores.local();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = local.getItem(GENERATION_KEY);
    const token = local.getItem(TOKEN_KEY) ?? '';
    if (local.getItem(GENERATION_KEY) === before) return { token, generation: before ?? '' };
  }
  throw new Error('Credential generation changed while reading');
}

function savedScope(session: Storage, generation: string): string | null {
  const raw = session.getItem(SCOPE_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { v?: unknown; nonce?: unknown; generation?: unknown };
    return record.v === 2 &&
      typeof record.nonce === 'string' &&
      ID.test(record.nonce) &&
      record.generation === generation
      ? record.nonce
      : null;
  } catch {
    return null;
  }
}

/** A fresh tab scope bound to `generation`, verified by read-back. */
function persistScope(session: Storage, generation: string): string {
  const nonce = opaqueId();
  const raw = JSON.stringify({ v: 2, nonce, generation });
  session.setItem(SCOPE_KEY, raw);
  if (session.getItem(SCOPE_KEY) !== raw) throw new Error('Scope not persisted');
  return nonce;
}

/**
 * A scope that is never persisted, so nothing saved under it restores. The
 * persisted record is dropped too: an uncertain state never restores later.
 */
export function ephemeralScope(stores: AuthStores = browserStores): string {
  try {
    stores.session().removeItem(SCOPE_KEY);
  } catch {
    /* storage unavailable: nothing can be restored from it either */
  }
  return opaqueId();
}

function adopt(shared: { token: string; generation: string }, stores: AuthStores): Auth {
  let nonce: string;
  try {
    nonce = persistScope(stores.session(), shared.generation);
  } catch {
    nonce = ephemeralScope(stores);
  }
  return { ...shared, nonce, tokenReadable: true };
}

export function initialAuth(stores: AuthStores = browserStores): Auth {
  let shared: { token: string; generation: string };
  try {
    shared = readShared(stores);
  } catch {
    // A failed credential read cannot establish an anonymous scope.
    return { token: '', generation: null, nonce: ephemeralScope(stores), tokenReadable: false };
  }
  try {
    const nonce = savedScope(stores.session(), shared.generation);
    if (nonce) return { ...shared, nonce, tokenReadable: true };
  } catch {
    return { ...shared, nonce: ephemeralScope(stores), tokenReadable: true };
  }
  return adopt(shared, stores);
}

/**
 * Re-reads the shared credential after another tab may have changed it.
 * Returns `current` when nothing changed; any change gets a new scope.
 */
export function syncAuth(current: Auth, stores: AuthStores = browserStores): Auth {
  let shared: { token: string; generation: string };
  try {
    shared = readShared(stores);
  } catch {
    return current.tokenReadable
      ? { token: '', generation: null, nonce: ephemeralScope(stores), tokenReadable: false }
      : current;
  }
  if (
    current.tokenReadable &&
    shared.token === current.token &&
    shared.generation === current.generation
  )
    return current;
  return adopt(shared, stores);
}

/**
 * Saves (or clears, for '') the credential. Returns null when the verified
 * stored credential already is `next`. Rotates the tab scope first, then the
 * shared generation, then the credential, and verifies all of them; throws on
 * any failure, leaving the caller to fail closed.
 */
export function saveCredential(
  current: Auth,
  next: string,
  stores: AuthStores = browserStores,
): Auth | null {
  const shared = readShared(stores);
  if (
    current.tokenReadable &&
    next === current.token &&
    shared.token === next &&
    shared.generation === current.generation
  )
    return null;
  const generation = opaqueId();
  const nonce = persistScope(stores.session(), generation);
  const local = stores.local();
  local.setItem(GENERATION_KEY, generation);
  if (next) local.setItem(TOKEN_KEY, next);
  else local.removeItem(TOKEN_KEY);
  if (local.getItem(TOKEN_KEY) !== (next || null) || local.getItem(GENERATION_KEY) !== generation)
    throw new Error('Settings not persisted');
  return { token: next, generation, nonce, tokenReadable: true };
}
