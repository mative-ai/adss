/**
 * The values of the run in text (Phase 4): the color is never the only signal, so the numbers are always
 * there. They are the time, speed, steering, the two accelerations and the position, and the ghost's speed when it
 * runs, and they follow the run at the panels' rate, not at the frames'.
 */
import { useI18n } from '../i18n/context.tsx';
import type { Readout } from '../sim/frame.ts';
import { MUTED } from './styles.ts';

function Value({ label, value, unit, big }: { label: string; value: string; unit: string; big?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={`text-xs ${MUTED}`}>{label}</dt>
      <dd className="flex items-baseline gap-1">
        <span
          className={`font-heading font-medium tabular-nums tracking-tight text-clay-950 dark:text-white ${big ? 'text-4xl md:text-5xl' : 'text-2xl'}`}
        >
          {value}
        </span>{' '}
        <span className={`text-sm ${MUTED}`}>{unit}</span>
      </dd>
    </div>
  );
}

export function Readouts({ readout }: { readout: Readout | null }) {
  const { t, n } = useI18n();
  const r = readout;
  const text = (value: number | undefined, digits: number) => (value === undefined ? t.report.none : n(value, digits));
  return (
    <section aria-labelledby="readouts-title">
      <h2 id="readouts-title" className="sr-only">
        {t.readouts.heading}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Value big label={t.readouts.speed} value={text(r?.speedKmh, 1)} unit="km/h" />
        <Value label={t.readouts.time} value={text(r?.time, 2)} unit="s" />
        <Value label={t.readouts.distance} value={text(r?.s, 1)} unit="m" />
        <Value label={t.readouts.steering} value={text(r?.steerDeg, 1)} unit="°" />
        <Value label={t.readouts.ax} value={text(r?.axG, 2)} unit="g" />
        <Value label={t.readouts.ay} value={text(r?.ayG, 2)} unit="g" />
        {r?.ghostSpeedKmh != null && <Value label={t.readouts.ghostSpeed} value={n(r.ghostSpeedKmh, 1)} unit="km/h" />}
      </dl>
    </section>
  );
}
