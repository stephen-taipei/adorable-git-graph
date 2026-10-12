// Config-driven themes. A theme is one complete, typed appearance: the viewer
// and the 3D scene stay shared, only this data and the theme's stylesheet
// (themes/<id>.css) differ. Colour mode (day/night) is a separate axis.

export const THEME_IDS = ['candy', 'hacker'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'candy';

export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);

export type MascotVariant = 'blob' | 'imp';

export interface SceneDim {
  readonly body: string;
  readonly outline: string;
}

export interface ThemeAppearance {
  readonly id: ThemeId;
  /** Lane colours; index 0 is the default branch. Indexed by layout colorIndex. */
  readonly palette: readonly string[];
  /** Commit-ball outline (hull) colour. */
  readonly outline: string;
  /** Selection ring: outer and inner colours. */
  readonly selection: { readonly outer: string; readonly inner: string };
  /** Colours of commits faded out by search / branch focus, per colour mode. */
  readonly dim: { readonly day: SceneDim; readonly night: SceneDim };
  /** Mascot drawn in the header, loading and error states. */
  readonly mascot: MascotVariant;
  /** Mascot body colour. */
  readonly mascotColor: string;
  /** Little devil horns on every commit ball. */
  readonly horns: boolean;
}

export const THEME_APPEARANCES = {
  candy: {
    id: 'candy',
    palette: [
      '#4fdc9a',
      '#ff7a8a',
      '#62b6ff',
      '#ffd25e',
      '#b58cff',
      '#ffa45e',
      '#b6e35a',
      '#ff8fd0',
      '#3fd0d4',
    ],
    outline: '#2b2140',
    selection: { outer: '#2b2140', inner: '#ffd23f' },
    dim: {
      day: { body: '#e6e1f1', outline: '#bcb3d8' },
      night: { body: '#6a5fa8', outline: '#8479c4' },
    },
    mascot: 'blob',
    mascotColor: '#4fdc9a',
    horns: false,
  },
  hacker: {
    id: 'hacker',
    palette: [
      '#39ff88',
      '#2de2ff',
      '#ff4fa3',
      '#c6ff3d',
      '#a77bff',
      '#ffe14d',
      '#ff7a59',
      '#4dffd2',
      '#7fa8ff',
    ],
    outline: '#0b2f28',
    selection: { outer: '#0b2f28', inner: '#ff4fa3' },
    dim: {
      day: { body: '#d5ece5', outline: '#a3cbbf' },
      night: { body: '#15322b', outline: '#1f5c50' },
    },
    mascot: 'imp',
    mascotColor: '#39ff88',
    horns: true,
  },
} satisfies Record<ThemeId, ThemeAppearance>;

export function themeAppearance(id: ThemeId): ThemeAppearance {
  return THEME_APPEARANCES[id];
}
