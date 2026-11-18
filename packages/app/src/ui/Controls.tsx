/**
 * The commands of the run (Phase 4): play and pause, one control cycle, reset, the vehicle's top speed
 * and the ghost. Each only sends a message; what the run does comes back as frames. The keys (Space, R, right arrow)
 * are in usePageControls; the buttons carry them as `aria-keyshortcuts` and the line under them says them in words.
 *
 * The run always plays in real time. What a visitor changes is the speed the vehicle travels at (sim/speed.ts): a
 * parameter of the simulation, which starts again with it and shows what that speed leads to.
 */
import { useI18n } from '../i18n/context.tsx';
import { format } from '../i18n/index.ts';
import { scenarioSpeedKmh } from '../sim/scenarios.ts';
import { SPEED_RANGE, stepSpeed } from '../sim/speed.ts';
import type { SimulationStore, Snapshot } from '../sim/store.ts';
import { PauseIcon, PlayIcon, ResetIcon, StepIcon } from './icons.tsx';
import { PRIMARY, SECONDARY } from './styles.ts';

const STEPPER =
  'flex size-10 items-center justify-center rounded-full border border-clay-300 bg-white/80 text-lg font-medium text-clay-900 transition duration-200 hover:border-clay-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:bg-night-900/60 dark:text-white';

export function Controls({ store, snapshot }: { store: SimulationStore; snapshot: Snapshot }) {
  const { t, n } = useI18n();
  const ready = snapshot.status === 'ready';
  const ghost = snapshot.config?.ghost ?? true;
  // The speed the scenario is written for, and the one this run has: the visitor's, when one was given.
  const own = scenarioSpeedKmh(snapshot.scenarioId);
  const speed = snapshot.config?.speedKmh ?? own;
  const step = (direction: 1 | -1) => {
    if (speed !== undefined) store.setParams({ speedKmh: stepSpeed(speed, direction) });
  };
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
        {speed !== undefined && (
          <div role="group" aria-label={t.controls.speed} className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden="true"
              className="basis-full text-sm text-clay-600 sm:mr-1 sm:basis-auto dark:text-clay-400"
            >
              {t.controls.speed}
            </span>
            <button
              type="button"
              className={STEPPER}
              disabled={!ready || speed <= SPEED_RANGE.min}
              onClick={() => step(-1)}
              aria-label={format(t.controls.speedDown, { step: SPEED_RANGE.step })}
            >
              <span aria-hidden="true">−</span>
            </button>
            <output
              aria-live="polite"
              className="min-w-22 text-center text-[15px] font-medium tabular-nums text-clay-950 dark:text-white"
            >
              {n(speed, 0)} km/h
            </output>
            <button
              type="button"
              className={STEPPER}
              disabled={!ready || speed >= SPEED_RANGE.max}
              onClick={() => step(1)}
              aria-label={format(t.controls.speedUp, { step: SPEED_RANGE.step })}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        )}

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

      <div className="flex basis-full flex-col gap-1 text-xs text-clay-600 dark:text-clay-400">
        {own !== undefined && <p>{format(t.controls.speedHint, { speed: n(own, 0) })}</p>}
        <p>{t.controls.keys}</p>
      </div>
    </div>
  );
}
