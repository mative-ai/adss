/**
 * A chart of the run over time (Phase 4), drawn by uPlot: one or two lines against the seconds of the
 * run, on one vertical axis. The MPC's line is green and solid, the ghost's neutral and dashed; the names of the lines
 * and their values are in text over the plot, so nothing is read from the color alone.
 *
 * The values over the plot are the run's latest, or those at the cursor: the instant the pointer is at on any chart
 * (bus.ts), which every chart marks with a hairline and a dot on each line. The keyboard moves the same cursor: the
 * plot is a slider (left and right arrows, a tenth of a second; with Shift, a second; Home, End; Escape lets go).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import uPlot from 'uplot';

import { useI18n } from '../../i18n/context.tsx';
import { format } from '../../i18n/index.ts';
import type { SimulationStore } from '../../sim/store.ts';
import { slotAt, type Column, type Telemetry } from '../../sim/telemetry.ts';
import { CARD, MUTED } from '../styles.ts';
import type { ChartBus } from './bus.ts';
import { tickDigits, type AxisRange } from './scales.ts';
import { CHART_FONT, type ChartTheme } from './theme.ts';

export interface TimeSeries {
  label: string;
  kind: 'ego' | 'ghost';
  column: (telemetry: Telemetry) => Column;
  /**
   * What the line reads as "now" where its last slots are empty: a vehicle that has ended keeps its last value, a
   * quantity that comes and goes (the TTC) has none.
   */
  hold: boolean;
}

export interface TimeChartSpec {
  id: string;
  title: string;
  unit: string;
  /** The quantity's symbol, where the g-g diagram names it by one (ax, ay). */
  symbol?: string;
  hint?: string;
  /** The times the lines are drawn against, s. */
  time: (telemetry: Telemetry) => number[];
  series: TimeSeries[];
  range: AxisRange;
  /** Decimals of the values read over the plot. */
  digits: number;
  /** The run's duration, s: the horizontal axis goes from 0 to it. */
  duration: number;
  /** A level the values are read against, drawn as a dashed line with its name. */
  reference?: { value: number; label: string };
  /** The tile's own classes: its span in the grid. */
  className?: string;
}

/** The plot's height, CSS pixels, with its horizontal axis. */
const HEIGHT = 150;

interface Reading {
  /** The instant under the cursor, s; null when the values are the latest. */
  at: number | null;
  /** The time of the latest sample, s. */
  latest: number;
  values: (number | null)[];
}

