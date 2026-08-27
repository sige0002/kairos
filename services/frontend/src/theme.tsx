// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Browser-local presentation preference. It intentionally has no dependency on
// the API, Zustand stores, or recording state.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'kairos.appearance';

type AppearanceContextValue = {
  appearance: Appearance;
  resolvedTheme: ResolvedTheme;
  preferencePersistent: boolean;
  setAppearance: (appearance: Appearance) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function isAppearance(value: string | null): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark';
}

type StoredAppearance = {
  appearance: Appearance;
  storageAvailable: boolean;
};

function readStoredAppearance(): StoredAppearance {
  try {
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return {
      appearance: isAppearance(stored) ? stored : 'system',
      storageAvailable: true,
    };
  } catch {
    return { appearance: 'system', storageAvailable: false };
  }
}

export function readAppearance(): Appearance {
  return readStoredAppearance().appearance;
}

export function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function resolveTheme(
  appearance: Appearance,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (appearance === 'dark') return 'dark';
  if (appearance === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [initialAppearance] = useState(readStoredAppearance);
  const [appearance, setAppearanceState] = useState<Appearance>(
    initialAppearance.appearance,
  );
  const [preferencePersistent, setPreferencePersistent] = useState(
    initialAppearance.storageAvailable,
  );
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(appearance, prefersDark);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (appearance !== 'system' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [appearance]);

  const setAppearance = (next: Appearance) => {
    if (next === 'system') setPrefersDark(systemPrefersDark());
    setAppearanceState(next);
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
      setPreferencePersistent(true);
    } catch {
      // The preference still applies for this page when storage is unavailable.
      setPreferencePersistent(false);
    }
  };

  const value = useMemo(
    () => ({ appearance, resolvedTheme, preferencePersistent, setAppearance }),
    [appearance, preferencePersistent, resolvedTheme],
  );
  return (
    <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance must be used inside AppearanceProvider');
  return value;
}
