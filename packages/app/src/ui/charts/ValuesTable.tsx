/**
 * The charts' values as a table (Phase 4: the values are also in text): one row every half second of
 * the run, with what each chart draws. It is closed until asked for, and filled only while it is open. The whole run,
 * sample by sample, is the CSV export's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from '../../i18n/context.tsx';
import type { SimulationStore } from '../../sim/store.ts';
import { slotAt, type Column } from '../../sim/telemetry.ts';
import { MUTED } from '../styles.ts';
import type { ChartBus } from './bus.ts';

/** Seconds between two rows. */
const STEP = 0.5;

export function ValuesTable({ store, bus, ghost }: { store: SimulationStore; bus: ChartBus; ghost: boolean }) {
  const { t, n } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const [rows, setRows] = useState(0);

  const refresh = useCallback(() => {
    if (!details.current?.open) return;
    const latest = store.telemetry.time.at(-1);
    setRows(latest === undefined ? 0 : Math.floor(latest / STEP + 1e-9) + 1);
  }, [store]);
  useEffect(() => bus.register(refresh), [bus, refresh]);

  const telemetry = store.telemetry;
  const vehicles = [
    { name: t.view.ego, series: telemetry.ego },
    ...(ghost ? [{ name: t.view.ghost, series: telemetry.ghost }] : []),
  ];
  const columns: { label: string; times: number[]; values: Column; digits: number }[] = [
    ...vehicles.map(({ name, series }) => ({
      label: `${t.readouts.speed} ${name}, km/h`,
      times: telemetry.time,
      values: series.speed,
      digits: 1,
    })),
    ...vehicles.map(({ name, series }) => ({
      label: `${t.readouts.steering} ${name}, °`,
      times: telemetry.time,
      values: series.steer,
      digits: 1,
    })),
    ...vehicles.map(({ name, series }) => ({
      label: `ax ${name}, g`,
      times: telemetry.time,
      values: series.ax,
      digits: 2,
    })),
    ...vehicles.map(({ name, series }) => ({
      label: `ay ${name}, g`,
      times: telemetry.time,
      values: series.ay,
      digits: 2,
    })),
    { label: 'TTC, s', times: telemetry.decisionTime, values: telemetry.ttc, digits: 2 },
    { label: `${t.charts.solver}, ms`, times: telemetry.decisionTime, values: telemetry.stepMs, digits: 1 },
  ];
  const cell = 'border-t border-clay-200 px-3 py-1.5 dark:border-white/10';

  return (
    <details
      ref={details}
      onToggle={refresh}
      className="rounded-2xl border border-clay-200 bg-clay-50 px-4 py-3 dark:border-white/10 dark:bg-night-850"
    >
      <summary className="cursor-pointer rounded-lg text-sm font-medium text-clay-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary dark:text-white">
        {t.charts.table}
      </summary>
      <p className={`mt-2 text-xs ${MUTED}`}>{t.charts.tableNote}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-right text-sm tabular-nums">
          <thead>
            <tr className={`text-xs ${MUTED}`}>
              <th scope="col" className="px-3 py-1.5 text-left font-medium">
                {t.readouts.time}, s
              </th>
              {columns.map(({ label }) => (
                <th key={label} scope="col" className="px-3 py-1.5 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-clay-950 dark:text-white">
            {Array.from({ length: rows }, (_, row) => {
              const time = row * STEP;
              return (
                <tr key={row}>
                  <th scope="row" className={`${cell} text-left font-medium`}>
                    {n(time, 1)}
                  </th>
                  {columns.map(({ label, times, values, digits }) => {
                    const slot = slotAt(times, time + 1e-9);
                    const value = slot < 0 ? null : values[slot];
                    return (
                      <td key={label} className={cell}>
                        {value == null ? t.report.none : n(value, digits)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
