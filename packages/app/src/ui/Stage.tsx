/**
 * The view of the run (Phase 4): the 3D scene with the mini-map over it, or the top view, with a switch
 * between the two and the legend under them. The 3D scene is the default; the top view is, for a visitor who asked for
 * reduced motion. Three.js comes with the 3D scene's module, loaded on demand, and not at all for who stays on the top
 * view.
 *
 * Where the 3D scene cannot be drawn (no WebGL, a lost context, a module that does not load) the top view stays and a
 * line says so: the "partial" state.
 *
 * In the wide layout the 3D scene is the realistic one (Phase 8), and a line under the legend says that the lean of
 * the vehicle's body is an effect, not a result. In the narrow layout, or where the realistic scene cannot be made or
 * is too slow, the low-poly scene of Phase 4 is drawn in its place.
 */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import type { SceneInfo } from '@mpc-simulator/worker';

import { useI18n } from '../i18n/context.tsx';
import type { SimulationStore } from '../sim/store.ts';
import { Boundary } from './Boundary.tsx';
import { MAIN_VIEW, MINI_VIEW } from './drawScene.ts';
import { RoadGeometry } from './roadGeometry.ts';
import { MUTED } from './styles.ts';
import { Legend, TopCanvas } from './TopView.tsx';
import { REDUCED_MOTION_QUERY, useMediaQuery } from './useMedia.ts';

const Scene3D = lazy(() => import('./scene3d/Scene3D.tsx'));

type Mode = '3d' | 'top';

/** From this width on the page has its three columns, and the 3D view is the realistic scene. */
const WIDE_QUERY = '(min-width: 1024px)';

const SEGMENT =
  'min-h-9 rounded-full px-3.5 text-sm font-medium transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50';

/** Tells the stage that the 3D scene failed, once it is on screen in its place. */
function Failed({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return null;
}

function Loading() {
  const { t } = useI18n();
  return (
    <div role="status" className="flex size-full items-center justify-center gap-3 px-4">
      <span
        aria-hidden="true"
        className="block size-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/15 motion-safe:animate-pulse"
      />
      <p className="text-sm text-clay-950 dark:text-white">{t.view.loading3d}</p>
    </div>
  );
}

function StageView({ store, scene, ghost }: { store: SimulationStore; scene: SceneInfo; ghost: boolean }) {
  const { t } = useI18n();
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  // The visitor's choice; until there is one the view follows the system's setting for motion.
  const [picked, setPicked] = useState<Mode | null>(null);
  const [available, setAvailable] = useState(true);
  const unavailable = useCallback(() => setAvailable(false), []);
  // The realistic scene is for the wide layout; where it cannot be made, or is too slow, the low-poly one takes over.
  const wide = useMediaQuery(WIDE_QUERY);
  const [plain, setPlain] = useState(false);
  const downgrade = useCallback(() => setPlain(true), []);
  const detail = wide && !plain ? 'real' : 'basic';
  const road = useMemo(() => new RoadGeometry(scene), [scene]);
  const mode: Mode = available ? (picked ?? (reduced ? 'top' : '3d')) : 'top';

  const choices: { id: Mode; label: string; disabled: boolean }[] = [
    { id: '3d', label: t.view.mode3d, disabled: !available },
    { id: 'top', label: t.view.modeTop, disabled: false },
  ];

  return (
    <div>
      <div className="relative h-[clamp(280px,50vh,540px)] overflow-hidden rounded-3xl border border-clay-200 bg-clay-200 dark:border-white/10 dark:bg-night-950">
        {mode === '3d' ? (
          <Boundary fallback={() => <Failed onMount={unavailable} />}>
            <Suspense fallback={<Loading />}>
              <Scene3D
                key={detail}
                store={store}
                scene={scene}
                road={road}
                label={t.view.label3d}
                loading={t.view.loading3d}
                detail={detail}
                onUnavailable={unavailable}
                onDowngrade={downgrade}
              />
            </Suspense>
            <TopCanvas
              store={store}
              scene={scene}
              road={road}
              view={MINI_VIEW}
              label={t.view.minimap}
              className="pointer-events-none absolute right-3 top-3 block h-36 w-24 rounded-2xl border border-clay-300 shadow-[0_10px_30px_-18px_rgba(20,24,18,0.6)] sm:h-44 sm:w-32 dark:border-white/15"
            />
          </Boundary>
        ) : (
          <TopCanvas
            store={store}
            scene={scene}
            road={road}
            view={MAIN_VIEW}
            label={t.view.label}
            className="block size-full"
          />
        )}

        <div
          role="radiogroup"
          aria-label={t.view.mode}
          className="absolute left-3 top-3 flex gap-1 rounded-full border border-white/70 bg-white/85 p-1 shadow-[0_10px_30px_-18px_rgba(20,24,18,0.6)] backdrop-blur dark:border-white/10 dark:bg-night-900/85"
        >
          {choices.map(({ id, label, disabled }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              disabled={disabled}
              onClick={() => setPicked(id)}
              className={`${SEGMENT} ${mode === id ? 'bg-primary text-ink' : 'text-clay-900 hover:bg-clay-100 dark:text-white dark:hover:bg-night-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!available && (
        <p role="status" className={`mt-3 text-sm ${MUTED}`}>
          {t.view.noWebgl}
        </p>
      )}
      <Legend scene={scene} ghost={ghost} />
      {mode === '3d' && detail === 'real' && !reduced && <p className={`mt-2 text-[13px] ${MUTED}`}>{t.view.lean}</p>}
    </div>
  );
}

// The screen renders again with its panels, ten times a second while the run plays: the view only with a new run.
export const Stage = memo(StageView);
