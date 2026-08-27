// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Browser-local UI language only. It deliberately has no dependency on API,
// recording state, or the shared plans store, so switching it is safe mid-task.

import { useTranslation } from 'react-i18next';
import { Card, cn } from '../../components/ui';
import { APP_LOCALES, useLocale, type AppLocale } from '../../i18n';

const LANGUAGE_OPTION_KEY: Record<
  AppLocale,
  'language.options.en' | 'language.options.ja'
> = {
  en: 'language.options.en',
  ja: 'language.options.ja',
};

export function LanguageSection() {
  const { t } = useTranslation('settings');
  const { locale, preferencePersistent, setLocale } = useLocale();
  const languageName = t(LANGUAGE_OPTION_KEY[locale]);

  return (
    <Card
      className="flex min-w-0 flex-col gap-5 p-[18px] lg:col-span-2"
      data-testid="settings-language"
    >
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          {t('language.title')}
        </h2>
        <p className="mt-1 max-w-xl text-[12.5px] text-text-secondary">
          {t('language.description')}
        </p>
      </div>
      <fieldset className="flex max-w-xl flex-col gap-2">
        <legend className="sr-only">{t('language.title')}</legend>
        {APP_LOCALES.map((candidate) => {
          const selected = locale === candidate;
          const name = t(LANGUAGE_OPTION_KEY[candidate]);
          return (
            <label
              key={candidate}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-control border p-3 transition-colors',
                selected
                  ? 'border-accent bg-interaction-selected'
                  : 'border-border bg-surface hover:bg-interaction-hover',
              )}
            >
              <input
                type="radio"
                name="language"
                value={candidate}
                checked={selected}
                onChange={() => setLocale(candidate)}
                className="h-4 w-4 border-border-strong accent-accent focus:ring-2 focus:ring-focus"
                data-testid={`language-${candidate}`}
              />
              <span className="text-sm font-semibold text-text-primary">{name}</span>
            </label>
          );
        })}
      </fieldset>
      <p
        role="status"
        className={cn(
          'max-w-xl text-[12.5px]',
          preferencePersistent ? 'text-text-muted' : 'text-status-warning-text',
        )}
        data-testid="language-status"
      >
        {preferencePersistent
          ? t('language.statusPersistent', { language: languageName })
          : t('language.statusTemporary', { language: languageName })}
      </p>
    </Card>
  );
}
