/**
 * The simulator screen (Phase 4). At 1024 px and above: the scenario on the left, the view with its
 * commands, values and result in the middle, the decisions and the events on the right, and the charts under the three.
 * Below: the view and its commands first, then three switches for the scenario, the decisions and the charts, one panel
 * at a time. The switches are toggle buttons, not tabs: from 1024 px on they are gone and every panel shows, and a tab
 * without its list would be wrong for a screen reader.
 *
 * A run in automatic slow motion says so over the view (the "partial" state), and a message the worker refused says so
 * under the commands; the result appears when the run is over (the "success" state). The charts come with their own
 * module, loaded after the screen is up.
 */
import { lazy, Suspense, useState } from 'react';

import { useI18n } from '../i18n/context.tsx';
import { format } from '../i18n/index.ts';
import { scenarioJson, type ScenarioId } from '../sim/scenarios.ts';
import type { SimulationStore } from '../sim/store.ts';
import { runConfig, usePageControls, useSnapshot } from '../sim/useSimulation.ts';
import { Controls } from './Controls.tsx';
import { DecisionPanel } from './DecisionPanel.tsx';
import { EventLog } from './EventLog.tsx';
import { Readouts } from './Readouts.tsx';
import { Report } from './Report.tsx';
import { ScenarioPicker } from './ScenarioPicker.tsx';
import { Stage } from './Stage.tsx';
import { ErrorState, LoadingState } from './States.tsx';
import { CARD, MUTED } from './styles.ts';

const Charts = lazy(() => import('./charts/Charts.tsx'));

const PANELS = ['scenario', 'decisions', 'charts'] as const;
type Panel = (typeof PANELS)[number];

export function Simulator({ store }: { store: SimulationStore }) {
  const snapshot = useSnapshot(store);
  usePageControls(store);
  const { t, n } = useI18n();
  const [panel, setPanel] = useState<Panel>('scenario');

  if (snapshot.status === 'error') {
    return (
      <ErrorState
        crashed={snapshot.error?.code === 'crash'}
        message={snapshot.error?.message ?? ''}
        onReset={() => store.reset()}
      />
    );
  }
  if (snapshot.status === 'loading' || !snapshot.scene) return <LoadingState />;

  const pick = (scenario: ScenarioId) => store.start(scenario, scenarioJson(scenario), 1, runConfig(ghost));
  const ghost = snapshot.config?.ghost ?? true;
  const titles: Record<Panel, string> = {
    scenario: t.scenario.heading,
    decisions: t.decision.heading,
    charts: t.charts.heading,
  };
  const switchClass = (on: boolean) =>
    `min-h-11 flex-1 rounded-full px-2 text-[15px] font-medium transition duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
      on ? 'bg-primary text-ink' : 'text-clay-900 dark:text-white'
    }`;
  // Below 1024 px one panel shows at a time; from there on all of them do.
  const shown = (on: boolean) => (on ? '' : 'hidden lg:block');

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[300px_minmax(0,1fr)_340px] lg:items-start lg:gap-8">
      <section aria-label={t.scenario.heading} className={`order-3 lg:order-none ${shown(panel === 'scenario')}`}>
        <ScenarioPicker selected={snapshot.scenarioId} disabled={false} onPick={pick} />
      </section>

      <div className="order-1 flex min-w-0 flex-col gap-5 lg:order-none">
        {snapshot.slowMotion !== null && (
          <div role="status" className={`${CARD} border-primary py-4 md:py-4`}>
            <p className="font-medium text-clay-950 dark:text-white">{t.slow.title}</p>
            <p className={`text-sm ${MUTED}`}>{format(t.slow.body, { rate: `${n(snapshot.slowMotion, 2)}×` })}</p>
          </div>
        )}
        <Stage store={store} scene={snapshot.scene} ghost={ghost} />
        <Controls store={store} snapshot={snapshot} />
        <Readouts readout={snapshot.readout} />
        {snapshot.notice && (
          <p
            role="alert"
            className="rounded-2xl border border-clay-300 bg-clay-50 px-4 py-3 text-sm dark:border-white/15 dark:bg-night-850"
          >
            {format(t.error.refused, { message: snapshot.notice.message })}
          </p>
        )}
        {snapshot.done && snapshot.metrics && <Report metrics={snapshot.metrics} />}
      </div>

      <div className="order-2 flex gap-1 rounded-full border border-clay-200 bg-clay-50 p-1 lg:hidden dark:border-white/10 dark:bg-night-850">
        {PANELS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={panel === name}
            className={switchClass(panel === name)}
            onClick={() => setPanel(name)}
          >
            {titles[name]}
          </button>
        ))}
      </div>

      <section
        aria-label={t.decision.heading}
        className={`order-3 flex flex-col gap-8 lg:order-none ${panel === 'decisions' ? '' : 'hidden lg:flex'}`}
      >
        <DecisionPanel decision={snapshot.decision} />
        <EventLog events={snapshot.events} />
      </section>

      <div className={`order-3 min-w-0 lg:order-none lg:col-span-3 ${shown(panel === 'charts')}`}>
        <Suspense fallback={null}>
          <Charts store={store} scene={snapshot.scene} ghost={ghost} />
        </Suspense>
      </div>
    </div>
  );
}
