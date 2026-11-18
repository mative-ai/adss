/**
 * The g-g diagram (Phase 4): the lateral acceleration against the longitudinal one, with the circles of
 * half a g and of one g, drawn on a Canvas 2D (it is not a chart over time, so not uPlot's). Acceleration to the left
 * is to the left and acceleration forward is up, as in the views of the road. The MPC's path is green and solid with a
 * filled dot where it is now; the ghost's is neutral and dashed with a hollow dot. The two accelerations together are
 * read in text over the diagram, now or at the charts' cursor (bus.ts).
 */
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import { format } from '../../i18n/index.ts';
import type { SimulationStore } from '../../sim/store.ts';
import { slotAt, type VehicleSeries } from '../../sim/telemetry.ts';
import { CARD, MUTED } from '../styles.ts';
import type { ChartBus } from './bus.ts';
import { CHART_FONT, type ChartTheme } from './theme.ts';

/** The acceleration at the diagram's edge, g: the circle of one g fits inside it. */
const EDGE_G = 1.25;
const MAX_DPR = 2;

interface Reading {
  at: number | null;
  ego: number | null;
  ghost: number | null;
}

/** The last slot at or before `slot` where the vehicle has a value; -1 when it has none. */
function lastSlot(vehicle: VehicleSeries, slot: number): number {
  for (let i = Math.min(slot, vehicle.ax.length - 1); i >= 0; i--) if (vehicle.ax[i] != null) return i;
  return -1;
}

export function GgChart({
  store,
  bus,
  theme,
  ghost,
}: {
  store: SimulationStore;
  bus: ChartBus;
  theme: ChartTheme;
  ghost: boolean;
}) {
  const { t, n } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [reading, setReading] = useState<Reading>({ at: null, ego: null, ghost: null });

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const telemetry = store.telemetry;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const draw = () => {
      const at = bus.cursor.get();
      const slot = at === null ? telemetry.time.length - 1 : slotAt(telemetry.time, at);
      const egoSlot = lastSlot(telemetry.ego, slot);
      const ghostSlot = ghost ? lastSlot(telemetry.ghost, slot) : -1;
      const total = (vehicle: VehicleSeries, i: number) =>
        i < 0 ? null : Math.hypot(vehicle.ax[i] ?? 0, vehicle.ay[i] ?? 0);
      setReading({ at, ego: total(telemetry.ego, egoSlot), ghost: total(telemetry.ghost, ghostSlot) });
      if (width === 0) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) / 2 - 6;
      const scale = radius / EDGE_G;
      // Acceleration to the left (a_y > 0) goes left, acceleration forward (a_x > 0) goes up.
      const px = (ay: number) => cx - ay * scale;
      const py = (ax: number) => cy - ax * scale;

      // The circles of half a g and of one g, and the two axes: solid hairlines.
      ctx.lineWidth = 1;
      ctx.strokeStyle = theme.grid;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const g of [0.5, 1]) {
        ctx.moveTo(cx + g * scale, cy);
        ctx.arc(cx, cy, g * scale, 0, 2 * Math.PI);
      }
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.font = CHART_FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const diagonal = Math.SQRT1_2 * scale;
      ctx.fillText(`${n(1, 0)} g`, cx + diagonal + 4, cy - diagonal - 4);
      ctx.fillText(n(0.5, 1), cx + 0.5 * diagonal + 3, cy - 0.5 * diagonal - 3);
      ctx.fillText('ax', cx + 5, cy - radius + 5);
      ctx.fillText('ay', cx - radius, cy - 9);

      const path = (vehicle: VehicleSeries, last: number) => {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i <= last; i++) {
          const ax = vehicle.ax[i];
          const ay = vehicle.ay[i];
          if (ax == null || ay == null) continue;
          if (pen) ctx.lineTo(px(ay), py(ax));
          else ctx.moveTo(px(ay), py(ax));
          pen = true;
        }
        ctx.stroke();
      };
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.6;
      if (ghostSlot >= 0) {
        ctx.strokeStyle = theme.ghost;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        path(telemetry.ghost, ghostSlot);
      }
      if (egoSlot >= 0) {
        ctx.strokeStyle = theme.ego;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        path(telemetry.ego, egoSlot);
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // Where each vehicle is: the ghost hollow, the ego filled, each with a ring of the surface around it.
      const dot = (vehicle: VehicleSeries, i: number, filled: boolean) => {
        const x = px(vehicle.ay[i] ?? 0);
        const y = py(vehicle.ax[i] ?? 0);
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, 2 * Math.PI);
        ctx.fillStyle = theme.surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, filled ? 4.5 : 3.75, 0, 2 * Math.PI);
        if (filled) {
          ctx.fillStyle = theme.ego;
          ctx.fill();
        } else {
          ctx.strokeStyle = theme.ghost;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      };
      if (ghostSlot >= 0) dot(telemetry.ghost, ghostSlot, false);
      if (egoSlot >= 0) dot(telemetry.ego, egoSlot, true);
    };

    const observer = new ResizeObserver(() => {
      width = element.clientWidth;
      height = element.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
      draw();
    });
    observer.observe(element);
    const offDraw = bus.register(draw);
    const offCursor = bus.cursor.subscribe(draw);
    return () => {
      offDraw();
      offCursor();
      observer.disconnect();
    };
  }, [store, bus, theme, ghost, n]);

  const text = (value: number | null) => (value === null ? t.report.none : n(value, 2));
  const rows = [
    { label: t.view.ego, value: reading.ego, ego: true },
    ...(ghost ? [{ label: t.view.ghost, value: reading.ghost, ego: false }] : []),
  ];

  return (
    <figure className={`${CARD} flex min-w-0 flex-col gap-3 p-4 md:p-5`}>
      <figcaption className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-medium text-clay-950 dark:text-white">{t.charts.gg}</h3>
          <span className={`shrink-0 text-xs tabular-nums ${MUTED}`}>
            {reading.at === null ? 'g' : `${format(t.charts.at, { time: n(reading.at, 2) })} · g`}
          </span>
        </div>
        <p className={`text-xs ${MUTED}`}>{t.charts.ggTotal}</p>
        <dl className="flex min-h-6 flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
          {rows.map(({ label, value, ego }) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className={`flex items-center gap-1.5 text-xs ${MUTED}`}>
                <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5 shrink-0">
                  {ego ? (
                    <circle cx="5" cy="5" r="4.5" fill={theme.ego} />
                  ) : (
                    <circle cx="5" cy="5" r="3.75" fill="none" stroke={theme.ghost} strokeWidth="1.5" />
                  )}
                </svg>
                {label}
              </dt>
              <dd className="font-medium text-clay-950 dark:text-white">{text(value)}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
      <canvas ref={canvas} role="img" aria-label={t.charts.gg} className="block h-37.5 w-full" />
    </figure>
  );
}
