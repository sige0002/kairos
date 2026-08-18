// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Right column: building the selected dataset by adding captures to it.
//
// This is the whole of "assembling a training set" under §6 — a membership row
// per capture, allocated the next never-before-issued display_index. Nothing is
// copied and nothing is moved, so the panel says so rather than showing a
// progress bar for work that does not happen.
//
// Only finished recordings are listed: a live one has no final bytes to cite,
// and a tombstone has none left.
//
// The rail leads with what can actually join; recordings that cannot (not yet
// adopted in Review, or bytes not on this host) are folded behind a stated
// "Show blocked (n)" toggle — hidden by default because they clutter the
// building flow, but never silently: the count is always on screen, and an
// expanded row still carries its specific reason (data.ts addBlockedReason),
// so the two causes never read as one vague "unavailable".
//
// Archive lives here rather than beside the member detail because here is where
// it can succeed: the backend refuses to archive a capture that still belongs to
// any dataset, exactly as it refuses to delete one.

import { AvailabilityChip } from '../captures/AvailabilityChip';
import { CaptureLabelChips } from '../episodeChips';
import { ArchiveDialog } from './ArchiveDialog';
import { BulkAddDialog } from './BulkAddDialog';
import { CandidateFilterBuilder } from './CandidateFilterBuilder';
import {
  addBlockedReason,
  captureFacts,
  captureWhen,
  memberCount,
  shortCaptureId,
} from './data';
import type { CaptureListItem } from '../../api/types';
import type { DatasetsState } from './useDatasetsState';

