/* global window, document */
// Applies the visitor's theme before the first paint, so the page never flashes the other one. A classic script, not a
// module, and a file of its own: the Content-Security-Policy allows no inline script (deploy/security-headers.conf).
// The same rule as src/ui/theme.ts, and tools/deploy/theme-init.test.ts runs this file against it: the stored choice
// "light" or "dark" wins, anything else follows the system's setting. The key is THEME_KEY.
(function () {
  let dark = false;
  try {
    const stored = window.localStorage.getItem('mpc-theme');
    dark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      dark = false;
    }
  }
  if (dark) document.documentElement.classList.add('dark');
})();
