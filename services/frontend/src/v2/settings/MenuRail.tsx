// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Left menu rail: the settings sections + a footer stamp of the ACTIVE robot.

import { useQuery } from '@tanstack/react-query';
import { getConfigOptions } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import { Card, cn } from '../../components/ui';
import { SETTINGS_MENU } from './data';
import type { SettingsState } from './useSettingsState';

export function MenuRail({ settings }: { settings: SettingsState }) {
  // Real active robot from GET /api/v1/config/options (the same cache the Robots
  // section fills). There is no global "config version" concept in the backend,
  // so the footer shows the one honest, sourced value we do have.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const activeRobot = optionsQuery.data?.active_robot;

  return (
    <Card className="flex flex-col gap-[3px] overflow-auto p-3">
      {SETTINGS_MENU.map((label, i) => (
        <button
          key={label}
          type="button"
          data-testid={`settings-menu-item-${i}`}
          aria-current={i === settings.menuIdx}
          onClick={() => settings.selectMenu(i)}
          className={cn(
            'rounded-control px-3 py-2 text-left text-[13px] font-medium transition-colors',
            i === settings.menuIdx
              ? 'bg-interaction-selected font-semibold text-accent'
              : 'text-text-secondary hover:bg-interaction-hover',
          )}
        >
          {label}
        </button>
      ))}
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-border px-3 pb-1 pt-2.5">
        <span className="text-[11px] text-text-muted">active robot</span>
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
