import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PALETTE, recolorLayout } from '@adorable/graph-core';
import type { GraphLayout } from '@adorable/graph-core';
import { DEFAULT_THEME, THEME_APPEARANCES, THEME_IDS, isThemeId } from './config';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const viewerCss = read('../viewer/viewer.css');
const themeCss = (id: string) => read(`./${id}.css`);
const HEX = /^#[0-9a-f]{6}$/i;

/** Custom properties a stylesheet uses without a fallback (inner fallbacks count). */
function requiredTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/var\((--agg-[a-z0-9-]+)\s*([,)])/g))
    if (m[2] === ')') out.add(m[1]!);
  return out;
}

function definedIn(block: string): Set<string> {
  return new Set([...block.matchAll(/(--agg-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** The body of the first rule whose selector matches `selector` exactly. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start));
}

describe('theme family completeness', () => {
  it('declares one complete appearance per theme id', () => {
    expect(Object.keys(THEME_APPEARANCES).sort()).toEqual([...THEME_IDS].sort());
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    for (const id of THEME_IDS) {
      const a = THEME_APPEARANCES[id];
      expect(a.id).toBe(id);
      expect(a.palette.length).toBeGreaterThanOrEqual(PALETTE.length);
      for (const c of [
        ...a.palette,
        a.outline,
        a.selection.outer,
        a.selection.inner,
        a.dim.day.body,
        a.dim.day.outline,
        a.dim.night.body,
        a.dim.night.outline,
        a.mascotColor,
      ])
        expect(c).toMatch(HEX);
    }
  });

  it.each(THEME_IDS)('%s has a stylesheet that defines every token the viewer needs', (id) => {
    expect(existsSync(fileURLToPath(new URL(`./${id}.css`, import.meta.url)))).toBe(true);
    const css = themeCss(id);
    const day = definedIn(block(css, `:where(.agg-root, .agg-theme-scope)[data-theme-id='${id}']`));
    const night = block(
      css,
      `:where(.agg-root, .agg-theme-scope)[data-theme-id='${id}'][data-theme='night']`,
    );
    expect(night).not.toBe('');
    const needed = [...requiredTokens(viewerCss)].filter((t) => !definedIn(viewerCss).has(t));
    expect(needed.length).toBeGreaterThan(20);
    expect(needed.filter((t) => !day.has(t))).toEqual([]);
    // Night only overrides tokens the day block defines, so both modes are complete.
    expect([...definedIn(night)].filter((t) => !day.has(t))).toEqual([]);
    // Tokens a theme uses itself are defined by that theme.
    expect([...requiredTokens(css)].filter((t) => !day.has(t))).toEqual([]);
  });

  it.each(THEME_IDS)('%s only styles its own theme scope', (id) => {
    const css = themeCss(id).replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((sel) => !sel.startsWith('@') && !/^(from|to|\d+%)/.test(sel));
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel).toContain(`[data-theme-id='${id}']`);
  });

  it('keeps colours out of the shared structure stylesheet', () => {
    expect(viewerCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(viewerCss).not.toContain("data-theme='night'");
  });
});

describe('recolorLayout', () => {
  const layout = {
    repo: { owner: 'o', name: 'r' },
    nodes: [
      { sha: 'a', colorIndex: 0, color: PALETTE[0] },
      { sha: 'b', colorIndex: 10, color: PALETTE[1] },
    ],
    edges: [{ colorIndex: 1, color: PALETTE[1] }],
    branches: [{ name: 'main', sha: 'b', color: PALETTE[1] }],
    laneCount: 2,
    truncated: false,
  } as unknown as GraphLayout;

  it('returns the same layout for the default palette', () => {
    expect(recolorLayout(layout, THEME_APPEARANCES.candy.palette)).toBe(layout);
  });

  it('recolours nodes, edges and branch legends by colorIndex', () => {
    const p = THEME_APPEARANCES.hacker.palette;
    const out = recolorLayout(layout, p);
    expect(out.nodes.map((n) => n.color)).toEqual([p[0], p[10 % p.length]]);
    expect(out.edges[0]!.color).toBe(p[1]);
    expect(out.branches[0]!.color).toBe(p[10 % p.length]);
    expect(layout.nodes[0]!.color).toBe(PALETTE[0]);
  });
});
