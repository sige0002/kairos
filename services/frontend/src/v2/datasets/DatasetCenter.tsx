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
import { useTranslation } from 'react-i18next';
import { ErrorMessage } from '../../components/ErrorMessage';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { CaptureLabelChips } from '../episodeChips';
import { DatasetArchiveDialog } from './DatasetArchiveDialog';
import { CaptureConditionLabel } from './CaptureConditionLabel';
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
        className={active ? 'stroke-accent' : 'stroke-border'}
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
        className={active ? 'stroke-accent' : 'stroke-border'}
      />
    </svg>
  );
}

function ScopeHeaderBar({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const { scope, scopeMembers, memberRows } = state;
  const status = state.selectedDataset?.dataset.status ?? 'active';
  // The header leads with what is actually on screen and keeps the scope total
  // as the denominator, so it can never claim more than it shows.
  const total = scopeMembers.length;
  const rendered = memberRows.length;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-[18px] py-[11px]">
      <h2
        data-testid="dataset-scope-title"
        className="text-[15px] font-bold text-text-primary"
      >
        {scope.label}
      </h2>
      {scope.operator && <Badge tone="gray">{scope.operator}</Badge>}
      {scope.task && <Badge tone="teal">{scope.task}</Badge>}
      {scope.kind === 'dataset' && status !== 'active' && (
        <span data-testid="dataset-scope-status">
          <Badge tone={status === 'archived' ? 'gray' : 'amber'}>{status}</Badge>
        </span>
      )}
      <span data-testid="dataset-scope-count" className="text-[11.5px] text-text-muted">
        {rendered === total
          ? memberCount(total)
          : t('scopeShowing', { shown: String(rendered), total: String(total) })}
      </span>
      <div className="flex-1" />
      <input
        type="search"
        data-testid="dataset-member-search"
        value={state.memberSearch}
        onChange={(e) => state.setMemberSearch(e.target.value)}
        aria-label={t('searchDatasetMembers')}
        placeholder={t('searchDatasetMembersPlaceholder')}
        className="w-[190px] rounded-control border border-border bg-surface px-2.5 py-1 text-[12px] text-text-primary placeholder:text-text-muted"
      />
      {scope.kind === 'dataset' && state.canEditDataset && (
        <button
          type="button"
          data-testid="edit-dataset-btn"
          onClick={state.openEdit}
          title={t('editDatasetHint')}
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-border px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-surface-muted"
        >
          {t('edit')}
        </button>
      )}
      {scope.kind === 'dataset' &&
        (state.canArchiveDataset || status === 'archiving') && (
          <button
            type="button"
            data-testid="archive-dataset-btn"
            onClick={state.openDatasetArchive}
            title={
              status === 'archiving' ? t('archiveRunHint') : t('archiveDatasetHint')
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-control border border-accent px-2.5 py-1 text-xs font-semibold text-accent hover:bg-interaction-selected"
          >
            {status === 'archiving' ? t('archiveRun') : t('archiveDataset')}
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
              ? t('deleteArchivedHint')
              : status === 'archiving'
                ? t('deleteArchivingHint')
                : t('deleteDatasetHint')
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-status-danger-border px-2.5 py-1 text-xs font-semibold text-status-danger-text hover:bg-status-danger-bg disabled:cursor-default disabled:border-border disabled:text-text-muted"
        >
          <TrashIcon />
          {t('deleteDataset')}
        </button>
      )}
    </div>
  );
}

/** The sealed state, said in the header's own voice: where it went and when.
 *  Rendered only for an archived dataset — the run's progress lives in the
 *  archive dialog, not here. */
function ArchivedBanner({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const dataset = state.selectedDataset?.dataset;
  if (!dataset || dataset.status !== 'archived') return null;
  const copied = dataset.archive_mode === 'copy';
  return (
    <p
      data-testid="dataset-archived-banner"
      className="border-b border-border bg-surface-muted px-[18px] py-2 text-[12px] leading-relaxed text-text-secondary"
    >
      {copied ? t('copiedTo') : t('archivedTo')}{' '}
      <span className="break-all font-mono text-text-primary">
        {dataset.archive_destination}
      </span>
      {dataset.archived_at && (
        <> {t('archivedOn', { when: formatWhen(dataset.archived_at) })}</>
      )}{' '}
      — {copied ? t('archivedCopyDetail') : t('archivedMoveDetail')}
    </p>
  );
}

function SummaryRow({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const active = state.isSummaryActive;
  return (
    <button
      type="button"
      data-testid="dataset-summary-row"
      aria-pressed={active}
      onClick={state.selectSummary}
      className={cn(
        'flex w-full items-center gap-2 border-b border-border px-[18px] py-2 text-left transition-colors',
        active
          ? 'border-l-[3px] border-l-accent bg-interaction-selected pl-[15px]'
          : 'hover:bg-surface-muted',
      )}
    >
      <SummaryGlyph active={active} />
      <span
        className={cn(
          'text-[12.5px] font-semibold',
          active ? 'text-accent' : 'text-text-primary',
        )}
      >
        {t('summary')}
      </span>
      <span className="truncate text-[11.5px] text-text-muted">
        {t('summaryLine', { scope: state.scope.label })}
      </span>
    </button>
  );
}

function MemberTableRow({ row, state }: { row: MemberRow; state: DatasetsState }) {
  const { t } = useTranslation('datasets');
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
        'grid cursor-pointer items-center gap-2 border-t border-border px-[18px] py-2 text-sm transition-colors first:border-t-0 hover:bg-surface-muted',
        GRID_COLS,
        selected && 'border-l-[3px] border-l-accent bg-interaction-selected pl-[15px]',
      )}
    >
      <span className="font-mono text-[13px] font-semibold text-text-primary">
        #{row.displayIndex}
      </span>
      {/* Identity first (2026-08-03 feedback): when it was taken and what it
          was, with the on-disk run name demoted to the second line. */}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[12px] text-text-primary">
          {capture ? captureWhen(capture) : shortCaptureId(row.captureId)}
          {capture && captureFacts(capture) !== '' && (
            <span className="text-text-muted"> · {captureFacts(capture)}</span>
          )}
        </span>
        <span className="truncate font-mono text-[10.5px] text-text-muted">
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
          title={t('missingCatalogHint')}
          className="text-[11px] italic text-text-muted"
        >
          {t('missingCatalog')}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {capture ? (
          <CaptureLabelChips
            capture={capture}
            testId={`dataset-member-labels-${row.membershipId}`}
          />
        ) : (
          <span className="text-[11px] italic text-text-muted">—</span>
        )}
        {capture && (
          <CaptureConditionLabel
            capture={capture}
            state={state}
            testId={`dataset-member-condition-${row.membershipId}`}
          />
        )}
      </div>
      <span className="justify-self-end font-mono text-xs text-text-muted">
        {formatCount(capture?.message_count)}
      </span>
    </div>
  );
}

