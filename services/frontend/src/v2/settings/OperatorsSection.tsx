// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Operators — the attribution roster (project-lead ruling: NOT
// authentication; no passwords, no permissions). Names added here become the
// header OP picker's choices, and picking one is REQUIRED before recording —
// which is what keeps "yuki" / "Yuki" / "yuki_2" out of the labels and
// "unknown_operator" out of the datasets. An EMPTY roster switches the OP chip
// back to free text and gates nothing (the pre-roster behavior), so clearing
// the list is an honest way to opt out. Edits ride the shared plans catalog
// (PUT /api/v1/plans `operators`), so every terminal offers the same names.

import { Card } from '../../components/ui';
import type { SettingsState } from './useSettingsState';

export function OperatorsSection({ settings }: { settings: SettingsState }) {
  const { operators, addOperator, renameOperator, removeOperator } = settings;

  return (
    <Card
      className="flex min-w-0 flex-col overflow-auto lg:col-span-2"
      data-testid="settings-operators"
    >
      <div className="flex flex-col gap-1 border-b border-gray-100 px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Operators
        </h2>
        <span className="text-[12px] leading-relaxed text-gray-500">
          Attribution, not access control: these names fill the OP picker (top
          right), and picking one is required before recording once the roster
          is non-empty. Shared with every terminal. An empty roster turns the
          picker back into free text and gates nothing.
        </span>
      </div>
      <div className="flex max-w-xl flex-col gap-1.5 p-3">
        {operators.length === 0 && (
          <p className="px-1 py-2 text-[12.5px] text-gray-500">
            No roster yet — recording works with a free-text name. Add the
            team&apos;s names to require a pick before every recording.
          </p>
        )}
        {operators.map((name, i) => (
          <div
            key={`${name}-${i}`}
            data-testid={`operator-${i}`}
            className="flex items-center gap-2 rounded-[11px] border border-gray-100 px-[13px] py-[9px]"
          >
            <button
              type="button"
              onClick={() => renameOperator(i)}
              title="Rename"
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-gray-800"
            >
              {name}
            </button>
            <button
              type="button"
              onClick={() => removeOperator(i)}
              title="Remove operator"
              className="shrink-0 px-0.5 text-xs text-gray-500 hover:text-gray-500"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addOperator}
          data-testid="operator-add"
          className="rounded-control border border-dashed border-gray-300 bg-white p-2.5 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
        >
          + Add operator
        </button>
      </div>
    </Card>
  );
}
