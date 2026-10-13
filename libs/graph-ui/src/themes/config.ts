// Config-driven themes. A theme is one complete, typed appearance: the viewer
// and the 3D scene stay shared, only this data and the theme's stylesheet
// (themes/<id>.css) differ. Each theme offers its own colour schemes; every
// theme ships a light and a dark one, and may add more (one stylesheet block
// and one entry in `schemes` each).

export const THEME_IDS = ['candy', 'hacker', 'halloween'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'candy';

export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);

export type MascotVariant = 'blob' | 'imp' | 'pumpkin';

/** Decoration worn on top of every commit ball (HEAD and root keep their crown / sprout). */
export type BallTopper = 'none' | 'horns' | 'witch-hat';

export interface SceneDim {
  readonly body: string;
  readonly outline: string;
}

/** Light or dark: drives the structure stylesheet and the system "auto" choice. */
export type ColorTone = 'day' | 'night';

/** Scheme ids every theme provides. */
export const BASE_SCHEME_IDS = ['light', 'dark'] as const;

export interface ColorScheme {
  /** Stylesheet key (`data-scheme`); unique within a theme. */
  readonly id: string;
  readonly tone: ColorTone;
  /** Colours of commits faded out by search / branch focus. */
  readonly dim: SceneDim;
}

/** What the user picked: 'auto' follows the system, otherwise a scheme id. */
export type SchemeSetting = string;
export const AUTO_SCHEME = 'auto';

/** Accepts 'auto', any scheme id of any theme, and the legacy 'day' / 'night'. */
export const isSchemeSetting = (v: unknown): v is SchemeSetting =>
  typeof v === 'string' &&
  (v === AUTO_SCHEME ||
    v === 'day' ||
    v === 'night' ||
    THEME_IDS.some((id) => THEME_APPEARANCES[id].schemes.some((s) => s.id === v)));

export interface ThemeAppearance {
  readonly id: ThemeId;
  /** Lane colours; index 0 is the default branch. Indexed by layout colorIndex. */
  readonly palette: readonly string[];
  /** Commit-ball outline (hull) colour. */
  readonly outline: string;
  /** Selection ring: outer and inner colours. */
  readonly selection: { readonly outer: string; readonly inner: string };
  /** Colour schemes; the first one of each tone is that tone's default. */
  readonly schemes: readonly [ColorScheme, ColorScheme, ...ColorScheme[]];
  /** Mascot drawn in the header, loading and error states. */
  readonly mascot: MascotVariant;
  /** Mascot body colour. */
  readonly mascotColor: string;
  /** What every commit ball wears on top. */
  readonly topper: BallTopper;
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
    schemes: [
      { id: 'light', tone: 'day', dim: { body: '#e6e1f1', outline: '#bcb3d8' } },
      { id: 'dark', tone: 'night', dim: { body: '#6a5fa8', outline: '#8479c4' } },
    ],
    mascot: 'blob',
    mascotColor: '#4fdc9a',
    topper: 'none',
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
    schemes: [
      { id: 'light', tone: 'day', dim: { body: '#d5ece5', outline: '#a3cbbf' } },
      { id: 'dark', tone: 'night', dim: { body: '#15322b', outline: '#1f5c50' } },
    ],
    mascot: 'imp',
    mascotColor: '#39ff88',
    topper: 'horns',
  },
  halloween: {
    id: 'halloween',
    palette: [
      '#ff8a1f',
      '#a970ff',
      '#7ee04a',
      '#ff4f6d',
      '#ffd23f',
      '#3fd0c4',
      '#ff7ac8',
      '#c9a2ff',
      '#e8e0c8',
    ],
    outline: '#1e1029',
    selection: { outer: '#1e1029', inner: '#ff8a1f' },
    schemes: [
      { id: 'light', tone: 'day', dim: { body: '#eee2d4', outline: '#c8b5a2' } },
      { id: 'dark', tone: 'night', dim: { body: '#3b2a4f', outline: '#56406f' } },
    ],
    mascot: 'pumpkin',
    mascotColor: '#ff8a1f',
    topper: 'witch-hat',
  },
} satisfies Record<ThemeId, ThemeAppearance>;

export function themeAppearance(id: ThemeId): ThemeAppearance {
  return THEME_APPEARANCES[id];
}

/** The first scheme of a theme with this tone (every theme has a light and a dark one). */
function byTone(theme: ThemeAppearance, tone: ColorTone): ColorScheme {
  return theme.schemes.find((s) => s.tone === tone) ?? theme.schemes[0];
}

/**
 * The scheme a theme shows for a setting. A scheme id the theme lacks (picked
 * under another theme) falls back to this theme's scheme of the same tone.
 */
export function resolveScheme(
  themeId: ThemeId,
  setting: SchemeSetting,
  prefersDark: boolean,
): ColorScheme {
  const theme = themeAppearance(themeId);
  if (setting === 'day' || setting === 'night') return byTone(theme, setting);
  const own = theme.schemes.find((s) => s.id === setting);
  if (own) return own;
  const elsewhere = THEME_IDS.flatMap((id) => THEME_APPEARANCES[id].schemes).find(
    (s) => s.id === setting,
  );
  return byTone(theme, elsewhere?.tone ?? (prefersDark ? 'night' : 'day'));
}

/** The settings a theme's scheme button cycles through: auto, then each scheme. */
export function schemeCycle(themeId: ThemeId): readonly SchemeSetting[] {
  return [AUTO_SCHEME, ...themeAppearance(themeId).schemes.map((s) => s.id)];
}
