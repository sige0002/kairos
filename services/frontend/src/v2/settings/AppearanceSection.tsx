// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { Card, cn } from '../../components/ui';
import { useAppearance, type Appearance } from '../../theme';

const OPTIONS: Array<{ value: Appearance; label: string; description: string }> = [
  {
    value: 'system',
    label: 'System',
    description: 'Match this device’s light or dark appearance.',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Always use the light appearance.',
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Always use the dark appearance.',
  },
];

export function AppearanceSection() {
  const { appearance, resolvedTheme, preferencePersistent, setAppearance } =
    useAppearance();
  return (
    <Card
      className="flex min-w-0 flex-col gap-5 p-[18px] lg:col-span-2"
      data-testid="settings-appearance"
    >
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          Appearance
        </h2>
        <p className="mt-1 text-[12.5px] text-text-secondary">
          Applies immediately on this browser. It does not affect recording or shared
          system settings.
        </p>
      </div>
      <fieldset className="flex max-w-xl flex-col gap-2">
        <legend className="sr-only">Appearance</legend>
        {OPTIONS.map((option) => {
          const selected = appearance === option.value;
          return (
            <label
              key={option.value}
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
                value={option.value}
                checked={selected}
                onChange={() => setAppearance(option.value)}
                className="mt-0.5 h-4 w-4 border-border-strong accent-accent focus:ring-2 focus:ring-focus"
                data-testid={`appearance-${option.value}`}
              />
              <span>
                <span className="block text-sm font-semibold text-text-primary">
                  {option.label}
                </span>
                <span className="block text-[12.5px] text-text-secondary">
                  {option.description}
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
          ? `Using ${resolvedTheme} for this page. Browser storage is unavailable, so choose it again after reload.`
          : appearance === 'system'
            ? `Following this device: ${resolvedTheme}.`
            : `Using ${resolvedTheme} appearance.`}
      </p>
    </Card>
  );
}
