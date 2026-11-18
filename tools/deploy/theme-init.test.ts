/**
 * The script that applies the visitor's theme before the first paint (packages/app/public/theme-init.js), run against
 * the rule of packages/app/src/ui/theme.ts: the stored choice "light" or "dark" wins, anything else follows the system's
 * setting, and storage that refuses means the system's. theme.test.ts holds the app to the same table.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../../packages/app/public/theme-init.js', import.meta.url), 'utf8');

/** The key of `THEME_KEY` in theme.ts, which theme.test.ts pins. */
const KEY = 'mpc-theme';

/** Runs the script on a page with this storage and this system setting, and says whether it made the page dark. */
function darkAfter(storage: { getItem: (key: string) => string | null }, systemDark: boolean): boolean {
  const classes = new Set<string>();
  const page = {
    localStorage: storage,
    matchMedia: (query: string) => ({ matches: query.includes('dark') && systemDark }),
  };
  const document = { documentElement: { classList: { add: (name: string) => classes.add(name) } } };
  runInNewContext(script, { window: page, document });
  return classes.has('dark');
}

describe('public/theme-init.js', () => {
  /** The stored value, the system's setting, and whether the page is dark: the same rows as theme.test.ts. */
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

  it('makes the page the one of the table, for every stored value and system setting', () => {
    for (const [stored, systemDark, dark] of TABLE) {
      const storage = { getItem: (key: string) => (key === KEY ? stored : null) };
      expect(darkAfter(storage, systemDark), `${stored ?? 'nothing'}, system dark: ${systemDark}`).toBe(dark);
    }
  });

  it('follows the system’s setting where the storage refuses', () => {
    const refuses = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(darkAfter(refuses, true)).toBe(true);
    expect(darkAfter(refuses, false)).toBe(false);
  });
});
