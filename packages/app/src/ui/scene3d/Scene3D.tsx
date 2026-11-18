/**
 * The 3D view of the run (Phases 4 and 8), a guest of the page: it makes its own canvas and WebGL
 * context when it mounts, redraws in its own animation loop whenever the store has a newer frame, and frees everything
 * when it leaves. This module is the only way to Three.js, and the page loads it on demand, and only for a visitor
 * who sees the 3D view.
 *
 * It draws one of two scenes (types.ts): the realistic one, whose module and models come on demand in their turn, or
 * the low-poly one. When the realistic scene cannot be made here, or stays too slow at its lowest resolution with
 * everything it can give up given up, it calls `onDowngrade` and the page mounts the low-poly scene in its place.
 * Without WebGL at all it calls `onUnavailable`, and the page stays on the top view.
 *
 * The drawing's pixels follow the display's density (at most 2) and drop when the frames come late (resolution.ts);
 * the look follows the page's light or dark theme (the visitor's pick, ui/theme.ts); the camera's shake at the ego's impact and the body's lean
 * are left out for a visitor who asked for reduced motion.
 *
 * With a mouse the visitor looks at the vehicle from where they like (camera.ts): a drag turns the view around it, the
 * wheel brings it closer or farther, and a double click, or the button that appears, gives the camera back to the road.
 */
import { useEffect, useRef, useState } from 'react';

import type { SceneInfo } from '@mpc-simulator/worker';

import type { SimulationStore } from '../../sim/store.ts';
import type { RoadGeometry } from '../roadGeometry.ts';
import { useTheme } from '../ThemeProvider.tsx';
import { CHASE_ORBIT, dragOrbit, zoomOrbit, type Orbit } from './camera.ts';
import { AdaptiveResolution } from './resolution.ts';
import type { Inspection, World } from './types.ts';
import { SceneWorld } from './world.ts';

const MAX_DPR = 2;
/** A gap between two frames of the display longer than this, ms, is a pause (a hidden tab), not a slow frame. */
const PAUSE_MS = 250;
/** The pixels a pressed mouse moves before its move is a drag of the view. */
const DRAG_START = 3;

export interface Scene3DProps {
  store: SimulationStore;
  scene: SceneInfo;
  road: RoadGeometry;
  /** The accessible name of the drawing. */
  label: string;
  /** What is said while the realistic scene loads its models. */
  loading: string;
  /** The name of the button that gives the camera back to the road, after a visitor moved it. */
  resetView: string;
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
  resetView,
  detail,
  onUnavailable,
  onDowngrade,
}: Scene3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<World | null>(null);
  // Whether the visitor holds the camera, and the way to give it back to the road from outside the effect.
  const [orbiting, setOrbiting] = useState(false);
  const giveBack = useRef<() => void>(() => undefined);
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

      // The visitor's own view, with the mouse: a drag turns it around the vehicle, the wheel brings it closer or
      // farther, a double click gives the camera back to the road. A finger still scrolls the page.
      let orbit: Orbit | null = null;
      let drag: { id: number; x: number; y: number; turned: boolean } | null = null;
      const look = (next: Orbit | null) => {
        orbit = next;
        created.orbit(next);
        setOrbiting(next !== null);
      };
      giveBack.current = () => look(null);
      const onDown = (event: PointerEvent) => {
        if (event.pointerType === 'touch' || event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, turned: false };
        element.setPointerCapture(event.pointerId);
      };
      const onMove = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        // A click that slips a pixel or two is not a drag.
        if (!drag.turned && Math.hypot(dx, dy) < DRAG_START) return;
        drag.turned = true;
        drag.x = event.clientX;
        drag.y = event.clientY;
        element.style.cursor = 'grabbing';
        look(dragOrbit(orbit ?? CHASE_ORBIT, dx, dy));
      };
      const onUp = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        element.style.cursor = '';
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      };
      const onWheel = (event: WheelEvent) => {
        const from = orbit ?? CHASE_ORBIT;
        const next = zoomOrbit(from, event.deltaY);
        // At either end of its range the wheel is the page's again.
        if (next.distance === from.distance) return;
        event.preventDefault();
        look(next);
      };
      const onDouble = () => look(null);
      element.addEventListener('pointerdown', onDown);
      element.addEventListener('pointermove', onMove);
      element.addEventListener('pointerup', onUp);
      element.addEventListener('pointercancel', onUp);
      element.addEventListener('wheel', onWheel, { passive: false });
      element.addEventListener('dblclick', onDouble);
      // A place asked for in the address (the development server's): the vehicle's is the visitor's view from the
      // start, an obstacle's is an inspection of its own.
      const asked = inspection();
      if (asked?.target === 'ego') look(asked);
      else created.inspect?.(asked);

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
        element.removeEventListener('pointerdown', onDown);
        element.removeEventListener('pointermove', onMove);
        element.removeEventListener('pointerup', onUp);
        element.removeEventListener('pointercancel', onUp);
        element.removeEventListener('wheel', onWheel);
        element.removeEventListener('dblclick', onDouble);
        element.style.cursor = '';
        giveBack.current = () => undefined;
        setOrbiting(false);
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
      <div ref={host} role="img" aria-label={label} className="size-full [@media(pointer:fine)]:cursor-grab" />
      {orbiting && (
        <button
          type="button"
          onClick={() => giveBack.current()}
          className="absolute bottom-3 left-3 min-h-9 rounded-full border border-white/70 bg-white/85 px-3.5 text-sm font-medium text-clay-900 shadow-[0_10px_30px_-18px_rgba(20,24,18,0.6)] backdrop-blur transition duration-200 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:border-white/10 dark:bg-night-900/85 dark:text-white dark:hover:bg-night-800"
        >
          {resetView}
        </button>
      )}
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
