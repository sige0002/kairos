// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Left menu rail: the settings sections + a footer stamp of the ACTIVE robot.

import { useQuery } from '@tanstack/react-query';
import { getConfigOptions } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import { Card, cn } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { getCategorySections, SETTINGS_CATEGORIES } from './data';
import type { SettingsState } from './useSettingsState';

export function MenuRail({ settings }: { settings: SettingsState }) {
  const { t } = useTranslation('settings');
  // Real active robot from GET /api/v1/config/options (the same cache the Robots
  // section fills). There is no global "config version" concept in the backend,
  // so the footer shows the one honest, sourced value we do have.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const activeRobot = optionsQuery.data?.active_robot;

  return (
    <Card
      className="flex min-w-0 flex-col gap-3 overflow-auto p-3"
      data-testid="settings-navigation"
    >
      <nav aria-label={t('navigation.categories')} className="flex flex-col gap-3">
        {SETTINGS_CATEGORIES.map((category) => (
          <section
            key={category.id}
            aria-labelledby={`settings-category-${category.id}`}
          >
            <h2
              id={`settings-category-${category.id}`}
              data-testid={`settings-category-${category.id}`}
              className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted"
            >
              {t(`categories.${category.id}`)}
            </h2>
            <div className="flex flex-col gap-[3px]">
              {getCategorySections(category.id).map((section) => (
                <button
                  key={section.id}
                  type="button"
                  data-testid={
                    section.legacyIndex === null
                      ? `settings-menu-item-${section.id}`
                      : `settings-menu-item-${section.legacyIndex}`
                  }
                  data-settings-section={section.id}
                  aria-current={section.id === settings.sectionId ? 'page' : undefined}
                  onClick={() => settings.selectSection(section.id)}
                  className={cn(
                    'rounded-control px-3 py-2 text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    section.id === settings.sectionId
                      ? 'bg-interaction-selected font-semibold text-accent'
                      : 'text-text-secondary hover:bg-interaction-hover',
                  )}
                >
                  <span data-testid={`settings-section-${section.id}`}>
                    {t(`sections.${section.label}`)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-border px-3 pb-1 pt-2.5">
        <span className="text-[11px] text-text-muted">
          {t('navigation.activeRobot')}
        </span>
        <span
          data-testid="settings-active-robot"
          className="font-mono text-[12.5px] font-semibold text-accent"
        >
          {activeRobot ?? '—'}
        </span>
      </div>
    </Card>
  );
}
