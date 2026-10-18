import { describe, expect, it } from 'vitest';
import { isKeyNav } from './selectKeys';

const key = (k: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe('isKeyNav', () => {
  const moves = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ];

  it('treats arrow / Home / End / Page keys as keyboard browse outside macOS', () => {
    for (const k of moves) expect(isKeyNav(key(k), false), k).toBe(true);
  });

  it('does not on macOS, where they open the native menu (a pick there commits at once)', () => {
    for (const k of moves) expect(isKeyNav(key(k), true), k).toBe(false);
  });

  it('treats type-ahead letters as keyboard browse on every platform', () => {
    for (const mac of [false, true]) {
      expect(isKeyNav(key('b'), mac)).toBe(true);
      expect(isKeyNav(key('G'), mac)).toBe(true);
      expect(isKeyNav(key('7'), mac)).toBe(true);
    }
  });

  it('ignores Space, Enter, Tab and shortcuts with modifiers', () => {
    for (const mac of [false, true]) {
      for (const k of [' ', 'Enter', 'Tab', 'Escape']) expect(isKeyNav(key(k), mac), k).toBe(false);
      expect(isKeyNav(key('b', { metaKey: true }), mac)).toBe(false);
      expect(isKeyNav(key('b', { ctrlKey: true }), mac)).toBe(false);
      expect(isKeyNav(key('b', { altKey: true }), mac)).toBe(false);
    }
  });
});
