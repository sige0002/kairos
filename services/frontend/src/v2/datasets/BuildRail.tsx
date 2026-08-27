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
// expanded row still carries its specific reason (data.ts addBlockedReasons),
// so the two causes never read as one vague "unavailable".
//
// Archive lives here rather than beside the member detail because here is where
// it can succeed: the backend refuses to archive a capture that still belongs to
// any dataset, exactly as it refuses to delete one.

import { AvailabilityChip } from '../captures/AvailabilityChip';
import { useTranslation } from 'react-i18next';
import { CaptureLabelChips } from '../episodeChips';
import { ArchiveDialog } from './ArchiveDialog';
import { BulkAddDialog } from './BulkAddDialog';
import { CandidateFilterBuilder } from './CandidateFilterBuilder';
import { CaptureConditionLabel } from './CaptureConditionLabel';
import {
  addBlockedReasons,
  captureFacts,
  captureWhen,
  memberCount,
  shortCaptureId,
} from './data';
import type { CaptureListItem } from '../../api/types';
import type { DatasetsState } from './useDatasetsState';

function addBlockedReasonLabel(
  reasons: ReturnType<typeof addBlockedReasons>,
  t: (key: 'blockedNotLocal' | 'blockedNotAdopted') => string,
): string | null {
  return reasons.length > 0
    ? reasons
        .map((reason) =>
          t(reason === 'bytes_not_local' ? 'blockedNotLocal' : 'blockedNotAdopted'),
        )
        .join(' ')
    : null;
}

