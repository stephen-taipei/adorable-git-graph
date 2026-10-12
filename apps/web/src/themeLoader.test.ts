import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { THEME_IDS } from '@adorable/graph-ui';

vi.mock('@adorable/graph-ui/themes/candy.css?url', () => ({ default: '/themes/candy.css' }));
vi.mock('@adorable/graph-ui/themes/hacker.css?url', () => ({ default: '/themes/hacker.css' }));

const { THEME_LINK_ID, THEME_STYLESHEETS, loadThemeStylesheet } = await import('./themeLoader');

class FakeLink extends EventTarget {
  id = '';
  replacedBy: FakeLink | null = null;
  replaceWith(next: FakeLink) {
    this.replacedBy = next;
    fake.onReplace(this, next);
  }
  rel = '';
  dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
}

const fake = { onReplace: (_old: FakeLink, _next: FakeLink) => {} };

function fakeDocument() {
  const children: FakeLink[] = [];
  fake.onReplace = (old, next) => children.splice(children.indexOf(old), 1, next);
  const doc = {
    head: { append: (el: FakeLink) => children.push(el) },
    createElement: () => new FakeLink(),
    getElementById: (id: string) => children.find((el) => el.id === id) ?? null,
  };
  return { doc: doc as unknown as Document, children };
}

describe('loadThemeStylesheet', () => {
  it('lists a stylesheet for every theme', () => {
    expect(Object.keys(THEME_STYLESHEETS).sort()).toEqual([...THEME_IDS].sort());
  });

  it('manages one link, resolving when the stylesheet has loaded', async () => {
    const { doc, children } = fakeDocument();
    const first = loadThemeStylesheet('/themes/candy.css', doc);
    expect(children).toHaveLength(1);
    const link = children[0]!;
    expect(link.id).toBe(THEME_LINK_ID);
    expect(link.rel).toBe('stylesheet');
    expect(link.getAttribute('href')).toBe('/themes/candy.css');
    expect(link.dataset['state']).toBe('loading');
    link.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBeUndefined();
    expect(link.dataset['state']).toBe('loaded');
    // Same theme again: nothing to load.
    await expect(loadThemeStylesheet('/themes/candy.css', doc)).resolves.toBeUndefined();

    const second = loadThemeStylesheet('/themes/hacker.css', doc);
    expect(children).toHaveLength(1);
    expect(link.getAttribute('href')).toBe('/themes/hacker.css');
    link.dispatchEvent(new Event('load'));
    await expect(second).resolves.toBeUndefined();
  });

  it('lets the latest switch win and reports failures', async () => {
    const { doc, children } = fakeDocument();
    const stale = loadThemeStylesheet('/themes/candy.css', doc);
    const latest = loadThemeStylesheet('/themes/hacker.css', doc);
    const link = children[0]!;
    link.dispatchEvent(new Event('error'));
    await expect(stale).rejects.toThrow('Superseded');
    await expect(latest).rejects.toThrow('failed to load');
    expect(link.dataset['state']).toBe('failed');
    // A retry of the failed theme refetches through a fresh element in its place.
    const retry = loadThemeStylesheet('/themes/hacker.css', doc);
    expect(children).toHaveLength(1);
    const fresh = children[0]!;
    expect(fresh).not.toBe(link);
    expect(fresh.id).toBe(THEME_LINK_ID);
    expect(fresh.getAttribute('href')).toBe('/themes/hacker.css');
    fresh.dispatchEvent(new Event('load'));
    await expect(retry).resolves.toBeUndefined();
  });

  it('waits on a load already in flight for the same stylesheet', async () => {
    const { doc, children } = fakeDocument();
    const first = loadThemeStylesheet('/themes/candy.css', doc);
    const again = loadThemeStylesheet('/themes/candy.css', doc);
    expect(children).toHaveLength(1);
    children[0]!.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBeUndefined();
    await expect(again).resolves.toBeUndefined();
  });
});

describe('web shell theme tokens', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const shell = read('./styles.css');
  const needed = new Set([...shell.matchAll(/var\((--agg-[a-z0-9-]+)\s*\)/g)].map((m) => m[1]!));

  it.each(THEME_IDS)('%s defines every token the web shell uses', (id) => {
    const css = read(`../../../libs/graph-ui/src/themes/${id}.css`);
    const defined = new Set([...css.matchAll(/(--agg-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    expect(needed.size).toBeGreaterThan(3);
    expect([...needed].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('keeps colours out of the web shell stylesheet', () => {
    expect(shell).not.toMatch(/:[^;{]*#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
