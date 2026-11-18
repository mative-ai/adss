/**
 * The top row of the page: the theme switch, at the right, and nothing else. The page names itself in its title under
 * this row. There is no menu (there is one screen) and no language switch: the language comes from `?lng=` or from the
 * browser.
 */
import { ThemeSwitch } from './ThemeSwitch.tsx';

export function Header() {
  return (
    <header className="mx-auto flex w-full max-w-[1360px] justify-end px-4 pt-3 md:px-8 md:pt-4">
      <ThemeSwitch />
    </header>
  );
}
