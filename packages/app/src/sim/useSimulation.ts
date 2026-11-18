/**
 * React's side of the simulation (Phase 4): starts the worker when the screen opens and stops it when it
 * closes, gives the panels the store's snapshot, and wires the page's own controls: the keyboard (Space, R, right arrow)
 * and the pause of a hidden tab (`visibilitychange`), which resumes a run it paused and no other.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import { MOBILE_CONFIG, type SessionConfig } from '@mpc-simulator/worker';

import { FIRST_SCENARIO, scenarioJson } from './scenarios.ts';
import { SimulationStore, type Snapshot } from './store.ts';

const NARROW = '(max-width: 767px)';

/** The configuration of a run on this screen: the mobile preset on a narrow one, the ghost as asked. */
export function runConfig(ghost: boolean): Partial<SessionConfig> {
  return { ...(window.matchMedia(NARROW).matches ? MOBILE_CONFIG : {}), ghost };
}

/** The store of a worker that lives as long as the screen; null until the screen has mounted. */
export function useSimulationStore(): SimulationStore | null {
  const [store, setStore] = useState<SimulationStore | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('../../../worker/src/worker.ts', import.meta.url), { type: 'module' });
    const created = new SimulationStore(worker);
    created.start(FIRST_SCENARIO, scenarioJson(FIRST_SCENARIO), 1, runConfig(true));
    setStore(created);
    return () => {
      created.dispose();
      setStore(null);
    };
  }, []);
  return store;
}

export function useSnapshot(store: SimulationStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** A control that has its own keys (a button, a field) keeps them: the page's shortcuts stay out of its way. */
const OWN_KEYS =
  'button, a, input, select, textarea, summary, [role="radio"], [role="switch"], [role="tab"], [role="slider"]';

export function usePageControls(store: SimulationStore): void {
  useEffect(() => {
    let resume = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest(OWN_KEYS)) return;
      const { playing } = store.getSnapshot();
      if (event.key === ' ') {
        event.preventDefault();
        if (playing) store.pause();
        else store.play();
      } else if (event.key === 'r' || event.key === 'R') {
        store.reset();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!playing) store.step();
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (store.getSnapshot().playing) {
          resume = true;
          store.pause();
        }
      } else if (resume) {
        resume = false;
        store.play();
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [store]);
}
