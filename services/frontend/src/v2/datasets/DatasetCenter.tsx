// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Center column. Two vertically stacked panes:
//   TOP  — the scope's members, ~10 rows tall with internal scroll, fronted by a
//          pinned Summary row and its own member search. It BUILDS at most one
//          page at a time; the boundary is stated, not silent, and the pager
//          walks the rest.
//   BOTTOM — the selected member's capture detail (DatasetDetail), OR — whenever
//          no member is selected — the scope SUMMARY (ScopeSummary).
//
// Scope = the selected dataset; with none selected it is every member of every
// dataset in the list, so the pane is still useful before anything is picked.
//
// Every member carries an AvailabilityChip. A dataset may legitimately cite a
// capture whose bytes are not on this host — on a split deploy the review comes
// before the pull (§12) — so that state is RENDERED, never treated as a broken
// row and never hidden.

import { Badge, Button, Modal, TrashIcon, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { CaptureLabelChips } from '../episodeChips';
import { DatasetArchiveDialog } from './DatasetArchiveDialog';
import { DatasetDetail } from './DatasetDetail';
import { EditDatasetDialog } from './EditDatasetDialog';
import { LeRobotExportButton } from './LeRobotExportButton';
import { LeRobotExportDialog } from './LeRobotExportDialog';
import { ScopeSummary } from './ScopeSummary';
import { DatasetGoneNote, DatasetGonePane } from './SelectionGone';
import {
  captureFacts,
  captureWhen,
  formatCount,
  formatWhen,
  memberCount,
  memberTestId,
  shortCaptureId,
  type MemberRow,
} from './data';
import type { DatasetsState } from './useDatasetsState';

// # · Capture (when · facts / run name) · Availability · Labels(flex) · Msgs.
const GRID_COLS = 'grid-cols-[52px_200px_104px_minmax(0,1fr)_76px]';
// Roughly ten rows tall, then the top pane scrolls internally.
const TABLE_SCROLL = 'max-h-[370px]';

/** A small donut glyph for the Summary row (decorative — the real chart is in
 *  the summary pane). */
function SummaryGlyph({ active }: { active: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle
        cx={8}
        cy={8}
        r={6}
        fill="none"
        strokeWidth={3}
        className={active ? 'stroke-teal-200' : 'stroke-gray-200'}
      />
      <circle
        cx={8}
        cy={8}
        r={6}
        fill="none"
        strokeWidth={3}
        pathLength={100}
        strokeDasharray="62 100"
        transform="rotate(-90 8 8)"
        className={active ? 'stroke-teal-600' : 'stroke-gray-500'}
      />
    </svg>
  );
}

function ScopeHeaderBar({ state }: { state: DatasetsState }) {
  const { scope, scopeMembers, memberRows } = state;
  const status = state.selectedDataset?.dataset.status ?? 'active';
  // The header leads with what is actually on screen and keeps the scope total
  // as the denominator, so it can never claim more than it shows.
  const total = scopeMembers.length;
  const rendered = memberRows.length;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-[18px] py-[11px]">
      <h2 data-testid="dataset-scope-title" className="text-[15px] font-bold text-gray-900">
        {scope.label}
      </h2>
      {scope.operator && <Badge tone="gray">{scope.operator}</Badge>}
      {scope.task && <Badge tone="teal">{scope.task}</Badge>}
      {scope.kind === 'dataset' && status !== 'active' && (
        <span data-testid="dataset-scope-status">
          <Badge tone={status === 'archived' ? 'gray' : 'amber'}>{status}</Badge>
        </span>
      )}
      <span data-testid="dataset-scope-count" className="text-[11.5px] text-gray-500">
        {rendered === total
          ? memberCount(total)
          : `showing ${formatCount(rendered)} of ${memberCount(total)}`}
      </span>
      <div className="flex-1" />
      <input
        type="search"
        data-testid="dataset-member-search"
        value={state.memberSearch}
        onChange={(e) => state.setMemberSearch(e.target.value)}
        aria-label="Search members of this dataset"
        placeholder="Find #N, capture, run, operator…"
        className="w-[190px] rounded-control border border-gray-200 bg-white px-2.5 py-1 text-[12px] text-gray-700 placeholder:text-gray-500"
      />
      {scope.kind === 'dataset' && state.canEditDataset && (
        <button
          type="button"
          data-testid="edit-dataset-btn"
          onClick={state.openEdit}
          title="Edit the name / operator / task labels. Members and their numbers do not change."
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
        >
          Edit
        </button>
      )}
      {scope.kind === 'dataset' && (state.canArchiveDataset || status === 'archiving') && (
        <button
          type="button"
          data-testid="archive-dataset-btn"
          onClick={state.openDatasetArchive}
          title={
            status === 'archiving'
              ? 'This dataset is being archived — open the run for progress or to resume it.'
              : 'Copy this whole dataset to an archive root, verify it, then remove its recordings from this machine. Terminal.'
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-teal-200 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
        >
          {status === 'archiving' ? 'Archive run…' : 'Archive dataset'}
        </button>
      )}
      {/* Renders nothing at all unless this installation has an exporter with
          a profile library (§6.2) — the archive gate's rule, one control over.
          Not gated on status: an archived-copy dataset is still convertible,
          and an archived-move one preflights to zero and says so. */}
      {scope.kind === 'dataset' && <LeRobotExportButton state={state.lerobotExport} />}
      {/* This status gate is on the BUTTON only, and the dialog it opens
          deliberately has none: a hint on a control nobody has committed to is
          cheap, but a second copy of the server's rule guarding the commitment
          is one more thing that can drift out of step with it. A dataset
          archived from another terminal mid-dialog is refused by the server's
          409, which names the destination and why the record is kept. */}
      {scope.kind === 'dataset' && (
        <button
          type="button"
          data-testid="delete-dataset-btn"
          onClick={state.requestDatasetDelete}
          disabled={status !== 'active'}
          title={
            status === 'archived'
              ? 'Kept: this record is what remembers where the dataset went.'
              : status === 'archiving'
                ? 'Not while the archive run is out copying.'
                : 'Delete this dataset. The recordings it lists are not touched.'
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-default disabled:border-gray-200 disabled:text-gray-400"
        >
          <TrashIcon />
          Delete dataset
        </button>
      )}
    </div>
  );
}

/** The sealed state, said in the header's own voice: where it went and when.
 *  Rendered only for an archived dataset — the run's progress lives in the
 *  archive dialog, not here. */
function ArchivedBanner({ state }: { state: DatasetsState }) {
  const dataset = state.selectedDataset?.dataset;
  if (!dataset || dataset.status !== 'archived') return null;
  const copied = dataset.archive_mode === 'copy';
  return (
    <p
      data-testid="dataset-archived-banner"
      className="border-b border-gray-100 bg-gray-50 px-[18px] py-2 text-[12px] leading-relaxed text-gray-600"
    >
      {copied ? 'Copied to' : 'Archived to'}{' '}
      <span className="break-all font-mono text-gray-800">
        {dataset.archive_destination}
      </span>
      {dataset.archived_at && <> on {formatWhen(dataset.archived_at)}</>} —{' '}
      {copied
        ? 'every recording it lists was verified there and stays on this ' +
          'machine, free to keep working in other datasets. The dataset is ' +
          'read-only; this record is what remembers the export.'
        : 'every recording it lists was verified there and removed from this ' +
          'machine. The dataset is read-only; this record is what remembers ' +
          'where it went.'}
    </p>
  );
}

function SummaryRow({ state }: { state: DatasetsState }) {
  const active = state.isSummaryActive;
  return (
    <button
      type="button"
      data-testid="dataset-summary-row"
      aria-pressed={active}
      onClick={state.selectSummary}
      className={cn(
        'flex w-full items-center gap-2 border-b border-gray-100 px-[18px] py-2 text-left transition-colors',
        active ? 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]' : 'hover:bg-gray-50',
      )}
    >
      <SummaryGlyph active={active} />
      <span
        className={cn('text-[12.5px] font-semibold', active ? 'text-teal-800' : 'text-gray-700')}
      >
        Summary
      </span>
      <span className="truncate text-[11.5px] text-gray-500">
        success / failure · quality · availability for {state.scope.label}
      </span>
    </button>
  );
}

function MemberTableRow({ row, state }: { row: MemberRow; state: DatasetsState }) {
  const selected = state.isMemberSelected(row);
  const capture = row.capture;
  return (
    <div
      data-testid={memberTestId(row.membershipId)}
      data-membership-id={row.membershipId}
      data-capture-id={row.captureId}
      data-display-index={row.displayIndex}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={() => state.selectMember(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.selectMember(row);
        }
      }}
      title={row.captureId}
      className={cn(
        'grid cursor-pointer items-center gap-2 border-t border-gray-50 px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-gray-50',
        GRID_COLS,
        selected && 'border-l-[3px] border-l-teal-600 bg-teal-50 pl-[15px]',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-gray-900">
        #{row.displayIndex}
      </span>
      {/* Identity first (2026-08-03 feedback): when it was taken and what it
          was, with the on-disk run name demoted to the second line. */}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[12px] text-gray-700">
          {capture ? captureWhen(capture) : shortCaptureId(row.captureId)}
          {capture && captureFacts(capture) !== '' && (
            <span className="text-gray-500"> · {captureFacts(capture)}</span>
          )}
        </span>
        <span className="truncate font-mono text-[10.5px] text-gray-500">
          {capture?.run_id ?? shortCaptureId(row.captureId)}
        </span>
      </div>
      {capture ? (
        <AvailabilityChip
          capture={capture}
          testId={`dataset-member-availability-${row.membershipId}`}
        />
      ) : (
        <span
          data-testid={`dataset-member-unresolved-${row.membershipId}`}
          title="This dataset lists a capture the loaded catalog has no row for, so nothing can be said about it here."
          className="text-[11px] italic text-gray-500"
        >
          not in the catalog
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {capture ? (
          <CaptureLabelChips
            capture={capture}
            testId={`dataset-member-labels-${row.membershipId}`}
          />
        ) : (
          <span className="text-[11px] italic text-gray-500">—</span>
        )}
      </div>
      <span className="justify-self-end font-mono text-xs text-gray-500">
        {formatCount(capture?.message_count)}
      </span>
    </div>
  );
}

/** The page boundary, stated: exactly how many rows are built out of how many
 *  matched, and a pager through the rest. Never a silent truncation — a dataset
 *  stays fully reachable however large it grows. */
function MemberPager({ state }: { state: DatasetsState }) {
  const { page, pageCount, pageSize, memberMatchCount, goToPage } = state;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, memberMatchCount);
  return (
    <div
      data-testid="dataset-member-pager"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-gray-100 bg-gray-50 px-[18px] py-2.5"
    >
      <span className="text-[11.5px] text-gray-500" data-testid="dataset-member-range">
        {formatCount(first)}–{formatCount(last)} of {memberCount(memberMatchCount)}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          data-testid="dataset-member-prev"
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="rounded-chip border border-gray-200 px-2 py-0.5 text-[11px] font-bold text-gray-600 hover:bg-white disabled:cursor-default disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="text-[11px] text-gray-500" data-testid="dataset-member-page">
          Page {formatCount(page)} / {formatCount(pageCount)}
        </span>
        <button
          type="button"
          data-testid="dataset-member-next"
          onClick={() => goToPage(page + 1)}
          disabled={page >= pageCount}
          className="rounded-chip border border-teal-200 px-2 py-0.5 text-[11px] font-bold text-teal-700 hover:bg-teal-50 disabled:cursor-default disabled:border-gray-200 disabled:text-gray-400 disabled:opacity-60"
        >
          Next →
        </button>
      </span>
    </div>
  );
}

/** Deleting a dataset removes rows and ledger events only. The dialog says so
 *  in the same breath as the word "delete", because the model it replaced DID
 *  take the recordings with it. */
function DeleteDatasetDialog({ state }: { state: DatasetsState }) {
  const row = state.selectedDataset;
  const gone = state.selectionGone;
  return (
    <Modal
      open={state.confirmingDatasetDelete}
      onClose={state.cancelDatasetDelete}
      title="Delete dataset"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelDatasetDelete}
            disabled={state.deletingDataset}
            data-testid="delete-dataset-cancel"
          >
            {gone ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="danger"
            onClick={state.confirmDatasetDelete}
            disabled={state.deletingDataset || gone}
            data-testid="delete-dataset-confirm"
          >
            {state.deletingDataset ? 'Deleting…' : 'Delete dataset'}
          </Button>
        </>
      }
    >
      <div data-testid="delete-dataset-dialog" className="flex flex-col gap-3">
        {gone ? (
          <DatasetGoneNote
            testId="delete-dataset-gone"
            datasetId={state.selectedDatasetId}
          />
        ) : (
          <>
            {/* The row can go out of view under the open dialog (an external
                status change moves it to the Archived shelf), and a dialog that
                then says "" and "0 memberships" would be inventing both. Name
                what is actually known: the id, and the count only when a row
                is there to report one. */}
            <p className="text-[13px] leading-relaxed text-gray-600">
              {row ? (
                <>
                  <span className="font-semibold text-gray-900">
                    {row.dataset.name}
                  </span>{' '}
                  and its {row.dataset.member_count} membership
                  {row.dataset.member_count === 1 ? ' is' : 's are'} removed.
                </>
              ) : (
                <>
                  <span className="break-all font-mono text-gray-900">
                    {state.selectedDatasetId}
                  </span>{' '}
                  and its memberships are removed.
                </>
              )}
            </p>
            <p
              data-testid="delete-dataset-scope"
              className="rounded-control border border-teal-100 bg-teal-50 px-3 py-2 text-[12.5px] text-teal-900"
            >
              No recording is deleted. A dataset is a list of captures, not a copy
              of them — every capture it named stays exactly where it is.
            </p>
          </>
        )}
        {state.datasetDeleteError != null && (
          <ErrorMessage error={state.datasetDeleteError} />
        )}
      </div>
    </Modal>
  );
}

export function DatasetCenter({ state }: { state: DatasetsState }) {
  // The dialogs are mounted OUTSIDE the pane switch on purpose. They used to
  // live inside the "a dataset is selected" branch, so a dataset deleted by
  // someone else took any open Delete/Archive dialog down with it mid-decision
  // — the operator sees a dialog disappear and reads it as their own cancel.
  // Kept here, they stay up and say what happened (SelectionGone.tsx). Modals
  // are fixed-position and render null when closed, so this costs the grid
  // layout nothing.
  return (
    <>
      {state.selectedDataset ? (
        <SelectedDatasetPane state={state} />
      ) : state.selectionGone ? (
        <DatasetGonePane state={state} />
      ) : (
        <NoSelectionPane />
      )}

      <DeleteDatasetDialog state={state} />
      <DatasetArchiveDialog state={state} />
      <EditDatasetDialog state={state} />
      <LeRobotExportDialog
        state={state.lerobotExport}
        datasetName={
          state.selectedDataset?.dataset.name ?? state.selectedDatasetId ?? 'This dataset'
        }
      />
    </>
  );
}

/** No selection: numbering is per dataset, so a blended every-dataset listing
 *  would show #N columns that identify nothing. */
function NoSelectionPane() {
  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col items-center justify-center rounded-card border border-gray-200 bg-white p-8 shadow-card"
    >
      <p
        data-testid="dataset-none-selected"
        className="max-w-[420px] text-center text-[13px] leading-relaxed text-gray-500"
      >
        Select a dataset on the left — or create one with{' '}
        <span className="font-semibold text-gray-700">+ New</span> — to see its
        members. Exported sets live under the{' '}
        <span className="font-semibold text-gray-700">Archived</span> view.
      </p>
    </div>
  );
}

function SelectedDatasetPane({ state }: { state: DatasetsState }) {
  const { memberRows, scopeMembers, selected } = state;

  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-gray-200 bg-white shadow-card"
    >
      {/* TOP PANE — members, capped ~10 rows then internal scroll. */}
      <div data-testid="dataset-top-pane" className="flex shrink-0 flex-col">
        <ScopeHeaderBar state={state} />
        <ArchivedBanner state={state} />
        <SummaryRow state={state} />
        <div
          className={cn(
            'grid gap-2 border-b border-gray-100 px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500',
            GRID_COLS,
          )}
        >
          <span>#</span>
          <span>Capture</span>
          <span>Availability</span>
          <span>Labels</span>
          <span className="justify-self-end">Msgs</span>
        </div>
        <div data-testid="dataset-member-scroll" className={cn('overflow-y-auto', TABLE_SCROLL)}>
          {memberRows.length === 0 ? (
            <p
              data-testid="dataset-member-empty"
              className="px-[18px] py-4 text-[12.5px] text-gray-500"
            >
              {scopeMembers.length === 0
                ? 'No members yet — add finished recordings from the right-hand rail.'
                : `No member matches “${state.memberSearch}”.`}
            </p>
          ) : (
            <>
              {memberRows.map((row) => (
                <MemberTableRow key={row.membershipId} row={row} state={state} />
              ))}
              {state.pageCount > 1 && <MemberPager state={state} />}
            </>
          )}
        </div>
      </div>

      {/* BOTTOM PANE — selected member's capture, else the scope summary. */}
      <div
        data-testid="dataset-bottom-pane"
        className="min-h-0 flex-1 overflow-y-auto border-t-4 border-gray-100"
      >
        {selected ? (
          // Keyed by CAPTURE, so selecting another member mounts a fresh
          // detail instead of re-rendering this one against a different
          // recording. What it holds below is per-capture — the loss job id, a
          // frozen submission error, and the Retry that resubmits it — and a
          // cached detail meant the pane never remounted on its own, leaving a
          // failed run's note over the wrong member and its Retry aimed at the
          // wrong capture_id.
          //
          // By capture rather than by membership on purpose: two memberships of
          // the SAME recording are the same job and the same report, so
          // remounting between them would discard state that is still correct.
          <DatasetDetail key={selected.captureId} state={state} member={selected} />
        ) : (
          <ScopeSummary scope={state.scope} />
        )}
      </div>
    </div>
  );
}