/** The page boundary, stated: exactly how many rows are built out of how many
 *  matched, and a pager through the rest. Never a silent truncation — a dataset
 *  stays fully reachable however large it grows. */
function MemberPager({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const { page, pageCount, pageSize, memberMatchCount, goToPage } = state;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, memberMatchCount);
  return (
    <div
      data-testid="dataset-member-pager"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border bg-surface-muted px-[18px] py-2.5"
    >
      <span
        className="text-[11.5px] text-text-muted"
        data-testid="dataset-member-range"
      >
        {t('memberRange', {
          start: formatCount(first),
          end: formatCount(last),
          total: String(memberCount(memberMatchCount)),
        })}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          data-testid="dataset-member-prev"
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="rounded-chip border border-border px-2 py-0.5 text-[11px] font-bold text-text-secondary hover:bg-surface disabled:cursor-default disabled:opacity-40"
        >
          {t('pagerPrevious')}
        </button>
        <span className="text-[11px] text-text-muted" data-testid="dataset-member-page">
          {t('pagerPage', { page: String(page), total: String(pageCount) })}
        </span>
        <button
          type="button"
          data-testid="dataset-member-next"
          onClick={() => goToPage(page + 1)}
          disabled={page >= pageCount}
          className="rounded-chip border border-accent px-2 py-0.5 text-[11px] font-bold text-accent hover:bg-interaction-selected disabled:cursor-default disabled:border-border disabled:text-text-muted disabled:opacity-60"
        >
          {t('pagerNext')}
        </button>
      </span>
    </div>
  );
}

