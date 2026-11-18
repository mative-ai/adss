/**
 * The 3D view of the run (Phases 4 and 8), a guest of the page: it makes its own canvas and WebGL
 * context when it mounts, redraws in its own animation loop whenever the store has a newer frame, and frees everything
 * when it leaves. This module is the only way to Three.js, and the page loads it on demand: after the access check,
 * and only for a visitor who sees the 3D view.
 *
 * It draws one of two scenes (types.ts): the realistic one, whose module and models come on demand in their turn, or
 * the low-poly one. When the realistic scene cannot be made here, or stays too slow at its lowest resolution with
 * everything it can give up given up, it calls `onDowngrade` and the page mounts the low-poly scene in its place.
 * Without WebGL at all it calls `onUnavailable`, and the page stays on the top view.
 *
 * The drawing's pixels follow the display's density (at most 2) and drop when the frames come late (resolution.ts);
 * the look follows the page's light or dark theme (the visitor's pick, ui/theme.ts); the camera's shake at the ego's impact and the body's lean
 * are left out for a visitor who asked for reduced motion.
 */
import { useEffect, useRef, useState } from 'react';

import type { SceneInfo } from '@mpc-simulator/worker';

import type { SimulationStore } from '../../sim/store.ts';
import type { RoadGeometry } from '../roadGeometry.ts';
import { useTheme } from '../ThemeProvider.tsx';
import { AdaptiveResolution } from './resolution.ts';
import type { Inspection, World } from './types.ts';
import { SceneWorld } from './world.ts';

const MAX_DPR = 2;
/** A gap between two frames of the display longer than this, ms, is a pause (a hidden tab), not a slow frame. */
const PAUSE_MS = 250;

export interface Scene3DProps {
  store: SimulationStore;
  scene: SceneInfo;
  road: RoadGeometry;
  /** The accessible name of the drawing. */
  label: string;
  /** What is said while the realistic scene loads its models. */
  loading: string;
  /** The realistic scene, or the low-poly one. */
  detail: 'real' | 'basic';
  onUnavailable: () => void;
  onDowngrade: () => void;
}

/**
 * On the development server, `?orbit=azimuth,elevation,distance[,obstacle]` looks at the vehicle (or at an obstacle,
 * by its number) from a fixed place, in degrees and meters: for judging a model up close. Not in a build.
 */
function inspection(): Inspection | null {
  if (!import.meta.env.DEV) return null;
  const asked = new URLSearchParams(window.location.search).get('orbit');
  if (!asked) return null;
  const [azimuth = 0, elevation = 15, distance = 8, target] = asked.split(',').map(Number);
  return { azimuth, elevation, distance, target: target === undefined || Number.isNaN(target) ? 'ego' : target };
}

export default function Scene3D({
  store,
  scene,
  road,
  label,
  loading,
  detail,
  onUnavailable,
  onDowngrade,
}: Scene3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<World | null>(null);
  // The run's scene as of the last render, for the effect that makes the world: it must not run again with each run.
  const run = useRef({ scene, road });
  const [ready, setReady] = useState(false);
  const { dark } = useTheme();
  // The theme as of the last render, for the effect that makes the world: a new theme must not make it again.
  const theme = useRef(dark);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'block size-full';
    canvas.setAttribute('aria-hidden', 'true');
    const initial = theme.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let left = false;
    let stop: (() => void) | null = null;

    const begin = (created: World) => {
      element.append(canvas);
      world.current = created;
      created.load(run.current.scene, run.current.road);
      // The visitor may have picked another theme while the world was being made.
      if (theme.current !== initial) created.setTheme(theme.current);
      created.setReducedMotion?.(reduced.matches);
      created.inspect?.(inspection());

      const resolution = new AdaptiveResolution(Math.min(window.devicePixelRatio || 1, MAX_DPR));
      let width = 0;
      let height = 0;
      let seen = -1;
      let seenEvent = store.getSnapshot().events.at(-1)?.id ?? -1;
      let moving = false;
      let last = 0;
      let raf = 0;

      const resize = () => {
        width = element.clientWidth;
        height = element.clientHeight;
        if (width > 0 && height > 0) created.resize(width, height, resolution.scale);
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      const onMotion = () => created.setReducedMotion?.(reduced.matches);
      reduced.addEventListener('change', onMotion);
      const onLost = (event: Event) => {
        event.preventDefault();
        // The low-poly scene is made on a canvas and a context of its own: it may still be drawn.
        if (detail === 'real') onDowngrade();
        else onUnavailable();
      };
      canvas.addEventListener('webglcontextlost', onLost);

      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const elapsed = last === 0 ? 0 : now - last;
        last = now;
        const frame = store.frame;
        if (!frame || width === 0 || height === 0) return;
        const fresh = seen !== store.frameSeq;
        if (!fresh && !moving && !created.stale) return;
        if (fresh) {
          seen = store.frameSeq;
          created.update(frame);
          // The ego's impact shakes the camera, unless the visitor asked for reduced motion.
          const events = store.getSnapshot().events;
          const newest = events.at(-1)?.id ?? -1;
          if (newest > seenEvent) {
            const hit = events.some(
              (e) => e.id > seenEvent && e.event.kind === 'collision' && e.event.vehicle === 'ego',
            );
            if (hit && !reduced.matches) created.shake();
            seenEvent = newest;
          }
        }
        moving = created.render(elapsed);
        // While the run plays the display's cadence says whether the scene is too heavy for this device.
        if (!frame.playing || elapsed <= 0 || elapsed >= PAUSE_MS) return;
        if (resolution.sample(elapsed)) created.resize(width, height, resolution.scale);
        else if (resolution.floor) {
          // Fewer pixels did not help: the scene gives up what it can, and then gives way to the lighter one.
          resolution.floor = false;
          if (!created.degrade?.()) onDowngrade();
        }
      };
      resize();
      raf = requestAnimationFrame(loop);
      setReady(true);

      stop = () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        reduced.removeEventListener('change', onMotion);
        canvas.removeEventListener('webglcontextlost', onLost);
        world.current = null;
        created.dispose();
        canvas.remove();
      };
    };

    if (detail === 'real') {
      import('./real/realWorld.ts')
        .then((module) => module.createRealWorld(canvas, initial, run.current.scene, run.current.road))
        .then(
          (created) => {
            if (left) created.dispose();
            else begin(created);
          },
          () => {
            if (!left) onDowngrade();
          },
        );
    } else {
      let created: World;
      try {
        created = new SceneWorld(canvas, initial);
      } catch {
        onUnavailable();
        return;
      }
      begin(created);
    }

    return () => {
      left = true;
      stop?.();
    };
  }, [store, detail, onUnavailable, onDowngrade]);

  // A new run (another scenario, a reset, new parameters) brings its own scene: the world stays, its content changes.
  useEffect(() => {
    run.current = { scene, road };
    world.current?.load(scene, road);
    if (store.frame) world.current?.update(store.frame);
  }, [store, scene, road]);

  // The visitor picks another theme: the world stays, its light and colors change.
  useEffect(() => {
    theme.current = dark;
    world.current?.setTheme(dark);
  }, [dark]);

  return (
    <div className="relative size-full">
      <div ref={host} role="img" aria-label={label} className="size-full" />
      {!ready && (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center px-4 text-sm text-clay-950 dark:text-white"
        >
          {loading}
        </p>
      )}
    </div>
  );
}
