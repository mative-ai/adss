/**
 * The top view of the run (Phase 4): a canvas the animation loop redraws whenever the store has a newer
 * frame, at the display's rate and not React's, and a legend in text, so that what the drawings say by color is also
 * said in words and in the shape of their lines (drawScene.ts). The same canvas, framed wider, is the mini-map over the
 * 3D scene. Its pixels follow its size and the screen's density (at most 2), and the palette follows the light or dark
 * theme of the system.
 */
import { useEffect, useRef } from 'react';

import type { SceneInfo } from '@mpc-simulator/worker';

import { useI18n } from '../i18n/context.tsx';
import { format } from '../i18n/index.ts';
import type { SimulationStore } from '../sim/store.ts';
import { DARK, drawScene, LIGHT, type TopViewOptions } from './drawScene.ts';
import type { RoadGeometry } from './roadGeometry.ts';
import { useTheme } from './ThemeProvider.tsx';

const MAX_DPR = 2;

export interface TopCanvasProps {
  store: SimulationStore;
  scene: SceneInfo;
  road: RoadGeometry;
  /** How the road is framed: the view on its own, or the mini-map. */
  view: TopViewOptions;
  /** The accessible name of the drawing. */
  label: string;
  className: string;
}

export function TopCanvas({ store, scene, road, view, label, className }: TopCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { dark } = useTheme();

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let dirty = true;
    let seen = -1;
    let raf = 0;

    const resize = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const frame = store.frame;
      if (!frame || width === 0 || (!dirty && seen === store.frameSeq)) return;
      dirty = false;
      seen = store.frameSeq;
      drawScene(ctx, road, scene, frame, width, height, dpr, dark ? DARK : LIGHT, view);
    };
    resize();
    loop();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
    // A new theme draws the view again: the effect starts over with the colors of the new one.
  }, [store, scene, road, view, dark]);

  return <canvas ref={canvas} role="img" aria-label={label} className={className} />;
}

/** A 28 by 16 swatch of how a thing is drawn: the same shape and line as the drawing's, in the drawing's colors. */
function Swatch({ children }: { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 16" className="h-4 w-7 shrink-0" fill="none">
      {children}
    </svg>
  );
}

const INK = 'text-clay-950 dark:text-white';

/** What the view shows, in words: the same for the top view, the mini-map and the 3D scene. */
export function Legend({ scene, ghost }: { scene: SceneInfo; ghost: boolean }) {
  const { t, n } = useI18n();
  const surfaces = t.view.surfaces;
  const zoneText = (id: string, mu: number) =>
    format(t.view.zone, { surface: surfaces[id as keyof typeof surfaces] ?? id, mu: n(mu, 1) });
  const item = 'flex items-center gap-2';
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <li className={item}>
        <Swatch>
          <rect x="3" y="3" width="22" height="10" rx="2" className="fill-primary stroke-ink" strokeWidth="1.5" />
        </Swatch>
        {t.view.ego}
      </li>
      {ghost && (
        <li className={item}>
          <Swatch>
            <rect
              x="3"
              y="3"
              width="22"
              height="10"
              rx="2"
              className={`stroke-current ${INK}`}
              strokeWidth="1.5"
              strokeDasharray="4 2.5"
            />
          </Swatch>
          {t.view.ghost}
        </li>
      )}
      <li className={item}>
        <Swatch>
          <path d="M2 8H26" className="stroke-ink dark:stroke-night-950" strokeWidth="6" strokeLinecap="round" />
          <path d="M2 8H26" className="stroke-primary" strokeWidth="3.5" strokeLinecap="round" />
        </Swatch>
        {t.view.chosenPlan}
      </li>
      <li className={item}>
        <Swatch>
          <path d="M2 8H26" className={`stroke-current ${INK}`} strokeWidth="1.5" strokeDasharray="4 4" />
        </Swatch>
        {t.view.otherPlans}
      </li>
      <li className={item}>
        <Swatch>
          <circle cx="14" cy="8" r="6" className={`stroke-current ${INK}`} strokeWidth="1.5" strokeDasharray="3 3" />
          <rect x="11.5" y="5.5" width="5" height="5" className={`fill-current ${INK}`} />
        </Swatch>
        {t.view.obstacle}
      </li>
      <li className={item}>
        <Swatch>
          <circle cx="14" cy="8" r="6" className="stroke-primary-700 dark:stroke-primary-300" strokeWidth="2" />
          <rect x="11.5" y="5.5" width="5" height="5" className={`fill-current ${INK}`} />
        </Swatch>
        {t.view.obstacle}, {t.view.detected}
      </li>
      {[{ key: 'base', id: scene.surface.base.id, mu: scene.surface.base.mu, hatched: false }]
        .concat(scene.surface.zones.map((z, i) => ({ key: `zone${i}`, id: z.id, mu: z.mu, hatched: true })))
        .map(({ key, id, mu, hatched }) => (
          <li key={key} className={item}>
            <Swatch>
              <rect x="1" y="1" width="26" height="14" rx="2" className="fill-clay-500 dark:fill-night-600" />
              {hatched && (
                <path
                  d="M3 15L9 1M9 15L15 1M15 15L21 1M21 15L27 1"
                  className="stroke-clay-50 dark:stroke-white/70"
                  strokeWidth="1.6"
                />
              )}
            </Swatch>
            {zoneText(id, mu)}
          </li>
        ))}
    </ul>
  );
}