/** Deleting a dataset removes rows and ledger events only. The dialog says so
 *  in the same breath as the word "delete", because the model it replaced DID
 *  take the recordings with it. */
function DeleteDatasetDialog({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const row = state.selectedDataset;
  const gone = state.selectionGone;
  return (
    <Modal
      open={state.confirmingDatasetDelete}
      onClose={state.cancelDatasetDelete}
      title={t('deleteDataset')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelDatasetDelete}
            disabled={state.deletingDataset}
            data-testid="delete-dataset-cancel"
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={state.confirmDatasetDelete}
            disabled={state.deletingDataset || gone}
            data-testid="delete-dataset-confirm"
          >
            {state.deletingDataset ? t('deletingDataset') : t('deleteDataset')}
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
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {row ? (
                <>
                  <span className="font-semibold text-text-primary">
                    {row.dataset.name}
                  </span>{' '}
                  {t('deleteMembers', {
                    name: row.dataset.name,
                    count: String(row.dataset.member_count),
                  })}
                </>
              ) : (
                <>
                  <span className="break-all font-mono text-text-primary">
                    {state.selectedDatasetId}
                  </span>{' '}
                  {t('deleteUnknownDataset', { id: state.selectedDatasetId ?? '' })}
                </>
              )}
            </p>
            <p
              data-testid="delete-dataset-scope"
              className="rounded-control border border-accent bg-interaction-selected px-3 py-2 text-[12.5px] text-accent-strong"
            >
              {t('deleteDatasetScope')}
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
  const { t } = useTranslation('datasets');
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
          state.selectedDataset?.dataset.name ??
          state.selectedDatasetId ??
          t('thisDataset')
        }
      />
    </>
  );
}

/** No selection: numbering is per dataset, so a blended every-dataset listing
 *  would show #N columns that identify nothing. */
function NoSelectionPane() {
  const { t } = useTranslation('datasets');
  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col items-center justify-center rounded-card border border-border bg-surface p-8 shadow-card"
    >
      <p
        data-testid="dataset-none-selected"
        className="max-w-[420px] text-center text-[13px] leading-relaxed text-text-muted"
      >
        {t('noDatasetSelected')}
      </p>
    </div>
  );
}

function SelectedDatasetPane({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const { memberRows, scopeMembers, selected } = state;

  return (
    <div
      data-testid="dataset-center"
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      {/* TOP PANE — members, capped ~10 rows then internal scroll. */}
      <div data-testid="dataset-top-pane" className="flex shrink-0 flex-col">
        <ScopeHeaderBar state={state} />
        <ArchivedBanner state={state} />
        <SummaryRow state={state} />
        <div
          className={cn(
            'grid gap-2 border-b border-border px-[18px] py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted',
            GRID_COLS,
          )}
        >
          <span>#</span>
          <span>{t('tableCapture')}</span>
          <span>{t('tableAvailability')}</span>
          <span>{t('labels')}</span>
          <span className="justify-self-end">{t('messages')}</span>
        </div>
        <div
          data-testid="dataset-member-scroll"
          className={cn('overflow-y-auto', TABLE_SCROLL)}
        >
          {memberRows.length === 0 ? (
            <p
              data-testid="dataset-member-empty"
              className="px-[18px] py-4 text-[12.5px] text-text-muted"
            >
              {scopeMembers.length === 0
                ? t('noMembersYet')
                : t('noMemberSearchMatch', { search: state.memberSearch })}
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
        className="min-h-0 flex-1 overflow-y-auto border-t-4 border-border"
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
