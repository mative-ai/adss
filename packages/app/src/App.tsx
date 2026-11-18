/**
 * The page (Phase 4): the top row with the theme switch, the one-line statement of what the simulator is (and that it is
 * educational, not for homologation, on every screen), and then the simulator.
 */
import { useEffect, useMemo } from 'react';

import { I18nProvider, useI18n } from './i18n/context.tsx';
import { DICTIONARIES } from './i18n/index.ts';
import { readLanguage } from './language.ts';
import { useSimulationStore } from './sim/useSimulation.ts';
import { Boundary } from './ui/Boundary.tsx';
import { Header } from './ui/Header.tsx';
import { Simulator } from './ui/Simulator.tsx';
import { ErrorState, LoadingState } from './ui/States.tsx';
import { ThemeProvider } from './ui/ThemeProvider.tsx';

/** The simulator, with its worker for as long as it is on screen; a render that throws shows the error state. */
function Simulation() {
  const store = useSimulationStore();
  return (
    <Boundary fallback={(error) => <ErrorState crashed message={error.message} onReset={() => undefined} />}>
      {store ? <Simulator store={store} /> : <LoadingState />}
    </Boundary>
  );
}

function Page() {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh bg-white text-clay-700 dark:bg-black dark:text-clay-300">
      <a
        href="#content"
        className="sr-only z-50 rounded-full bg-primary px-5 py-2.5 font-medium text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        {t.skipToContent}
      </a>
      <Header />
      <main id="content" className="mx-auto w-full max-w-[1360px] px-4 pb-20 pt-6 md:px-8 md:pt-8">
        <div className="mb-6 md:mb-8">
          <p className="mb-4 flex items-center gap-3 text-sm font-medium text-clay-700 dark:text-clay-300">
            <span
              aria-hidden="true"
              className="block size-2.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/15"
            />
            <span className="rounded-full border border-clay-300/80 bg-white/70 px-3 py-1 backdrop-blur dark:border-white/10 dark:bg-night-900/60">
              {t.disclaimer}
            </span>
          </p>
          <h1 className="max-w-[18ch] text-balance font-heading font-medium text-3xl leading-[1.04] tracking-tight text-clay-950 md:text-5xl dark:text-white">
            {t.appName}
          </h1>
          <p className="mt-3 max-w-[60ch] text-pretty text-base leading-relaxed md:text-lg">{t.intro}</p>
        </div>
        <Simulation />
      </main>
    </div>
  );
}

export function App() {
  const language = useMemo(() => readLanguage(), []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = DICTIONARIES[language].appName;
  }, [language]);
  return (
    <ThemeProvider>
      <I18nProvider language={language}>
        <Page />
      </I18nProvider>
    </ThemeProvider>
  );
}
