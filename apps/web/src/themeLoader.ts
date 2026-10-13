import type { ThemeId } from '@adorable/graph-ui';
import candyHref from '@adorable/graph-ui/themes/candy.css?url';
import hackerHref from '@adorable/graph-ui/themes/hacker.css?url';
import halloweenHref from '@adorable/graph-ui/themes/halloween.css?url';

/**
 * Theme stylesheets are separate assets, requested only when that theme is
 * chosen. Nothing theme-specific loads before the first choice resolves.
 */
export const THEME_STYLESHEETS = {
  candy: candyHref,
  hacker: hackerHref,
  halloween: halloweenHref,
} satisfies Record<ThemeId, string>;

export const THEME_LINK_ID = 'agg-theme-stylesheet';

/**
 * Points the single managed <link> at `href` and resolves once that
 * stylesheet has loaded (rejects if it fails). Repeated switches reuse the
 * same element, so only the active theme's stylesheet is ever applied.
 */
export function loadThemeStylesheet(href: string, doc: Document = document): Promise<void> {
  let existing = doc.getElementById(THEME_LINK_ID) as HTMLLinkElement | null;
  const same = existing?.getAttribute('href') === href;
  if (existing && same && existing.dataset['state'] === 'loaded') return Promise.resolve();
  let link: HTMLLinkElement;
  if (existing && same && existing.dataset['state'] === 'failed') {
    // Re-setting the same href does not refetch: retry with a fresh element
    // in the same place, so there is still exactly one managed link.
    link = doc.createElement('link');
    existing.replaceWith(link);
    existing = link;
  } else {
    link = existing ?? doc.createElement('link');
  }
  link.id = THEME_LINK_ID;
  link.rel = 'stylesheet';
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      link.removeEventListener('load', onLoad);
      link.removeEventListener('error', onError);
      // A later switch may already point the link elsewhere; only the current href settles it.
      if (link.getAttribute('href') !== href) return reject(new Error('Superseded'));
      link.dataset['state'] = ok ? 'loaded' : 'failed';
      if (ok) resolve();
      else reject(new Error(`Theme stylesheet failed to load: ${href}`));
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    link.addEventListener('load', onLoad);
    link.addEventListener('error', onError);
    // Already loading this href (e.g. a repeated effect): just wait for it.
    if (link.getAttribute('href') === href && link.dataset['state'] === 'loading') return;
    link.dataset['state'] = 'loading';
    link.setAttribute('href', href);
    if (!existing) doc.head.append(link);
  });
}
