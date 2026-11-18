/**
 * Class strings of the page's components, kept in one place
 * so that a button or a card looks the same wherever it is.
 */

const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-base font-medium transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50';

/** The one primary action of a block: green with ink text. */
export const PRIMARY = `${BUTTON} bg-primary text-ink shadow-[0_10px_30px_-12px_rgba(77,185,54,0.7)] hover:bg-primary-400 active:translate-y-px`;

export const SECONDARY = `${BUTTON} border border-clay-300 bg-white/80 text-clay-900 backdrop-blur hover:border-clay-400 hover:bg-white active:translate-y-px dark:border-white/15 dark:bg-night-900/60 dark:text-white dark:hover:bg-night-800`;

/** A card of content on the page's background. */
export const CARD = 'rounded-3xl border border-clay-200 bg-clay-50 p-5 dark:border-white/10 dark:bg-night-850 md:p-6';

/** The title of a card. */
export const CARD_TITLE = 'font-heading font-medium text-xl tracking-tight text-clay-950 dark:text-white';

/** The secondary text. */
export const MUTED = 'text-clay-600 dark:text-clay-400';

/** A chip: a status in one or two words. */
export const CHIP =
  'inline-flex items-center rounded-full border border-clay-200 bg-white/70 px-2.5 py-0.5 text-xs dark:border-white/10 dark:bg-night-900/60';

/** The chip of the one thing in use: green with ink text, so it shares no class with CHIP that a theme could override. */
export const CHIP_ON = 'inline-flex items-center rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-ink';
