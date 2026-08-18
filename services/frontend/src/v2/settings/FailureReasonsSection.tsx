// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Failure reasons — the vocabulary Collect offers when an episode
// is marked Failure ("What failed?" chips). Edits funnel through the SHARED
// plans store (src/v2/plans.ts): Collect updates immediately, and the list is
// persisted server-side with the plan catalog (PUT /api/v1/plans) so every
// terminal offers the same reasons — the labels stamped onto episodes stay
// aggregable across machines. Edits shape FUTURE labels only: episodes already
// labeled keep the exact string that was stored on them.

import { Card } from '../../components/ui';
import type { SettingsState } from './useSettingsState';

export function FailureReasonsSection({ settings }: { settings: SettingsState }) {
  const { failReasons, addFailReason, renameFailReason, removeFailReason } = settings;
  const lastOne = failReasons.length <= 1;

  return (
    <Card
      className="flex min-w-0 flex-col overflow-auto lg:col-span-2"
      data-testid="settings-fail-reasons"
    >
      <div className="flex flex-col gap-1 border-b border-gray-100 px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Failure reasons
        </h2>
        <span className="text-[12px] leading-relaxed text-gray-500">
          The options Collect offers when an episode is marked Failure. Shared
          with every terminal (saved with the plan catalog). Edits apply to
          future labels only — already-labeled episodes keep their stored text.
        </span>
      </div>
      <div className="flex max-w-xl flex-col gap-1.5 p-3">
        {failReasons.map((reason, i) => (
          <div
            key={`${reason}-${i}`}
            data-testid={`fail-reason-${i}`}
            className="flex items-center gap-2 rounded-[11px] border border-gray-100 px-[13px] py-[9px]"
          >
            <button
              type="button"
              onClick={() => renameFailReason(i)}
              title="Rename"
              className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-gray-800"
            >
              {reason}
            </button>
            <button
              type="button"
              onClick={() => removeFailReason(i)}
              disabled={lastOne}
              title={
                lastOne
                  ? 'The last reason cannot be removed — marking a Failure requires one.'
                  : 'Remove reason'
              }
              className="shrink-0 px-0.5 text-xs text-gray-500 enabled:hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addFailReason}
          data-testid="fail-reason-add"
          className="rounded-control border border-dashed border-gray-300 bg-white p-2.5 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
        >
          + Add reason
        </button>
      </div>
    </Card>
  );
}