function CandidateRow({
  capture,
  state,
}: {
  capture: CaptureListItem;
  state: DatasetsState;
}) {
  const { t } = useTranslation('datasets');
  const adding = state.addingCaptureId === capture.capture_id;
  const memberships = capture.memberships ?? [];
  // A frozen dataset (§6.x) cannot take members any more than no dataset can —
  // the server refuses, so the Add control treats it as "no valid target".
  const noTarget =
    state.selectedDatasetId === null || state.isDatasetFrozen(state.selectedDatasetId);
  const blocked = addBlockedReasonLabel(addBlockedReasons(capture), t);
  const facts = captureFacts(capture);
  return (
    <div
      data-testid={`dataset-candidate-${capture.capture_id}`}
      data-capture-id={capture.capture_id}
      className="flex flex-col gap-1.5 rounded-[10px] border border-border px-[11px] py-[9px]"
    >
      {/* Identity first: when · what · how long. A run_id alone cannot answer
          "which data is this?" (2026-08-03 feedback) — same-day runs differ
          only in their final digits — so the run name is the secondary, on-disk
          line and the human facts lead. */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-primary">
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
          className="truncate text-[11px] text-text-muted"
        >
          {facts}
        </span>
      )}
      <span
        title={capture.capture_id}
        className="truncate font-mono text-[10.5px] text-text-muted"
      >
        {capture.run_id ?? shortCaptureId(capture.capture_id)}
      </span>
      <CaptureLabelChips capture={capture} />
      <CaptureConditionLabel
        capture={capture}
        state={state}
        testId={`dataset-candidate-condition-${capture.capture_id}`}
      />
      {memberships.length > 0 && (
        <span className="text-[10.5px] text-text-muted">
          {t('alreadyIn', {
            datasets: memberships.map((m) => m.dataset_name ?? m.dataset_id).join(', '),
          })}
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
          title={blocked ?? (noTarget ? t('selectDatasetFirst') : t('addMemberHint'))}
          className="rounded-chip bg-accent px-2.5 py-[3px] text-[11px] font-bold text-text-inverse hover:bg-accent-strong disabled:opacity-40"
        >
          {adding ? t('addingMember') : `+ ${t('add')}`}
        </button>
        {state.canArchive(capture) && (
          <button
            type="button"
            data-testid={`dataset-archive-${capture.capture_id}`}
            onClick={() => state.openArchive(capture)}
            title={t('archiveCaptureHint')}
            className="rounded-chip border border-border px-2.5 py-[3px] text-[11px] font-semibold text-text-secondary hover:bg-surface-muted"
          >
            {t('archive')}
          </button>
        )}
      </div>
    </div>
  );
}

export function BuildRail({ state }: { state: DatasetsState }) {
  const { t } = useTranslation('datasets');
  const target = state.selectedDataset;
  const hidden = state.candidateMatchCount - state.candidates.length;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="shrink-0 border-b border-border px-[18px] py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('buildDataset')}
        </h2>
      </div>

      <div className="shrink-0 border-b border-border px-[18px] py-[13px]">
        {target && state.isDatasetFrozen(target.dataset.dataset_id) ? (
          <p
            data-testid="build-target-frozen"
            className="break-words text-[12.5px] leading-relaxed text-text-muted"
          >
            {t('frozenDatasetHint', {
              name: target.dataset.name,
              status: target.dataset.status,
            })}
          </p>
        ) : target ? (
          <p
            data-testid="build-target"
            className="break-words text-[12.5px] leading-relaxed text-text-secondary"
          >
            {t('addingToDataset', {
              name: target.dataset.name,
              members: String(memberCount(target.dataset.member_count)),
            })}
          </p>
        ) : (
          <p
            data-testid="build-no-target"
            className="text-[12.5px] leading-relaxed text-text-muted"
          >
            {t('noDatasetTarget')}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-[18px] py-[11px]">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('recordings')}
        </h3>
        <CandidateFilterBuilder state={state} />
        {state.unresolvedLegacyConditionCount > 0 && (
          <p
            data-testid="dataset-legacy-condition-excluded"
            className="text-[11px] leading-relaxed text-status-warning-text"
          >
            {t('legacyConditionsUnavailable', {
              count: state.unresolvedLegacyConditionCount,
            })}
          </p>
        )}
        <button
          type="button"
          data-testid="dataset-bulk-add-open"
          onClick={state.openBulkAdd}
          disabled={
            !target ||
            state.isDatasetFrozen(target.dataset.dataset_id) ||
            state.addingCaptureId !== null ||
            state.bulkAddBusy
          }
          className="w-full cursor-pointer rounded-control bg-accent px-3 py-2 text-[12px] font-bold text-text-inverse shadow-btn transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('checkMatching')}
        </button>
      </div>

      <div
        data-testid="dataset-candidates"
        className="min-h-0 flex-1 overflow-y-auto px-[14px] py-2.5"
      >
        <div
          data-testid="dataset-candidate-pagination"
          className="mb-2 flex items-center gap-2 px-1 text-[11px] text-text-muted"
        >
          <button
            type="button"
            data-testid="dataset-candidates-previous"
            onClick={state.previousCandidatePage}
            disabled={!state.canPreviousCandidatePage}
            className="rounded-chip border border-border px-2 py-0.5 font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('pagerPrevious')}
          </button>
          <span aria-live="polite">
            {t('candidatePage', { page: String(state.candidatePage) })}
          </span>
          <button
            type="button"
            data-testid="dataset-candidates-next"
            onClick={state.nextCandidatePage}
            disabled={!state.canNextCandidatePage}
            className="rounded-chip border border-border px-2 py-0.5 font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('pagerNext')}
          </button>
        </div>
        {state.candidates.length === 0 ? (
          <p
            data-testid="dataset-candidates-empty"
            className="px-1 py-3 text-[12.5px] text-text-muted"
          >
            {state.candidateConditions.some(
              (condition) =>
                condition.field === 'condition' || condition.field === 'any',
            ) && state.conditionFilterStatus === 'loading'
              ? t('candidateLoadingConditions')
              : state.candidateConditions.some(
                    (condition) =>
                      condition.field === 'condition' || condition.field === 'any',
                  ) && state.conditionFilterStatus === 'error'
                ? t('candidateConditionsError')
                : state.candidateConditions.length > 0
                  ? t('noCandidateMatches')
                  : target
                    ? t('allInDataset')
                    : t('allInAnyDataset')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {state.candidates.map((capture) => (
              <CandidateRow key={capture.capture_id} capture={capture} state={state} />
            ))}
            {hidden > 0 && (
              <span
                data-testid="dataset-candidates-more"
                className="px-1 py-1 text-[11px] text-text-muted"
              >
                {t('moreMatches', { count: hidden })}
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
            className="mt-1.5 rounded-control border border-status-warning-border bg-status-warning-bg px-2 py-1.5 text-[11px] leading-relaxed text-status-warning-text"
          >
            {t('catalogPageDetail', { page: String(state.candidatePage) })}
          </p>
        )}
        {state.blockedCandidateCount > 0 && (
          <button
            type="button"
            data-testid="dataset-candidates-blocked-toggle"
            onClick={state.toggleBlockedCandidates}
            title={t('blockedCandidatesHint')}
            className="mt-1.5 w-full rounded-chip border border-border px-2 py-1 text-[11px] font-semibold text-text-muted hover:bg-surface-muted"
          >
            {state.showBlockedCandidates
              ? t('hideBlocked', { count: state.blockedCandidateCount })
              : t('showBlocked', { count: state.blockedCandidateCount })}
          </button>
        )}
      </div>

      <p
        data-testid="views-note"
        className="shrink-0 border-t border-border px-[18px] py-[11px] text-[11px] leading-relaxed text-text-muted"
      >
        {t('viewsRegenerated')}
      </p>

      <ArchiveDialog state={state} />
      <BulkAddDialog state={state} />
    </div>
  );
}
