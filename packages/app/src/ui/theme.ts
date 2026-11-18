/**
 * The page's theme (Phase 4): the visitor's choice of light, dark or the system's (the default), and what
 * it comes to. The choice is kept in `localStorage` under `THEME_KEY`: a preference, not personal data, and no entry
 * at all stands for the system's. It sets a `dark` class on <html>, which Tailwind's `dark:` variant reads (brand.css);
 * `public/theme-init.js` does the same before the first paint, so the page never flashes the other theme. theme.test.ts
 * runs that script against these functions.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** The choices in the order the switch shows them. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'system', 'dark'];

export const THEME_KEY = 'mpc-theme';

/** What a stored value means: anything but the two named themes is the system's. */
export function parseChoice(value: string | null | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Whether the page is dark, given the choice and the system's own setting. */
export function isDark(choice: ThemeChoice, systemDark: boolean): boolean {
  return choice === 'system' ? systemDark : choice === 'dark';
}

/** The browser's storage, or nothing where it is blocked: reaching for it can throw (a private window, blocked site data). */
export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored choice; storage that is missing or refuses means the system's. */
export function readChoice(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): ThemeChoice {
  try {
    return parseChoice(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Keeps a choice. The system's is kept as no entry, so the default stays the default. */
export function saveChoice(
  choice: ThemeChoice,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = browserStorage(),
): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, choice);
  } catch {
    // The choice then holds for this visit only.
  }
}

/** Puts the theme on the page: the `dark` class of <html>. */
export function applyTheme(root: Pick<HTMLElement, 'classList'>, dark: boolean): void {
  root.classList.toggle('dark', dark);
}
