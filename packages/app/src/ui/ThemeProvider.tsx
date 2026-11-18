/**
 * The theme as React state: what the visitor picked and whether the page is dark now. Everything that draws in the
 * theme's colors (the charts, the top view, the 3D scene) reads `dark` here, never the system's setting on its own,
 * which is only what the choice "system" follows.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { applyTheme, isDark, readChoice, saveChoice, type ThemeChoice } from './theme.ts';
import { DARK_QUERY, useMediaQuery } from './useMedia.ts';

export interface ThemeState {
  /** What the visitor picked: the system's until they pick. */
  choice: ThemeChoice;
  /** Whether the page is dark now, whatever the choice. */
  dark: boolean;
  choose: (choice: ThemeChoice) => void;
}

const Context = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemDark = useMediaQuery(DARK_QUERY);
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice());
  const dark = isDark(choice, systemDark);

  useEffect(() => {
    applyTheme(document.documentElement, dark);
  }, [dark]);

  const choose = useCallback((next: ThemeChoice) => {
    setChoice(next);
    saveChoice(next);
  }, []);

  const value = useMemo<ThemeState>(() => ({ choice, dark, choose }), [choice, dark, choose]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(Context);
  if (!value) throw new Error('useTheme outside a ThemeProvider');
  return value;
}
