// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The selected member's capture — rendered BELOW the member table inside the
// center column. Real capture fields (`GET /api/v1/captures/{id}`): messages,
// size, topics, the label chips, and the reused inspection (loss report / video
// check / JSON sidecars), all keyed by capture_id.
//
// The three departure controls sit together because the ORDER between them is
// the thing an operator has to know: `POST /captures/{id}/delete` is refused
// with 400 `capture_in_dataset` while the capture is still a member, so "Remove
// from dataset" is the first control and the sentence under it says why. The
// dialogs themselves are the shared ones (captures/DeleteDialogs.tsx) driven by
// useCaptureDeletion — discard and delete must not read differently here than
// they do in Review.

import { Badge } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { availabilityOf } from '../captures/availability';
import { CaptureLabelChips } from '../episodeChips';
import { CaptureConditionLabel } from './CaptureConditionLabel';
import { DatasetInspection } from './DatasetInspection';
import { formatBytes, formatCount, formatWhen, type MemberRow } from './data';
import type { DatasetsState } from './useDatasetsState';

/** Duration between two ISO instants, or "—" when indeterminate. */
function formatSpan(started?: string | null, ended?: string | null): string {
  if (!started || !ended) return '—';
  const s = Date.parse(started);
  const e = Date.parse(ended);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return '—';
  const secs = Math.round((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function DatasetDetail({
  state,
  member,
}: {
  state: DatasetsState;
  member: MemberRow;
}) {
  const { t } = useTranslation(['datasets', 'collect']);
  const { detail, detailLoading, detailError } = state;
  const capture = member.capture;
  const removing = state.removingMembershipId === member.membershipId;
  // A member of a frozen dataset (§6.x) gets no departure controls at all:
  // the member set is sealed and the server refuses every one of them, so
  // offering the buttons would be offering guaranteed failures.
  const frozen = state.isDatasetFrozen(member.datasetId);

  return (
    <div className="flex min-w-0 flex-col gap-4 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span data-testid="dataset-member-number">
          <Badge tone="teal" mono>
            #{member.displayIndex}
          </Badge>
        </span>
        <span
          data-testid="dataset-member-capture"
          title={member.captureId}
          className="font-mono text-[13px] font-semibold text-text-primary"
        >
          {capture?.run_id ?? member.captureId}
        </span>
        {capture && (
          <AvailabilityChip capture={capture} testId="dataset-detail-availability" />
        )}
        <div className="flex-1" />
        {!frozen && (
          <>
            <button
              type="button"
              data-testid="remove-member-btn"
              onClick={() => state.removeMember(member)}
              disabled={removing}
              title={t('datasets:removeMemberHint')}
              className="inline-flex shrink-0 items-center rounded-control border border-accent px-2.5 py-1 text-xs font-semibold text-accent hover:bg-interaction-selected disabled:opacity-50"
            >
              {removing ? t('datasets:removingMember') : t('datasets:removeMember')}
            </button>
            {capture && (
              <>
                <button
                  type="button"
                  data-testid="discard-member-btn"
                  onClick={() => state.deletion.requestDiscard(capture)}
                  title={t('datasets:discardMemberHint')}
                  className="inline-flex shrink-0 items-center rounded-control border border-status-danger-border px-2.5 py-1 text-xs font-semibold text-status-danger-text hover:bg-status-danger-bg"
                >
                  {t('datasets:discardMember')}
                </button>
                <button
                  type="button"
                  data-testid="delete-member-btn"
                  onClick={() => state.deletion.requestDelete(capture)}
                  title={t('datasets:deleteMemberHint')}
                  className="inline-flex shrink-0 items-center rounded-control border border-border px-2.5 py-1 text-xs font-semibold text-text-secondary hover:bg-surface-muted"
                >
                  {t('datasets:remove')}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {frozen && (
        <p
          data-testid="dataset-member-frozen-note"
          className="rounded-control border border-border bg-surface-muted px-3 py-2 text-[12px] leading-relaxed text-text-secondary"
        >
          {t('datasets:frozenMemberNote')}
        </p>
      )}

      {capture && !frozen && (
        <>
          <p
            data-testid="dataset-member-order-note"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] leading-relaxed text-status-warning-text"
          >
            {t('datasets:removeFirstNote')}
          </p>
          <CaptureLabelChips capture={capture} testId="dataset-member-labels" />
          <CaptureConditionLabel
            capture={capture}
            state={state}
            testId="dataset-detail-condition"
          />
        </>
      )}

      {!capture ? (
        <p
          data-testid="dataset-member-unresolved-note"
          className="text-sm text-text-muted"
        >
          {t('datasets:unresolvedMember')}
        </p>
      ) : detailLoading ? (
        <span className="text-sm text-text-muted">{t('datasets:loadingCapture')}</span>
      ) : detailError ? (
        <span className="text-sm text-status-warning-text">
          {t('datasets:loadCaptureFailed')}
        </span>
      ) : detail ? (
        <>
          <div className="grid grid-cols-4 gap-2" data-testid="dataset-member-stats">
            <Stat
              value={formatCount(detail.message_count)}
              label={t('datasets:messages')}
            />
            <Stat value={formatBytes(detail.bytes)} label={t('datasets:size')} />
            <Stat
              value={String(detail.topics?.length ?? 0)}
              label={t('datasets:topics')}
            />
            <Stat
              value={formatSpan(detail.started_at, detail.ended_at)}
              label={t('datasets:memberDuration')}
            />
          </div>

          <div className="flex flex-col gap-1 text-[11.5px] leading-relaxed text-text-muted">
            <span>
              {t('collect:recorded')} {formatWhen(detail.started_at)}
            </span>
            {/* The chip above is a word; this is the sentence behind it — a
                member whose bytes are elsewhere needs the whole explanation,
                not a two-word badge (§12). */}
            <span data-testid="dataset-member-availability-detail">
              {availabilityOf(detail).detail}
            </span>
          </div>

          <div className="border-t border-border pt-4">
            <DatasetInspection detail={detail} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[11px] border border-border px-[14px] py-[11px]">
      <span className="font-mono text-[21px] font-semibold text-text-primary">
        {value}
      </span>
      <span className="text-[11.5px] text-text-muted">{label}</span>
    </div>
  );
}
