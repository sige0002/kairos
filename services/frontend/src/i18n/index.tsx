// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The UI locale is an explicit browser-local preference. It deliberately does
// not use navigator.language: localeGuard only protects third-party Intl users.

import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en } from './locales/en';
import { ja } from './locales/ja';

export const APP_LOCALES = ['en', 'ja'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const LOCALE_STORAGE_KEY = 'kairos.locale';

const resources = { en, ja } as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof en;
  }
}

function isAppLocale(value: string | null | undefined): value is AppLocale {
  return value === 'en' || value === 'ja';
}

type StoredLocale = { locale: AppLocale; storageAvailable: boolean };

export function readStoredLocale(): StoredLocale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return { locale: isAppLocale(stored) ? stored : 'en', storageAvailable: true };
  } catch {
    return { locale: 'en', storageAvailable: false };
  }
}

export function localeForIntl(locale: AppLocale): string {
  // English uses the console's established 24-hour UK-style presentation;
  // Japanese uses its native regional formatting. This mapping is the sole
  // Intl boundary, not a second independently selectable preference.
  return locale === 'ja' ? 'ja-JP' : 'en-GB';
}

function applyDocumentLanguage(locale: AppLocale): void {
  document.documentElement.lang = locale;
}

const initialLocale = readStoredLocale();
applyDocumentLanguage(initialLocale.locale);

i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale.locale,
  fallbackLng: 'en',
  ns: Object.keys(en),
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
});

type LocaleContextValue = {
  locale: AppLocale;
  intlLocale: string;
  preferencePersistent: boolean;
  setLocale: (locale: AppLocale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => readStoredLocale());
  const [locale, setLocaleState] = useState<AppLocale>(initial.locale);
  const [preferencePersistent, setPreferencePersistent] = useState(
    initial.storageAvailable,
  );

  useEffect(() => {
    if (currentLocale() !== locale) void i18n.changeLanguage(locale);
    applyDocumentLanguage(locale);
  }, [locale]);

  const setLocale = (next: AppLocale) => {
    // Update i18next before publishing the new context value so the render
    // caused by setLocale never briefly pairs Japanese formatting with English
    // copy (or vice versa).
    void i18n.changeLanguage(next);
    applyDocumentLanguage(next);
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      setPreferencePersistent(true);
    } catch {
      // The new language still applies for this document and does not disturb
      // active operator state; only reload persistence is unavailable.
      setPreferencePersistent(false);
    }
  };

  const value = useMemo(
    () => ({
      locale,
      intlLocale: localeForIntl(locale),
      preferencePersistent,
      setLocale,
    }),
    [locale, preferencePersistent],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside I18nProvider');
  return value;
}

export function currentLocale(): AppLocale {
  return isAppLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en';
}

export { i18n, resources };
