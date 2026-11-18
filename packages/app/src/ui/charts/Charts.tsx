/**
 * The charts of the run (Phase 4): speed, steering, the two accelerations, the g-g diagram, the time to
 * collision and the computation time, as small multiples that share the run's seconds and one cursor. They read the
 * history the store keeps (telemetry.ts) and compute nothing. uPlot comes with this module, which the page loads on
 * demand.
 *
 * One loop redraws them all when the history has grown: at most every CHART_MS while the run plays, at once when it is
 * paused or stepped, and not at all while they are off screen (below the fold, or in the panel of another tab).
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import 'uplot/dist/uPlot.min.css';

import type { SceneInfo } from '@mpc-simulator/worker';

import { useI18n } from '../../i18n/context.tsx';
import { TICK_HZ } from '../../sim/frame.ts';
import type { SimulationStore } from '../../sim/store.ts';
import type { Telemetry, VehicleSeries } from '../../sim/telemetry.ts';
import { CARD_TITLE } from '../styles.ts';
import { useTheme } from '../ThemeProvider.tsx';
import { ChartBus } from './bus.ts';
import './charts.css';
import { GgChart } from './GgChart.tsx';
import { aroundZero, fromZero } from './scales.ts';
import { CHART_DARK, CHART_LIGHT } from './theme.ts';
import { TimeChart, type TimeChartSpec, type TimeSeries } from './TimeChart.tsx';
import { ValuesTable } from './ValuesTable.tsx';

/** The slowest the charts follow a playing run, ms. */
const CHART_MS = 100;
/** The control period, ms: what a control step's time is read against. */
const CONTROL_PERIOD_MS = 50;

function Charts({ store, scene, ghost }: { store: SimulationStore; scene: SceneInfo; ghost: boolean }) {
  const { t } = useI18n();
  const { dark } = useTheme();
  const theme = dark ? CHART_DARK : CHART_LIGHT;
  const bus = useMemo(() => new ChartBus(), []);
  const section = useRef<HTMLElement>(null);
  const duration = scene.ticks / TICK_HZ;

  useEffect(() => {
    const element = section.current;
    if (!element) return;
    let visible = false;
    let seen = -1;
    let last = 0;
    let raf = 0;
    const observer = new IntersectionObserver((entries) => {
      visible = entries.at(-1)?.isIntersecting ?? false;
    });
    observer.observe(element);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const { telemetry, frame } = store;
      if (!visible || telemetry.version === seen) return;
      if (frame?.playing && now - last < CHART_MS) return;
      seen = telemetry.version;
      last = now;
      bus.draw();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [store, bus]);

  // The canvases write their labels in the page's font: when it arrives after them, they are drawn again with it.
  useEffect(() => {
    const redraw = () => bus.draw();
    document.fonts.addEventListener('loadingdone', redraw);
    return () => document.fonts.removeEventListener('loadingdone', redraw);
  }, [bus]);

  // A new run has its own seconds: the cursor of the run before it means nothing in it.
  useEffect(() => bus.cursor.set(null), [bus, scene]);

  const charts = useMemo((): TimeChartSpec[] => {
    const time = (history: Telemetry) => history.time;
    const cycles = (history: Telemetry) => history.decisionTime;
    const vehicles = (column: keyof VehicleSeries): TimeSeries[] => [
      { label: t.view.ego, kind: 'ego', hold: true, column: (history) => history.ego[column] },
      ...(ghost
        ? [{ label: t.view.ghost, kind: 'ghost' as const, hold: true, column: (h: Telemetry) => h.ghost[column] }]
        : []),
    ];
    const mpc = (column: (history: Telemetry) => (number | null)[]): TimeSeries[] => [
      { label: t.view.ego, kind: 'ego', hold: false, column },
    ];
    return [
      {
        id: 'speed',
        title: t.readouts.speed,
        unit: 'km/h',
        time,
        series: vehicles('speed'),
        range: fromZero(20, 40),
        digits: 1,
        duration,
      },
      {
        id: 'steering',
        title: t.readouts.steering,
        unit: '°',
        time,
        series: vehicles('steer'),
        range: aroundZero(1, 2),
        digits: 1,
        duration,
      },
      {
        id: 'ax',
        title: t.readouts.ax,
        unit: 'g',
        symbol: 'ax',
        time,
        series: vehicles('ax'),
        range: aroundZero(0.5, 0.5),
        digits: 2,
        duration,
      },
      {
        id: 'ay',
        title: t.readouts.ay,
        unit: 'g',
        symbol: 'ay',
        time,
        series: vehicles('ay'),
        range: aroundZero(0.5, 0.5),
        digits: 2,
        duration,
      },
      {
        id: 'ttc',
        title: t.charts.ttc,
        unit: 's',
        hint: t.charts.ttcHint,
        time: cycles,
        series: mpc((history) => history.ttc),
        range: fromZero(1, 2),
        digits: 2,
        duration,
      },
      {
        id: 'solver',
        title: t.charts.solver,
        unit: 'ms',
        hint: t.charts.solverHint,
        time: cycles,
        series: mpc((history) => history.stepMs),
        range: fromZero(20, 60),
        digits: 1,
        duration,
        reference: { value: CONTROL_PERIOD_MS, label: t.charts.period },
        className: 'sm:col-span-2',
      },
    ];
  }, [t, ghost, duration]);

  return (
    <section ref={section} aria-labelledby="charts-title" className="flex flex-col gap-4">
      <h2 id="charts-title" className={CARD_TITLE}>
        {t.charts.heading}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {charts.slice(0, 4).map((spec) => (
          <TimeChart key={spec.id} store={store} bus={bus} theme={theme} spec={spec} />
        ))}
        <GgChart store={store} bus={bus} theme={theme} ghost={ghost} />
        {charts.slice(4).map((spec) => (
          <TimeChart key={spec.id} store={store} bus={bus} theme={theme} spec={spec} />
        ))}
      </div>
      <ValuesTable store={store} bus={bus} ghost={ghost} />
    </section>
  );
}

// The screen renders again with its panels, ten times a second while the run plays: the charts only with a new run.
export default memo(Charts);
