import type { GraphLayout } from './types.ts';
/** 卡通糖果色票。index 0 固定給 default branch。 */
export const PALETTE = [
  '#4fdc9a', // mint  (main)
  '#ff7a8a', // coral
  '#62b6ff', // sky
  '#ffd25e', // sun
  '#b58cff', // grape
  '#ffa45e', // peach
  '#b6e35a', // lime
  '#ff8fd0', // pink
  '#3fd0d4', // teal
] as const;

/** 卡通描邊色（深紫黑，比純黑柔和）。 */
export const OUTLINE_COLOR = '#2b2140';

export function colorAt(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? PALETTE[0];
}

const colorIn = (palette: readonly string[], index: number): string =>
  palette[((index % palette.length) + palette.length) % palette.length] ?? palette[0] ?? PALETTE[0];

/**
 * Lane colours for a theme palette, by each node's / edge's colorIndex. The
 * same layout object comes back when the palette is the default one, so the
 * default theme never makes the scene rebuild.
 */
export function recolorLayout(layout: GraphLayout, palette: readonly string[]): GraphLayout {
  if (palette.length === 0) return layout;
  if (palette.length === PALETTE.length && palette.every((c, i) => c === PALETTE[i])) return layout;
  const nodes = layout.nodes.map((n) => ({ ...n, color: colorIn(palette, n.colorIndex) }));
  const bySha = new Map(nodes.map((n) => [n.sha, n]));
  return {
    ...layout,
    nodes,
    edges: layout.edges.map((e) => ({ ...e, color: colorIn(palette, e.colorIndex) })),
    branches: layout.branches.map((b) => ({ ...b, color: bySha.get(b.sha)?.color ?? b.color })),
  };
}