/** How a line is drawn, beside its name: the same stroke and dash as in the plot. */
function LineKey({ kind, theme }: { kind: TimeSeries['kind']; theme: ChartTheme }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 8" className="h-2 w-4.5 shrink-0" fill="none">
      <path
        d="M1 4H17"
        stroke={kind === 'ego' ? theme.ego : theme.ghost}
        strokeWidth={kind === 'ego' ? 2 : 1.5}
        strokeDasharray={kind === 'ego' ? undefined : '5 3'}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TimeChart({
  store,
  bus,
  theme,
  spec,
}: {
  store: SimulationStore;
  bus: ChartBus;
  theme: ChartTheme;
  spec: TimeChartSpec;
}) {
  const { t, n } = useI18n();
  const plot = useRef<HTMLDivElement>(null);
  const [reading, setReading] = useState<Reading>({ at: null, latest: 0, values: [] });

  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const telemetry = store.telemetry;
    const color = (kind: TimeSeries['kind']) => (kind === 'ego' ? theme.ego : theme.ghost);
    let chart: uPlot | null = null;
    let hovering = false;

    const data = (): uPlot.AlignedData => [spec.time(telemetry), ...spec.series.map((s) => s.column(telemetry))];

    const read = () => {
      const times = spec.time(telemetry);
      const at = bus.cursor.get();
      const slot = at === null ? times.length - 1 : slotAt(times, at);
      const values = spec.series.map((s) => {
        const column = s.column(telemetry);
        if (at !== null || !s.hold) return slot < 0 ? null : (column[slot] ?? null);
        for (let i = slot; i >= 0; i--) {
          const value = column[i];
          if (value != null) return value;
        }
        return null;
      });
      setReading({ at, latest: times.at(-1) ?? 0, values });
    };

    /** Puts the plot's own cursor where the shared one is, without telling the others again. */
    const place = () => {
      if (!chart) return;
      const at = bus.cursor.get();
      if (at === null) chart.setCursor({ left: -10, top: -10 }, false);
      else chart.setCursor({ left: chart.valToPos(at, 'x'), top: HEIGHT / 2 }, false);
    };

    const reference = (u: uPlot) => {
      if (!spec.reference) return;
      const ratio = window.devicePixelRatio || 1;
      const y = Math.round(u.valToPos(spec.reference.value, 'y', true));
      const { left, top, width, height } = u.bbox;
      if (y < top || y > top + height) return;
      const ctx = u.ctx;
      ctx.save();
      ctx.strokeStyle = theme.text;
      ctx.lineWidth = ratio;
      ctx.setLineDash([4 * ratio, 4 * ratio]);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(left + width, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.font = CHART_FONT.replace('11px', `${11 * ratio}px`);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(spec.reference.label, left + width - 4 * ratio, y - 3 * ratio);
      ctx.restore();
    };

    const build = (width: number): uPlot => {
      const axis = (size: number, write: (value: number, step: number) => string): uPlot.Axis => ({
        stroke: theme.text,
        font: CHART_FONT,
        size,
        gap: 4,
        ticks: { show: false },
        grid: { stroke: theme.grid, width: 1 },
        values: (_u, splits, _axis, _space, step) => splits.map((value) => write(value, step)),
      });
      const options: uPlot.Options = {
        width,
        height: HEIGHT,
        padding: [8, 14, 0, 0],
        legend: { show: false },
        cursor: {
          y: false,
          drag: { x: false, y: false, setScale: false },
          points: {
            size: 9,
            width: 2,
            stroke: () => theme.surface,
            fill: (_u, index) => color(spec.series[index - 1]?.kind ?? 'ego'),
          },
        },
        scales: {
          x: { time: false, range: () => [0, spec.duration] },
          y: { range: (_u, min, max) => spec.range(min, max) },
        },
        axes: [
          axis(26, (value, step) => `${n(value, tickDigits(step))} s`),
          axis(42, (value, step) => n(value, tickDigits(step))),
        ],
        series: [
          {},
          ...spec.series.map((s): uPlot.Series => ({
            stroke: color(s.kind),
            width: s.kind === 'ego' ? 2 : 1.5,
            ...(s.kind === 'ghost' ? { dash: [6, 4] } : {}),
            points: { show: false },
            spanGaps: false,
          })),
        ],
        hooks: {
          // uPlot moves its own cursor under the pointer: the chart the pointer is on tells the others where.
          setCursor: [
            (u) => {
              if (!hovering) return;
              const left = u.cursor.left ?? -1;
              bus.cursor.set(left < 0 ? null : Math.min(Math.max(u.posToVal(left, 'x'), 0), spec.duration));
            },
          ],
          draw: [reference],
        },
      };
      return new uPlot(options, data(), element);
    };

    const draw = () => {
      if (!chart) return;
      chart.setData(data());
      place();
      read();
    };
    const onCursor = () => {
      place();
      read();
    };
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      // A hidden plot (the panel of another tab) has no width: it is made when it first shows.
      if (width === 0) return;
      if (chart) chart.setSize({ width, height: HEIGHT });
      else chart = build(width);
      onCursor();
    });
    observer.observe(element);
    const enter = () => {
      hovering = true;
    };
    const leave = () => {
      hovering = false;
      bus.cursor.set(null);
    };
    element.addEventListener('mouseenter', enter);
    element.addEventListener('mouseleave', leave);
    const offDraw = bus.register(draw);
    const offCursor = bus.cursor.subscribe(onCursor);
    read();

    return () => {
      offDraw();
      offCursor();
      observer.disconnect();
      element.removeEventListener('mouseenter', enter);
      element.removeEventListener('mouseleave', leave);
      chart?.destroy();
    };
  }, [store, bus, theme, spec, n]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const now = bus.cursor.get() ?? reading.latest;
    const step = event.shiftKey ? 1 : 0.1;
    let next: number | null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, now - step);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(reading.latest, now + step);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = reading.latest;
    else if (event.key === 'Escape') next = null;
    else return;
    event.preventDefault();
    bus.cursor.set(next === null ? null : Math.round(next * 100) / 100);
  };

  // The unit is in the tile's corner, once: the values under it are numbers alone, and a screen reader hears both.
  const text = (value: number | null | undefined) => (value == null ? t.report.none : n(value, spec.digits));
  const shown = reading.at ?? reading.latest;
  const spoken = spec.series
    .map((s, i) => `${s.label} ${text(reading.values[i])}${reading.values[i] == null ? '' : ` ${spec.unit}`}`)
    .join(', ');
  const corner = [
    reading.at === null ? null : format(t.charts.at, { time: n(reading.at, 2) }),
    spec.symbol,
    spec.unit,
  ].filter((part) => part != null);

  return (
    <figure className={`${CARD} flex min-w-0 flex-col gap-3 p-4 md:p-5 ${spec.className ?? ''}`}>
      <figcaption className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-medium text-clay-950 dark:text-white">{spec.title}</h3>
          <span className={`shrink-0 text-xs tabular-nums ${MUTED}`}>{corner.join(' · ')}</span>
        </div>
        {spec.hint && <p className={`text-xs ${MUTED}`}>{spec.hint}</p>}
        <dl className="flex min-h-6 flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
          {spec.series.map((s, i) => (
            <div key={s.kind} className="flex items-baseline gap-1.5">
              <dt className={`flex items-center gap-1.5 text-xs ${MUTED} ${spec.series.length > 1 ? '' : 'sr-only'}`}>
                <LineKey kind={s.kind} theme={theme} />
                {s.label}
              </dt>
              <dd className="font-medium text-clay-950 dark:text-white">{text(reading.values[i])}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
      <div
        ref={plot}
        role="slider"
        tabIndex={0}
        aria-label={format(t.charts.scrub, { title: spec.title })}
        aria-valuemin={0}
        aria-valuemax={spec.duration}
        aria-valuenow={shown}
        aria-valuetext={`${n(shown, 2)} s: ${spoken}`}
        onKeyDown={onKey}
        onBlur={() => bus.cursor.set(null)}
        className="h-37.5 min-w-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      />
    </figure>
  );
}
