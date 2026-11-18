/**
 * The choice of the scenario (Phase 4): the four v1 scenarios as cards, one chosen at all times (the
 * first when the screen opens). Native radio buttons, so the arrow keys move the choice as they do in any group; the
 * chosen card also shows a check mark, never the border's color alone.
 */
import { useI18n } from '../i18n/context.tsx';
import { SCENARIOS, type ScenarioId } from '../sim/scenarios.ts';
import { CheckIcon } from './icons.tsx';
import { CARD_TITLE, MUTED } from './styles.ts';

export function ScenarioPicker({
  selected,
  disabled,
  onPick,
}: {
  selected: string | null;
  disabled: boolean;
  onPick: (id: ScenarioId) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="grid gap-3" disabled={disabled}>
      <legend className="mb-3 flex items-center gap-3 text-sm font-medium text-clay-700 dark:text-clay-300">
        <span aria-hidden="true" className="block size-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/15" />
        <span className="rounded-full border border-clay-300/80 bg-white/70 px-3 py-1 dark:border-white/10 dark:bg-night-900/60">
          {t.scenario.heading}
        </span>
      </legend>
      {SCENARIOS.map(({ id }) => {
        const on = selected === id;
        return (
          <label key={id} className="block cursor-pointer has-[:disabled]:cursor-default">
            <input
              type="radio"
              name="scenario"
              value={id}
              checked={on}
              onChange={() => onPick(id)}
              className="peer sr-only"
            />
            <span
              className={`flex flex-col gap-1 rounded-3xl border p-5 transition duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary ${
                on
                  ? 'border-primary bg-white dark:bg-night-800'
                  : 'border-clay-200 bg-clay-50 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-white dark:border-white/10 dark:bg-night-850 dark:hover:bg-night-800'
              }`}
            >
              <span className="flex items-start justify-between gap-3">
                <span className={CARD_TITLE}>{t.scenario.names[id]}</span>
                {on && (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-ink">
                    <CheckIcon />
                  </span>
                )}
              </span>
              <span className={`text-sm leading-relaxed ${MUTED}`}>{t.scenario.summaries[id]}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
