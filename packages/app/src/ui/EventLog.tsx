/**
 * The events of the run, newest first (Phase 4): the obstacle comes into play, a collision, the end of the
 * road, the end of the run. A polite live region, so a screen reader hears each as it is added and never the whole list
 * again. The pacing's notices and the reset are not events of the run (eventText.ts).
 */
import { useI18n } from '../i18n/context.tsx';
import type { LoggedEvent } from '../sim/store.ts';
import { eventText } from './eventText.ts';
import { MUTED } from './styles.ts';

export function EventLog({ events }: { events: readonly LoggedEvent[] }) {
  const { t, n } = useI18n();
  const lines = events
    .map(({ id, event }) => ({ id, text: eventText(event, t, n) }))
    .filter((line): line is { id: number; text: string } => line.text !== null)
    .reverse();
  return (
    <section aria-labelledby="events-title" className="flex flex-col gap-3">
      <h2 id="events-title" className="font-neu text-xl tracking-tight text-clay-950 dark:text-white">
        {t.events.heading}
      </h2>
      {lines.length === 0 && <p className={`text-sm ${MUTED}`}>{t.events.empty}</p>}
      <ol aria-live="polite" className="grid gap-1.5 text-sm tabular-nums">
        {lines.map((line) => (
          <li
            key={line.id}
            className="rounded-xl border border-clay-200 bg-clay-50 px-3 py-2 dark:border-white/10 dark:bg-night-850"
          >
            {line.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
