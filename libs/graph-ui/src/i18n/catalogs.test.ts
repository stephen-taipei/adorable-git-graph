import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './locales';

// 每個語系的翻譯檔都要和 en.json 同一個形狀：同樣的 key、同樣的佔位符、該語言需要的複數形都有。
const dir = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const read = (tag: string) => JSON.parse(readFileSync(join(dir, `${tag}.json`), 'utf8')) as Json;
type Json = { [k: string]: string | Json };
const en = read('en');

const isPlural = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && 'other' in v;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

/** 指令、設定名、網址等：翻譯裡必須原樣保留 */
const VERBATIM = [
  'AGG_REPO_ROOTS',
  'api.github.com',
  'git config --global --add safe.directory',
  'Contents: Read-only',
  'Metadata: Read-only',
  'localStorage',
  'github_pat_',
];

function check(tag: string, base: Json, tr: unknown, path: string, errors: string[]) {
  if (typeof tr !== 'object' || tr === null) return void errors.push(`${path}: missing object`);
  const t = tr as Record<string, unknown>;
  for (const k of Object.keys(t))
    if (!(k in base) && !isPlural(base)) errors.push(`${path}.${k}: unknown key`);
  for (const [k, v] of Object.entries(base)) {
    const p = `${path}.${k}`;
    if (isPlural(v)) {
      const forms = t[k];
      if (!isPlural(forms)) {
        errors.push(`${p}: expected plural forms`);
        continue;
      }
      const need = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
      for (const c of need) if (!forms[c]) errors.push(`${p}: missing plural "${c}"`);
      for (const c of Object.keys(forms))
        if (!need.includes(c as Intl.LDMLPluralRule)) errors.push(`${p}: extra plural "${c}"`);
      const want = placeholders(v['other']!).filter((x) => x !== 'n');
      for (const [c, s] of Object.entries(forms)) {
        const got = placeholders(s);
        // 單數形可以把 {n} 寫成文字（例如「un commit」），其他佔位符一定要有
        for (const x of want) if (!got.includes(x)) errors.push(`${p}.${c}: missing {${x}}`);
        for (const x of got)
          if (x !== 'n' && !want.includes(x)) errors.push(`${p}.${c}: unknown {${x}}`);
        if (c === 'other' && !got.includes('n')) errors.push(`${p}.other: missing {n}`);
      }
    } else if (typeof v === 'string') {
      const s = t[k];
      if (typeof s !== 'string' || !s.trim()) {
        errors.push(`${p}: missing`);
        continue;
      }
      if (placeholders(s).join() !== placeholders(v).join())
        errors.push(`${p}: placeholders ${placeholders(s)} ≠ ${placeholders(v)}`);
      for (const word of VERBATIM)
        if (v.includes(word) && !s.includes(word)) errors.push(`${p}: must keep "${word}"`);
    } else check(tag, v, t[k], p, errors);
  }
}

describe('locale catalogs', () => {
  it('has exactly one catalog per supported locale', () => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
    expect(files).toEqual(LOCALES.map((l) => l.tag).sort());
    expect(LOCALES).toHaveLength(41);
  });

  it.each(LOCALES.map((l) => l.tag))('%s matches en.json', (tag) => {
    const errors: string[] = [];
    check(tag, en, read(tag), tag, errors);
    expect(errors).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.tag))('%s: store description fits 132 characters', (tag) => {
    const d = (read(tag)['manifest'] as Json)['description'] as string;
    expect([...d].length).toBeLessThanOrEqual(132);
  });
});
