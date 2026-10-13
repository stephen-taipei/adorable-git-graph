import { afterEach, describe, expect, it, vi } from 'vitest';

/** consent.ts 在載入時決定目標瀏覽器：每個情境重新載入模組 */
async function load(
  target: 'chrome' | 'firefox' | undefined,
  permissions: Record<string, unknown>,
) {
  vi.resetModules();
  if (target) vi.stubGlobal('__AGG_TARGET__', target);
  vi.stubGlobal('chrome', { permissions });
  return import('./consent');
}

afterEach(() => vi.unstubAllGlobals());

describe('token consent (Firefox data_collection_permissions)', () => {
  it('Chrome never asks and always allows the token', async () => {
    const contains = vi.fn();
    const request = vi.fn();
    const c = await load('chrome', { contains, request });
    expect(await c.hasTokenConsent()).toBe(true);
    expect(await c.requestTokenConsent()).toBe(true);
    expect(contains).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('Firefox asks for authenticationInfo and follows the answer', async () => {
    const request = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const c = await load('firefox', { contains: vi.fn().mockResolvedValue(false), request });
    expect(await c.requestTokenConsent()).toBe(false);
    expect(await c.requestTokenConsent()).toBe(true);
    expect(request).toHaveBeenCalledWith({ data_collection: ['authenticationInfo'] });
  });

  it('Firefox outside a user gesture falls back to an existing grant, never assumes one', async () => {
    const request = vi.fn().mockRejectedValue(new Error('not handling user input'));
    const granted = await load('firefox', { contains: vi.fn().mockResolvedValue(true), request });
    expect(await granted.requestTokenConsent()).toBe(true);
    const none = await load('firefox', { contains: vi.fn().mockResolvedValue(false), request });
    expect(await none.requestTokenConsent()).toBe(false);
    const broken = await load('firefox', {
      contains: vi.fn().mockRejectedValue(new Error('unsupported')),
      request,
    });
    expect(await broken.hasTokenConsent()).toBe(false);
  });
});
