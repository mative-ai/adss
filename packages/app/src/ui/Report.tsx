/**
 * The report at the end of a run (Phase 4: the success state): the MPC's metrics and the ghost's side
 * by side, labeled "Simulazione" as everything the simulator shows is (CLAUDE.md §7). Every figure comes from the run's
 * metrics, measured on the simulated world; the units are the ones people read (km/h, degrees, g), converted here from
 * the SI units of the core. A figure the run does not have (the TTC of a run that never closed in) is a dash.
 */
import type { SessionMetrics } from '@mpc-simulator/worker';

import { LANDING_URL } from '../access.ts';
import { useI18n } from '../i18n/context.tsx';
import { format } from '../i18n/index.ts';
import { ExternalIcon } from './icons.tsx';
import { CARD, CARD_TITLE, CHIP, MUTED, PRIMARY } from './styles.ts';

const G = 9.81;

type Vehicle = SessionMetrics['ego'];

export function Report({ metrics }: { metrics: SessionMetrics }) {
  const { t, n } = useI18n();
  const r = t.report;
  const cell = (value: number | null, digits: number, unit: string) =>
    value === null ? r.none : `${n(value, digits)} ${unit}`;
  const rows: { label: string; value: (m: Vehicle['metrics']) => string }[] = [
    {
      label: r.rows.impactSpeed,
      value: (m) => cell(m.egoImpactSpeed === null ? null : m.egoImpactSpeed * 3.6, 1, 'km/h'),
    },
    { label: r.rows.minTtc, value: (m) => cell(m.minTtc, 2, 's') },
    { label: r.rows.stoppingDistance, value: (m) => cell(m.stoppingDistance, 1, 'm') },
    { label: r.rows.lateralDeviation, value: (m) => cell(m.maxLateralDeviation, 2, 'm') },
    { label: r.rows.lateralAccel, value: (m) => cell(m.peakLateralAccel / G, 2, 'g') },
    { label: r.rows.sideslip, value: (m) => cell((m.maxSideslip * 180) / Math.PI, 1, '°') },
    { label: r.rows.finalSpeed, value: (m) => cell(m.finalSpeed * 3.6, 1, 'km/h') },
    { label: r.rows.distance, value: (m) => cell(m.distance, 1, 'm') },
    { label: r.rows.duration, value: (m) => cell(m.duration, 2, 's') },
  ];
  const columns: { name: string; vehicle: Vehicle }[] = [{ name: r.columns.ego, vehicle: metrics.ego }];
  if (metrics.ghost) columns.push({ name: r.columns.ghost, vehicle: metrics.ghost });
  const outcome = (v: Vehicle) =>
    v.metrics.collided
      ? format(r.hit, {
          obstacle: t.events.obstacles[v.metrics.collisionObstacle ?? ''] ?? v.metrics.collisionObstacle ?? '',
        })
      : r.clear;

  return (
    <section aria-labelledby="report-title" className={`${CARD} flex flex-col gap-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="report-title" className={CARD_TITLE}>
          {r.heading}
        </h2>
        <span className={`${CHIP} font-medium`}>{t.simulation}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-sm tabular-nums">
          <thead>
            <tr>
              <td className="w-1/2" />
              {columns.map((c) => (
                <th key={c.name} scope="col" className="pb-2 font-medium text-clay-950 dark:text-white">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-clay-200 dark:border-white/10">
              <th scope="row" className={`py-2 pr-4 font-normal ${MUTED}`} />
              {columns.map((c) => (
                <td key={c.name} className="py-2 font-medium text-clay-950 dark:text-white">
                  {outcome(c.vehicle)}
                </td>
              ))}
            </tr>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-clay-200 dark:border-white/10">
                <th scope="row" className={`py-2 pr-4 font-normal ${MUTED}`}>
                  {row.label}
                </th>
                {columns.map((c) => (
                  <td key={c.name} className="py-2 text-clay-950 dark:text-white">
                    {row.value(c.vehicle.metrics)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <a href={LANDING_URL} className={PRIMARY}>
          {t.contact}
          <ExternalIcon />
        </a>
      </div>
    </section>
  );
}
