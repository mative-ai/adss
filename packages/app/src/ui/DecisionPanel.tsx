/**
 * The decision of the last control cycle (Phase 4): the four maneuvers the MPC compares, which one is in
 * use, whether each avoids the impact, and the common cost they are compared on: the cost of each one's nonlinear
 * rollout, never the solver's own. Then why the decision is what it is, in a sentence. A maneuver the
 * decision layer did not compute (the mobile preset leaves `right` out) says so.
 */
import type { DecisionReport } from '../sim/store.ts';
import { useI18n } from '../i18n/context.tsx';
import { format } from '../i18n/index.ts';
import { CHIP, CHIP_ON, MUTED } from './styles.ts';

/** The maneuvers in the order a frame carries their plans (B0 to B3). */
const MANEUVERS = ['keep', 'brake', 'left', 'right'] as const;

export function DecisionPanel({ decision }: { decision: { report: DecisionReport; stepMs: number } | null }) {
  const { t, n } = useI18n();
  const d = t.decision;
  return (
    <section aria-labelledby="decision-title" className="flex flex-col gap-3">
      <h2 id="decision-title" className="font-heading font-medium text-xl tracking-tight text-clay-950 dark:text-white">
        {d.heading}
      </h2>
      <p className={`text-sm leading-relaxed ${MUTED}`}>{d.intro}</p>
      {decision === null ? (
        <p role="status" className={`text-sm ${MUTED}`}>
          {d.waiting}
        </p>
      ) : (
        <>
          <ul className="grid gap-2">
            {MANEUVERS.map((id) => {
              const candidate = decision.report.candidates.find((c) => c.id === id);
              const chosen = decision.report.chosen === id;
              const verdict = candidate ? (candidate.feasible ? d.feasible : d.infeasible) : d.notSolved;
              return (
                <li
                  key={id}
                  aria-current={chosen ? 'true' : undefined}
                  className={`rounded-2xl border p-3 ${
                    chosen
                      ? 'border-primary bg-white dark:bg-night-800'
                      : 'border-clay-200 bg-clay-50 dark:border-white/10 dark:bg-night-850'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-clay-950 dark:text-white">{d.maneuvers[id]}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {chosen && <span className={CHIP_ON}>{d.chosen}</span>}
                      <span className={CHIP}>{verdict}</span>
                    </span>
                  </div>
                  {candidate && (
                    <dl className={`mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums ${MUTED}`}>
                      <div>
                        <dt>{d.cost}</dt>
                        <dd className="text-sm font-medium text-clay-950 dark:text-white">
                          {n(candidate.cost, candidate.cost >= 100 ? 0 : 2)}
                        </dd>
                      </div>
                      <div>
                        <dt>{d.ttc}</dt>
                        <dd className="text-sm font-medium text-clay-950 dark:text-white">
                          {candidate.minTtc === null ? t.report.none : `${n(candidate.minTtc, 2)} s`}
                        </dd>
                      </div>
                      <div>
                        <dt>{d.impact}</dt>
                        <dd className="text-sm font-medium text-clay-950 dark:text-white">
                          {candidate.impactEnergy > 0 ? `${n(candidate.impactEnergy / 1000, 1)} kJ` : t.report.none}
                        </dd>
                      </div>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-sm leading-relaxed text-clay-700 dark:text-clay-300">
            {d.reasons[decision.report.reason]}
          </p>
          <p className={`text-xs tabular-nums ${MUTED}`}>{format(d.stepTime, { ms: n(decision.stepMs, 1) })}</p>
        </>
      )}
    </section>
  );
}
