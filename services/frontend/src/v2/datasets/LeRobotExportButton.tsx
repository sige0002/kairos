// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The "Convert to LeRobot" control in the scope header, next to Archive.
//
// Its own component, and not an inline block in ScopeHeaderBar, because the
// gate is the interesting part: an installation without the exporter overlay
// renders NOTHING here. That is the §6.2 honesty rule — a control that could
// only ever fail is not offered — and it is worth being able to test on its
// own, without the rest of the screen around it.
//
// While a conversion is live the button becomes the way back into the run, the
// way the archive button does: closing the dialog must not be the same as
// losing sight of what is still running.

import type { LeRobotExportState } from './useLeRobotExport';

export function LeRobotExportButton({ state }: { state: LeRobotExportState }) {
  if (!state.canConvert) return null;
  return (
    <button
      type="button"
      data-testid="convert-lerobot-btn"
      onClick={state.openDialog}
      aria-haspopup="dialog"
      title={
        state.live
          ? 'A conversion is running for this dataset — open it for progress, or to cancel it.'
          : 'Convert this dataset to a LeRobot v3 dataset under exports/. The recordings and the dataset itself are not changed.'
      }
      className="inline-flex shrink-0 items-center gap-1 rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
    >
      {state.live ? 'Converting…' : 'Convert to LeRobot'}
    </button>
  );
}