function CandidateRow({ capture, state }: { capture: CaptureListItem; state: DatasetsState }) {
  const adding = state.addingCaptureId === capture.capture_id;
  const memberships = capture.memberships ?? [];
  // A frozen dataset (§6.x) cannot take members any more than no dataset can —
  // the server refuses, so the Add control treats it as "no valid target".
  const noTarget =
    state.selectedDatasetId === null || state.isDatasetFrozen(state.selectedDatasetId);
  const blocked = addBlockedReason(capture);
  const facts = captureFacts(capture);
  return (
    <div
      data-testid={`dataset-candidate-${capture.capture_id}`}
      data-capture-id={capture.capture_id}
      className="flex flex-col gap-1.5 rounded-[10px] border border-gray-100 px-[11px] py-[9px]"
    >
      {/* Identity first: when · what · how long. A run_id alone cannot answer
          "which data is this?" (2026-08-03 feedback) — same-day runs differ
          only in their final digits — so the run name is the secondary, on-disk
          line and the human facts lead. */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-gray-800">
          {captureWhen(capture)}
        </span>
        <AvailabilityChip
          capture={capture}
          testId={`dataset-candidate-availability-${capture.capture_id}`}
        />
      </div>
      {facts !== '' && (
        <span
          data-testid={`dataset-candidate-facts-${capture.capture_id}`}
          className="truncate text-[11px] text-gray-500"
        >
          {facts}
        </span>
      )}
      <span
        title={capture.capture_id}
        className="truncate font-mono text-[10.5px] text-gray-500"
      >
        {capture.run_id ?? shortCaptureId(capture.capture_id)}
      </span>
      <CaptureLabelChips capture={capture} />
      {memberships.length > 0 && (
        <span className="text-[10.5px] text-gray-500">
          already in {memberships.map((m) => m.dataset_name ?? m.dataset_id).join(', ')}
        </span>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid={`dataset-add-${capture.capture_id}`}
          onClick={() => state.addMember(capture)}
          disabled={noTarget || blocked !== null || adding || state.bulkAddBusy}
          // The row's own reason outranks "pick a dataset": choosing one would
          // not make this capture addable, and sending the operator to do it
          // would be sending them nowhere.
          data-blocked={blocked !== null ? 'true' : undefined}
          title={
            blocked ??
            (noTarget
              ? 'Select a dataset first'
              : 'Add this recording to the selected dataset. Nothing moves on disk.')
          }
          className="rounded-chip bg-teal-700 px-2.5 py-[3px] text-[11px] font-bold text-white hover:bg-teal-800 disabled:opacity-40"
        >
          {adding ? 'Adding…' : '+ Add'}
        </button>
        {state.canArchive(capture) && (
          <button
            type="button"
            data-testid={`dataset-archive-${capture.capture_id}`}
            onClick={() => state.openArchive(capture)}
            title="Copy this recording to an archive root, verify it, then remove it from this machine"
            className="rounded-chip border border-gray-200 px-2.5 py-[3px] text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
          >
            Archive
          </button>
        )}
      </div>
    </div>
  );
}

export function BuildRail({ state }: { state: DatasetsState }) {
  const target = state.selectedDataset;
  const hidden = state.candidateMatchCount - state.candidates.length;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card">
      <div className="shrink-0 border-b border-gray-100 px-[18px] py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Build dataset
        </h2>
      </div>

      <div className="shrink-0 border-b border-gray-100 px-[18px] py-[13px]">
        {target && state.isDatasetFrozen(target.dataset.dataset_id) ? (
          <p data-testid="build-target-frozen" className="break-words text-[12.5px] leading-relaxed text-gray-500">
            <span className="font-semibold text-gray-800">{target.dataset.name}</span> is{' '}
            {target.dataset.status} — its member set is frozen and takes no more
            recordings. Select an active dataset to keep building.
          </p>
        ) : target ? (
          <p data-testid="build-target" className="break-words text-[12.5px] leading-relaxed text-gray-600">
            Adding to <span className="font-semibold text-gray-900">{target.dataset.name}</span> —{' '}
            {memberCount(target.dataset.member_count)}. Each recording gets the next
            number, and a number retired by a removal is never handed out again.
          </p>
        ) : (
          <p data-testid="build-no-target" className="text-[12.5px] leading-relaxed text-gray-500">
            Select a dataset on the left (or create one) to add recordings to it.
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-b border-gray-100 px-[18px] py-[11px]">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Recordings
        </h3>
        <CandidateFilterBuilder state={state} />
        <button
          type="button"
          data-testid="dataset-bulk-add-open"
          onClick={state.openBulkAdd}
          disabled={
            !target ||
            state.isDatasetFrozen(target.dataset.dataset_id) ||
            state.bulkAddAvailableCount === 0 ||
            state.addingCaptureId !== null ||
            state.bulkAddBusy ||
            (state.candidateConditions.some(
              (condition) =>
                condition.field === 'condition' || condition.field === 'any',
            ) &&
              state.conditionFilterStatus !== 'ready')
          }
          className="w-full cursor-pointer rounded-control bg-teal-700 px-3 py-2 text-[12px] font-bold text-white shadow-btn transition-colors hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.bulkAddAvailableCount === 0
            ? 'No available matches'
            : state.candidateConditions.length > 0
              ? `Add ${state.bulkAddAvailableCount} match${state.bulkAddAvailableCount === 1 ? '' : 'es'}`
              : `Add all ${state.bulkAddAvailableCount} available`}
        </button>
      </div>

      <div data-testid="dataset-candidates" className="min-h-0 flex-1 overflow-y-auto px-[14px] py-2.5">
        {state.candidates.length === 0 ? (
          <p data-testid="dataset-candidates-empty" className="px-1 py-3 text-[12.5px] text-gray-500">
            {state.candidateConditions.some(
              (condition) =>
                condition.field === 'condition' || condition.field === 'any',
            ) && state.conditionFilterStatus === 'loading'
              ? 'Loading batch conditions…'
              : state.candidateConditions.some(
                    (condition) =>
                      condition.field === 'condition' ||
                      condition.field === 'any',
                  ) && state.conditionFilterStatus === 'error'
                ? 'Batch conditions could not be loaded. Reload this screen to retry.'
                : state.candidateConditions.length > 0
                  ? 'No recording matches those filters.'
                  : target
                    ? 'Every finished recording is already in this dataset.'
                    : 'Every finished recording already belongs to a dataset.'}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {state.candidates.map((capture) => (
              <CandidateRow key={capture.capture_id} capture={capture} state={state} />
            ))}
            {hidden > 0 && (
              <span data-testid="dataset-candidates-more" className="px-1 py-1 text-[11px] text-gray-500">
                {hidden} more match — narrow the search to reach them.
              </span>
            )}
          </div>
        )}
        {/* The sweep stopped before the end of the catalog, so "no more
            recordings" here means "no more that were fetched". Said where the
            list ends, because that is where an operator concludes it. */}
        {state.catalogTruncated && (
          <p
            data-testid="catalog-truncated"
            className="mt-1.5 rounded-control border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800"
          >
            This is not the whole catalog — there are more recordings than one
            sweep fetches, so the oldest are not listed here and are not
            included in bulk add.
          </p>
        )}
        {state.blockedCandidateCount > 0 && (
          <button
            type="button"
            data-testid="dataset-candidates-blocked-toggle"
            onClick={state.toggleBlockedCandidates}
            title="Recordings that cannot join a dataset today — not adopted in Review, or their bytes are not on this machine. Each row states its own reason."
            className="mt-1.5 w-full rounded-chip border border-gray-200 px-2 py-1 text-[11px] font-semibold text-gray-500 hover:bg-gray-50"
          >
            {state.showBlockedCandidates
              ? `Hide blocked (${state.blockedCandidateCount})`
              : `Show blocked (${state.blockedCandidateCount})`}
          </button>
        )}
      </div>

      <p
        data-testid="views-note"
        className="shrink-0 border-t border-gray-100 px-[18px] py-[11px] text-[11px] leading-relaxed text-gray-500"
      >
        The browsable views/ tree is regenerated by the server after every change
        here. There is nothing to refresh from this screen.
      </p>

      <ArchiveDialog state={state} />
      <BulkAddDialog state={state} />
    </div>
  );
}
