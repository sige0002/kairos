// Left menu rail: the 8 settings sections + the footer config-version stamp.

import { Card, cn } from '../../components/ui';
import { SETTINGS_MENU } from './data';
import type { SettingsState } from './useSettingsState';

export function MenuRail({ settings }: { settings: SettingsState }) {
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
              ? 'bg-teal-50 font-semibold text-teal-700'
              : 'text-gray-600 hover:bg-gray-50',
          )}
        >
          {label}
        </button>
      ))}
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-gray-100 px-3 pb-1 pt-2.5">
        <span className="text-[11px] text-gray-400">config version</span>
        {/*
          RuntimeConfig (src/config.ts) has no global "config version" concept
          yet — GET /api/v1/config exposes per-robot/per-aspect options (see
          src/features/config/ConfigTab.tsx) but no single version/commit
          stamp for the whole settings tree. Kept as the mock's literal value
          until the backend grows one.
        */}
        <span className="font-mono text-[12.5px] font-semibold text-teal-700">
          v2.4.1 · committed
        </span>
      </div>
    </Card>
  );
}
