import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Listener = (arg?: unknown) => void;
function fakePort() {
  const message: Listener[] = [];
  const disconnect: Listener[] = [];
  return {
    posted: [] as unknown[],
    disconnected: false,
    onMessage: { addListener: (fn: Listener) => message.push(fn) },
    onDisconnect: { addListener: (fn: Listener) => disconnect.push(fn) },
    postMessage(req: unknown) {
      this.posted.push(req);
    },
    disconnect() {
      this.disconnected = true;
    },
    reply: (res: unknown) => message.forEach((fn) => fn(res)),
    drop: () => disconnect.forEach((fn) => fn()),
  };
}

async function setup() {
  const ports: ReturnType<typeof fakePort>[] = [];
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('chrome', {
    runtime: {
      lastError: undefined,
      sendMessage: vi.fn(async () => ({ ok: true, data: null })),
      connect: vi.fn(() => {
        const p = fakePort();
        ports.push(p);
        return p;
      }),
    },
  });
  const { sendToBackground } = await import('./messages');
  const pageEvent = (type: string, persisted: boolean) =>
    win.dispatchEvent(Object.assign(new Event(type), { persisted }));
  return { ports, sendToBackground, pageEvent, runtime: (globalThis as any).chrome.runtime };
}

describe('sendToBackground', () => {
  it('sends one request per port and resolves with the reply', async () => {
    const { ports, sendToBackground } = await setup();
    const res = sendToBackground({ type: 'rate-limit' });
    expect(ports).toHaveLength(1);
    expect(ports[0]!.posted).toEqual([{ type: 'rate-limit' }]);
    ports[0]!.reply({ ok: true, data: 1 });
    await expect(res).resolves.toEqual({ ok: true, data: 1 });
    expect(ports[0]!.disconnected).toBe(true);
  });

  it('rejects when the background goes away', async () => {
    const { ports, sendToBackground } = await setup();
    const res = sendToBackground({ type: 'rate-limit' });
    ports[0]!.drop();
    await expect(res).rejects.toThrow();
  });

  it('disconnects on pagehide and resends after a bfcache restore', async () => {
    const { ports, sendToBackground, pageEvent } = await setup();
    let settled = false;
    const res = sendToBackground({ type: 'fetch-graph', owner: 'o', repo: 'r' });
    void res.then(() => (settled = true));
    pageEvent('pagehide', true);
    expect(ports[0]!.disconnected).toBe(true);
    // 斷開後才到的回應不算數
    ports[0]!.reply({ ok: true, data: 'stale' });
    await Promise.resolve();
    expect(settled).toBe(false);
    pageEvent('pageshow', false);
    expect(ports).toHaveLength(1);
    pageEvent('pageshow', true);
    expect(ports).toHaveLength(2);
    expect(ports[1]!.posted).toEqual([{ type: 'fetch-graph', owner: 'o', repo: 'r' }]);
    ports[1]!.reply({ ok: true, data: 'fresh' });
    await expect(res).resolves.toEqual({ ok: true, data: 'fresh' });
  });

  it('sends open-options with runtime.sendMessage so Firefox keeps the click as user input', async () => {
    const { ports, sendToBackground, runtime } = await setup();
    await expect(sendToBackground({ type: 'open-options' })).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith({ type: 'open-options' });
    expect(ports).toHaveLength(0);
  });
});
