import { describe, expect, it } from 'vitest';
import {
  inspectionStorageKey,
  parseSavedInspection,
  serializeInspection,
} from './useInspection.ts';

const sha = 'a'.repeat(40);

describe('parseSavedInspection', () => {
  it('round-trips what the viewer writes', () => {
    expect(parseSavedInspection(serializeInspection({ sha, repo: 'o/r' }, true))).toEqual({
      open: true,
      inspection: { sha, repo: 'o/r' },
    });
    expect(parseSavedInspection(serializeInspection({ sha }, false))).toEqual({
      open: false,
      inspection: { sha },
    });
    // 只記得面板開關、沒有正在檢視的 commit
    expect(parseSavedInspection(serializeInspection(undefined, true))).toEqual({ open: true });
    expect(inspectionStorageKey('k')).toBe('agg:inspection:k');
  });

  it('ignores missing, malformed or unexpected data', () => {
    expect(parseSavedInspection(null)).toBeUndefined();
    expect(parseSavedInspection('{not json')).toBeUndefined();
    expect(parseSavedInspection(JSON.stringify({ version: 2, open: true }))).toBeUndefined();
    expect(parseSavedInspection(JSON.stringify({ version: 1, open: 'yes' }))).toBeUndefined();
    expect(
      parseSavedInspection(JSON.stringify({ version: 1, open: true, inspection: null })),
    ).toBeUndefined();
  });

  it('only accepts full shas and owner/name repos', () => {
    const parse = (inspection: unknown) =>
      parseSavedInspection(JSON.stringify({ version: 1, open: true, inspection }));
    expect(parse({ sha: 'abc1234' })).toBeUndefined();
    expect(parse({ sha, repo: 'not a repo' })).toBeUndefined();
    expect(parse({ sha, repo: 'o/r/x' })).toBeUndefined();
    expect(parse({ sha, repo: 42 })).toBeUndefined();
    expect(parse({ sha, repo: `o/${'r'.repeat(300)}` })).toBeUndefined();
    // 多餘的欄位不會被帶回來
    expect(parse({ sha, repo: 'o/r', secret: 'x' })).toEqual({
      open: true,
      inspection: { sha, repo: 'o/r' },
    });
  });
});
