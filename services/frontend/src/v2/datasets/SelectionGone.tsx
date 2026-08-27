// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// What the screen says when the dataset it is pointed at stops existing.
//
// This screen is one of several writers. Another operator has the same page
// open, a script curls the API, a rebuild replays the ledger — and the first
// this browser hears of it is a dataset list that no longer contains the
// selection. Two things must then happen, and neither is automatic:
//
//   * the CENTER pane has to say the dataset is gone. Falling back to the
//     ordinary "select a dataset" prompt would be indistinguishable from the
//     operator's own click having been dropped, and they would go looking for a
//     row that is not coming back.
//   * every destructive DIALOG standing open against it has to say the same and
//     stand down. A dialog that vanishes by itself reads exactly like one that
//     was dismissed — and the operator walks away believing they cancelled.
//
// Both are the same sentence, so it lives in one place: two surfaces that
// disagree about what happened are worse than one that says nothing.

import type { DatasetsState } from './useDatasetsState';

/** The sentence itself, for a dialog that has to explain why its action is no
 *  longer on offer. `datasetId` is the only identity left — the name went with
 *  the row — so it is shown rather than a blank where the name used to be. */
export function DatasetGoneNote({
  testId,
  datasetId,
}: {
  testId: string;
  datasetId: string | null;
}) {
  return (
    <p
      data-testid={testId}
      className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12.5px] leading-relaxed text-status-warning-text"
    >
      This dataset is no longer in the catalog — it was removed outside this
      screen (another browser, the API, or a rebuild).{' '}
      {datasetId && (
        <span className="break-all font-mono text-[11.5px]">{datasetId}</span>
      )}{' '}
      Deleting a dataset never removes recordings, so the captures it listed are
      not affected by this.
    </p>
  );
}

/** The center pane for the same state, with the way out: clearing the selection
 *  also clears it from the query string, so a reload does not land back on the
 *  dead deep link. */
export function DatasetGonePane({ state }: { state: DatasetsState }) {
  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-3 rounded-card border border-border bg-surface p-8 shadow-card"
    >
      <div className="max-w-[420px]">
        <DatasetGoneNote testId="dataset-selection-gone" datasetId={state.selectedDatasetId} />
      </div>
      <button
        type="button"
        data-testid="dataset-selection-gone-clear"
        onClick={state.clearDataset}
        className="rounded-chip border border-border px-[11px] py-[5px] text-xs font-semibold text-text-secondary hover:bg-surface-muted"
      >
        Back to the dataset list
      </button>
    </div>
  );
}
