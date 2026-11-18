/**
 * The commands of the run (Phase 4): play and pause, one control cycle, reset, the playback speed and the
 * ghost. Each only sends a message; what the run does comes back as frames. The keys (Space, R, right arrow) are in
 * usePageControls; the buttons carry them as `aria-keyshortcuts` and the line under them says them in words.
 */
import { useI18n } from '../i18n/context.tsx';
import type { SimulationStore, Snapshot } from '../sim/store.ts';
import { PauseIcon, PlayIcon, ResetIcon, StepIcon } from './icons.tsx';
import { PRIMARY, SECONDARY } from './styles.ts';

/** The playback rates offered, 1 being real time (the worker accepts 0.05 to 4). */
const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

const SEGMENT =
  'min-h-10 min-w-11 rounded-full px-2.5 text-sm font-medium tabular-nums transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

export function Controls({ store, snapshot }: { store: SimulationStore; snapshot: Snapshot }) {
  const { t, n } = useI18n();
  const ready = snapshot.status === 'ready';
  const ghost = snapshot.config?.ghost ?? true;
  const label = (rate: number) => `${n(rate, rate < 1 ? 2 : 0)}×`;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.playing ? (
          <button type="button" className={PRIMARY} onClick={() => store.pause()} aria-keyshortcuts="Space">
            <PauseIcon />
            {t.controls.pause}
          </button>
        ) : (
          <button
            type="button"
            className={PRIMARY}
            onClick={() => store.play()}
            disabled={!ready || snapshot.done}
            aria-keyshortcuts="Space"
          >
            <PlayIcon />
            {t.controls.play}
          </button>
        )}
        <button
          type="button"
          className={SECONDARY}
          onClick={() => store.step()}
          disabled={!ready || snapshot.playing || snapshot.done}
          title={t.controls.stepHint}
          aria-label={`${t.controls.step}: ${t.controls.stepHint}`}
          aria-keyshortcuts="ArrowRight"
        >
          <StepIcon />
          {t.controls.step}
        </button>
        <button
          type="button"
          className={SECONDARY}
          onClick={() => store.reset()}
          disabled={!ready}
          aria-keyshortcuts="R"
        >
          <ResetIcon />
          {t.controls.reset}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="radiogroup" aria-label={t.controls.speed} className="flex flex-wrap items-center gap-1">
          <span
            aria-hidden="true"
            className="basis-full text-sm text-clay-600 sm:mr-2 sm:basis-auto dark:text-clay-400"
          >
            {t.controls.speed}
          </span>
          {SPEEDS.map((rate) => {
            const on = snapshot.speed === rate;
            return (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!ready}
                onClick={() => store.setSpeed(rate)}
                className={`${SEGMENT} ${
                  on
                    ? 'bg-primary text-ink'
                    : 'border border-clay-300 bg-white/80 text-clay-900 hover:border-clay-400 dark:border-white/15 dark:bg-night-900/60 dark:text-white'
                }`}
              >
                {label(rate)}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={ghost}
          disabled={!ready}
          onClick={() => store.setParams({ ghost: !ghost })}
          title={t.controls.ghostHint}
          className="flex min-h-10 items-center gap-3 rounded-full px-1 text-sm font-medium text-clay-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:text-white"
        >
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full border p-0.5 transition duration-200 ${
              ghost
                ? 'justify-end border-primary bg-primary'
                : 'justify-start border-clay-300 bg-clay-200 dark:border-white/15 dark:bg-night-700'
            }`}
          >
            <span className="size-4.5 rounded-full bg-white shadow dark:bg-night-950" />
          </span>
          {t.controls.ghost}
        </button>
      </div>

      <p className="basis-full text-xs text-clay-600 dark:text-clay-400">{t.controls.keys}</p>
    </div>
  );
}
