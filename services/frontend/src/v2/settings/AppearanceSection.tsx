// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { Card, cn } from '../../components/ui';
import { useAppearance, type Appearance } from '../../theme';
import { useTranslation } from 'react-i18next';

const OPTIONS: Appearance[] = ['system', 'light', 'dark'];

export function AppearanceSection() {
  const { t } = useTranslation('settings');
  const { appearance, resolvedTheme, preferencePersistent, setAppearance } =
    useAppearance();
  return (
    <Card
      className="flex min-w-0 flex-col gap-5 p-[18px] lg:col-span-2"
      data-testid="settings-appearance"
    >
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          {t('appearance.title')}
        </h2>
        <p className="mt-1 text-[12.5px] text-text-secondary">
          {t('appearance.description')}
        </p>
      </div>
      <fieldset className="flex max-w-xl flex-col gap-2">
        <legend className="sr-only">{t('appearance.title')}</legend>
        {OPTIONS.map((value) => {
          const selected = appearance === value;
          return (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-control border p-3 transition-colors',
                selected
                  ? 'border-accent bg-interaction-selected'
                  : 'border-border bg-surface hover:bg-interaction-hover',
              )}
            >
              <input
                type="radio"
                name="appearance"
                value={value}
                checked={selected}
                onChange={() => setAppearance(value)}
                className="mt-0.5 h-4 w-4 border-border-strong accent-accent focus:ring-2 focus:ring-focus"
                data-testid={`appearance-${value}`}
              />
              <span>
                <span className="block text-sm font-semibold text-text-primary">
                  {t(`appearance.options.${value}`)}
                </span>
                <span className="block text-[12.5px] text-text-secondary">
                  {t(`appearance.optionDescriptions.${value}`)}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p
        role="status"
        className={cn(
          'text-[12.5px]',
          preferencePersistent ? 'text-text-muted' : 'text-status-warning-text',
        )}
        data-testid="appearance-status"
      >
        {!preferencePersistent
          ? t('appearance.statusTemporary', {
              theme: t(`appearance.options.${resolvedTheme}`),
            })
          : appearance === 'system'
            ? t('appearance.statusSystem', {
                theme: t(`appearance.options.${resolvedTheme}`),
              })
            : t('appearance.statusSelected', { theme: resolvedTheme })}
      </p>
    </Card>
  );
}
