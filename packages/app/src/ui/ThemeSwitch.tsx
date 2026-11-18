/**
 * The theme switch of the navbar (`mative-brand`, `references/navbar.md`): light, the system's or dark, shown side by
 * side so the one in force is always in sight. A group of radio buttons: each one has the name of its choice for a
 * screen reader and for a pointer's tooltip.
 */
import { useI18n } from '../i18n/context.tsx';
import { DeviceIcon, MoonIcon, SunIcon } from './icons.tsx';
import { THEME_CHOICES, type ThemeChoice } from './theme.ts';
import { useTheme } from './ThemeProvider.tsx';

const ICONS: Record<ThemeChoice, () => React.JSX.Element> = { light: SunIcon, system: DeviceIcon, dark: MoonIcon };

export function ThemeSwitch() {
  const { t } = useI18n();
  const { choice, choose } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={t.theme.label}
      className="mx-2 flex items-center gap-0.5 self-center rounded-xl bg-clay-100 p-0.5 md:mx-3 dark:bg-night-800"
    >
      {THEME_CHOICES.map((id) => {
        const Icon = ICONS[id];
        const checked = choice === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={t.theme[id]}
            title={t.theme[id]}
            onClick={() => choose(id)}
            className={`flex size-8 items-center justify-center rounded-[10px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary sm:size-9 ${
              checked
                ? 'bg-white text-clay-950 shadow-sm dark:bg-night-600 dark:text-white'
                : 'text-clay-700 hover:text-clay-950 dark:text-clay-300 dark:hover:text-white'
            }`}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
