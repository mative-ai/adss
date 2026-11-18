/**
 * The theme's rules (ui/theme.ts). The script that applies them before the first paint (public/theme-init.js) is the
 * same rule written again, and tools/deploy/theme-init.test.ts holds it to the table below: the two must never
 * disagree about a visitor's page.
 */
import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  isDark,
  parseChoice,
  readChoice,
  saveChoice,
  THEME_CHOICES,
  THEME_KEY,
  type ThemeChoice,
} from './theme.ts';

/** A storage that holds its entries in a map, or refuses every call. */
function storage(initial: Record<string, string> = {}, refuses = false) {
  const entries = new Map(Object.entries(initial));
  const guard = () => {
    if (refuses) throw new Error('blocked');
  };
  return {
    entries,
    getItem: (key: string) => (guard(), entries.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void entries.set(key, value)),
    removeItem: (key: string) => (guard(), void entries.delete(key)),
  };
}

describe('the theme choice', () => {
  it('reads a stored value: light and dark are themselves, anything else is the system’s', () => {
    expect(parseChoice('light')).toBe('light');
    expect(parseChoice('dark')).toBe('dark');
    for (const other of ['system', '', 'purple', null, undefined]) expect(parseChoice(other)).toBe('system');
  });

  it('follows the system’s setting only when the choice is the system’s', () => {
    expect(isDark('system', true)).toBe(true);
    expect(isDark('system', false)).toBe(false);
    expect(isDark('dark', false)).toBe(true);
    expect(isDark('light', true)).toBe(false);
  });

  it('offers the three choices, light first and dark last', () => {
    expect(THEME_CHOICES).toEqual(['light', 'system', 'dark']);
  });

  it('is kept as light or dark, and as no entry at all for the system’s', () => {
    const store = storage();
    saveChoice('dark', store);
    expect(store.entries.get(THEME_KEY)).toBe('dark');
    expect(readChoice(store)).toBe('dark');
    saveChoice('light', store);
    expect(readChoice(store)).toBe('light');
    saveChoice('system', store);
    expect(store.entries.has(THEME_KEY)).toBe(false);
    expect(readChoice(store)).toBe('system');
  });

  it('falls back to the system’s where the storage is missing or refuses, and never throws', () => {
    expect(readChoice(undefined)).toBe('system');
    expect(readChoice(storage({}, true))).toBe('system');
    expect(() => saveChoice('dark', storage({}, true))).not.toThrow();
    expect(() => saveChoice('dark', undefined)).not.toThrow();
  });

  it('puts the dark class on the page, and takes it off', () => {
    const classes = new Set<string>();
    const root = {
      classList: { toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)) },
    } as unknown as HTMLElement;
    applyTheme(root, true);
    expect(classes.has('dark')).toBe(true);
    applyTheme(root, false);
    expect(classes.has('dark')).toBe(false);
  });
});

describe('the page a visitor gets', () => {
  /** The stored value, the system's setting, and whether the page is dark: the same rows as theme-init.test.ts. */
  const TABLE: [stored: string | null, systemDark: boolean, dark: boolean][] = [
    [null, false, false],
    [null, true, true],
    ['light', false, false],
    ['light', true, false],
    ['dark', false, true],
    ['dark', true, true],
    ['system', false, false],
    ['system', true, true],
    ['purple', false, false],
    ['purple', true, true],
  ];

  it('is the one of the table, for every stored value and system setting', () => {
    for (const [stored, systemDark, dark] of TABLE) {
      const store = storage(stored === null ? {} : { [THEME_KEY]: stored });
      const choice: ThemeChoice = readChoice(store);
      expect(isDark(choice, systemDark), `${stored ?? 'nothing'}, system dark: ${systemDark}`).toBe(dark);
    }
  });

  it('is kept under the key that public/theme-init.js reads', () => {
    expect(THEME_KEY).toBe('mpc-theme');
  });
});
