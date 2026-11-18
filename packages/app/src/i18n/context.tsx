import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { DICTIONARIES, numberFormatter, type Dictionary, type Language, type NumberFormatter } from './index.ts';

export interface I18n {
  language: Language;
  t: Dictionary;
  /** A number with a fixed count of decimals, written as the language does. */
  n: NumberFormatter;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18n>(
    () => ({ language, t: DICTIONARIES[language], n: numberFormatter(language) }),
    [language],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('useI18n outside an I18nProvider');
  return value;
}
