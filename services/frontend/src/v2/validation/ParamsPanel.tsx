// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Params column (inner-left, 300px): the REAL schema-driven PipelineForm and
// capture picker, submitting an actual /jobs POST, plus the real one-click
// presets (GET /validation/presets) — each runs its pipeline over exactly the
// captures it hasn't validated yet (`pending_capture_ids`).
//
// Every option in the target selector is a capture, because every job is
// (contract §10.5). A capture whose bytes are not on this host stays selectable
// on purpose: the chip and the note beside the selector are the only place the
// operator finds out WHY it cannot be validated from here.
import type { JSONSchema } from '../../schema/jsonSchema';
import type {
  Batch,
  CaptureListItem,
  ValidationOption,
  ValidationPreset,
} from '../../api/types';
import { availabilityOf } from '../captures/availability';
import { AvailabilityChip } from '../captures/AvailabilityChip';
import { formatBatchLabel } from '../episodeChips';
import { PipelineForm } from '../../features/validation/PipelineForm';
import { JobErrorNote } from '../captures/JobErrorNote';
import { Badge } from '../../components/ui';
import { useTranslation } from 'react-i18next';

export const ALL_CAPTURES = '__all__';
// A batch target value: `batch:<batch_id>` — runs the pipeline over every
// capture of that batch whose bytes are here (the blast-radius check: verify a
// whole suspect batch in one click). Single captures use the bare capture_id.
export const BATCH_VALUE_PREFIX = 'batch:';

const SELECT_CLASS =
  'rounded-control border border-border px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none';

/** What to call a capture on screen. `run_id` is display-only (§1) and can be
 *  absent — a capture pulled from another host may have none — in which case
 *  the capture_id it is actually keyed by is shown rather than invented. */
export function captureLabel(
  capture: Pick<CaptureListItem, 'capture_id' | 'run_id'>,
): string {
  return capture.run_id || capture.capture_id;
}

/** A capture option's text: its name, and for one that cannot be validated from
 *  here, the §8 state standing in the way. */
function captureOptionLabel(capture: CaptureListItem): string {
  const availability = availabilityOf(capture);
  return availability.usable
    ? captureLabel(capture)
    : `${captureLabel(capture)} — ${availability.label}`;
}

export function ParamsPanel({
  schema,
  params,
  onParamsChange,
  templateOptions,
  suggestions,
  captures,
  capturesLoading,
  catalogTruncated,
  capturePage,
  canPreviousCapturePage,
  canNextCapturePage,
  onCapturePageChange,
  batches,
  targetId,
  onTargetChange,
  selectedCapture,
  targetNote,
  selectionMessage,
  onRun,
  canRun,
  running,
  progressPct,
  progressLabel,
  onCancelRun,
  cancelBusy,
  cancelError,
  onDismissCancelError,
  presets,
  presetsLoading,
  onRunPreset,
  submitError,
  submitFailures,
  captureLabel,
  onRetryFailures,
  retryBusy,
}: {
  schema: JSONSchema;
  params: Record<string, unknown>;
  /** Context suggestions for `x-suggest` params (from the target capture). */
  suggestions?: Record<string, string[]>;
  onParamsChange: (next: Record<string, unknown>) => void;
  templateOptions: ValidationOption[];
  /** Terminal captures, newest first — every one of them a possible target. */
  captures: CaptureListItem[];
  capturesLoading: boolean;
  /** True when the capture sweep stopped before the end of the catalog, so the
   *  options below — and their counts — are of what was fetched. */
  catalogTruncated?: boolean;
  capturePage: number;
  canPreviousCapturePage: boolean;
  canNextCapturePage: boolean;
  onCapturePageChange: (direction: 'previous' | 'next') => void;
  /** Batches with at least one capture (newest first). */
  batches: Batch[];
  targetId: string;
  onTargetChange: (id: string) => void;
  /** The capture `targetId` names, when it names one (not "all" or a batch). */
  selectedCapture: CaptureListItem | null;
  /** Why the selected target cannot be validated from this host, when it can't. */
  targetNote?: string;
  /** Result of creating a server-side All/Batch selection. */
  selectionMessage?: string | null;
  onRun: () => void;
  canRun: boolean;
  running: boolean;
  progressPct: number;
  progressLabel: string;
  /** Stop every job of this run that has not finished. Absent when there is
   *  nothing cancellable left (every job already reached an end). */
  onCancelRun?: () => void;
  cancelBusy?: boolean;
  /** A refused cancel, in the operator's words. Held until dismissed: it means
   *  a job they asked to stop is still running. */
  cancelError?: string | null;
  onDismissCancelError?: () => void;
  presets: ValidationPreset[];
  presetsLoading: boolean;
  onRunPreset: (preset: ValidationPreset) => void;
  submitError?: unknown;
  /** Captures whose job could not be created. Listed rather than counted: a
   *  preset runs over many captures and "which ones did not run" is the
   *  question the operator actually has. */
  submitFailures?: { captureId: string; reason: string }[];
  captureLabel?: (captureId: string) => string;
  /** Durable runs retry only server-recorded submission failures. */
  onRetryFailures?: () => void;
  retryBusy?: boolean;
}) {
  const { t } = useTranslation('validation');
  return (
    <div className="flex flex-col gap-3 overflow-auto border-r border-border px-[18px] py-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {t('parameters')}
      </h3>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="validation-target" className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-text-muted">{t('target')}</span>
          {selectedCapture && (
            <AvailabilityChip capture={selectedCapture} testId="target-availability" />
          )}
        </label>
        <select
          id="validation-target"
          aria-label={t('targetAria')}
          value={targetId}
          onChange={(e) => onTargetChange(e.target.value)}
          disabled={running}
          className={SELECT_CLASS}
        >
          <option value="">{capturesLoading ? t('loading') : t('selectTarget')}</option>
          <optgroup label={t('captureGroup')}>
            {captures.length === 0 ? (
              <option value="" disabled>
                {t('noFinishedCaptures')}
              </option>
            ) : (
              <>
                <option value={ALL_CAPTURES}>{t('allCapturesHost')}</option>
                {captures.map((c) => (
                  <option key={c.capture_id} value={c.capture_id}>
                    {captureOptionLabel(c)}
                  </option>
                ))}
              </>
            )}
          </optgroup>
          <optgroup label={t('batchesGroup')}>
            {batches.length === 0 ? (
              <option value="" disabled>
                {t('noBatches')}
              </option>
            ) : (
              batches.map((b) => {
                return (
                  <option key={b.batch_id} value={`${BATCH_VALUE_PREFIX}${b.batch_id}`}>
                    {formatBatchLabel(b.batch_seq, b.created_at)} · {b.task}
                    {t('serverSelection')}
                  </option>
                );
              })
            )}
          </optgroup>
        </select>
        {targetNote && (
          <span
            data-testid="target-note"
            className="text-[11px] leading-relaxed text-status-warning-text"
          >
            {targetNote}
          </span>
        )}
        {selectionMessage && (
          <span
            role="alert"
            data-testid="validation-selection-message"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-2 py-1.5 text-[11px] leading-relaxed text-status-warning-text"
          >
            {selectionMessage}
          </span>
        )}
        {/* This picker is one page. All/Batch execution is a server snapshot;
            only individual capture choices are page-scoped. */}
        {catalogTruncated && (
          <span
            data-testid="catalog-truncated"
            className="rounded-control border border-status-warning-border bg-status-warning-bg px-2 py-1.5 text-[11px] leading-relaxed text-status-warning-text"
          >
            {t('catalogPage', { page: String(capturePage) })}
          </span>
        )}
        <div
          data-testid="validation-capture-pagination"
          className="flex items-center gap-2 text-[11px] text-text-muted"
        >
          <button
            type="button"
            data-testid="validation-captures-previous"
            disabled={!canPreviousCapturePage || running}
            onClick={() => onCapturePageChange('previous')}
            className="rounded-chip border border-border px-2 py-0.5 font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('previous')}
          </button>
          <span aria-live="polite">{t('page', { page: String(capturePage) })}</span>
          <button
            type="button"
            data-testid="validation-captures-next"
            disabled={!canNextCapturePage || running}
            onClick={() => onCapturePageChange('next')}
            className="rounded-chip border border-border px-2 py-0.5 font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('next')}
          </button>
        </div>
        <span className="text-[11px] text-text-muted">{t('validationScope')}</span>
      </div>

      <PipelineForm
        schema={schema}
        value={params}
        onChange={onParamsChange}
        templateOptions={templateOptions}
        suggestions={suggestions}
      />

      {/* Real one-click presets (GET /validation/presets): each runs its own
          pipeline over exactly the captures it hasn't validated yet. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-text-primary">{t('presets')}</span>
        {presetsLoading ? (
          <p className="text-[11px] text-text-muted">{t('loadingPresets')}</p>
        ) : presets.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-text-muted">
            {t('noPresets')}
          </p>
        ) : (
          presets.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`preset-${p.id}`}
              disabled={p.pending === 0 || running}
              onClick={() => onRunPreset(p)}
              title={p.description || undefined}
              className="flex items-center gap-2 rounded-[9px] border border-border bg-surface px-[11px] py-2 text-left hover:border-accent hover:bg-interaction-selected/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-text-primary">
                  {p.name}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-text-muted">
                  {p.pipeline}
                </span>
              </span>
              <Badge tone={p.pending > 0 ? 'teal' : 'gray'} dot={p.pending > 0}>
                {p.pending > 0
                  ? t('presetPending', { count: p.pending })
                  : t('presetCurrent')}
              </Badge>
            </button>
          ))
        )}
      </div>

      <div className="flex-1" />

      <JobErrorNote error={submitError} testId="validation-submit-error" />

      {(submitFailures?.length ?? 0) > 0 && (
        <ul
          data-testid="submit-failures"
          className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[11.5px] text-status-warning-text"
        >
          {submitFailures!.map((f) => (
            <li key={f.captureId}>
              <span className="font-semibold">
                {captureLabel ? captureLabel(f.captureId) : f.captureId}
              </span>{' '}
              — {f.reason}
            </li>
          ))}
        </ul>
      )}
      {onRetryFailures && (
        <button
          type="button"
          data-testid="retry-validation-run"
          disabled={retryBusy}
          onClick={onRetryFailures}
          className="h-[34px] rounded-[10px] border border-status-warning-border bg-status-warning-bg text-[12.5px] font-semibold text-status-warning-text hover:border-status-warning-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retryBusy ? t('retryingFailures') : t('retryFailedCaptures')}
        </button>
      )}

      {cancelError && (
        <div
          role="alert"
          data-testid="cancel-error"
          className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2.5 text-[12px] text-status-warning-text"
        >
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
            {t('notCanceled')}
          </span>
          <span className="font-semibold">{cancelError}</span>
          <span>{t('jobRunning')}</span>
          <button
            type="button"
            onClick={onDismissCancelError}
            data-testid="cancel-error-dismiss"
            className="self-start text-[11.5px] font-semibold underline"
          >
            {t('dismiss')}
          </button>
        </div>
      )}

      {running ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex text-xs text-text-muted">
            <span>{progressLabel}</span>
            <div className="flex-1" />
            <span className="font-mono font-semibold">{progressPct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {onCancelRun && (
            <button
              type="button"
              data-testid="cancel-run"
              disabled={cancelBusy}
              onClick={onCancelRun}
              className="h-[34px] rounded-[10px] border border-border bg-surface text-[12.5px] font-semibold text-text-secondary hover:border-status-danger-border hover:text-status-danger-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelBusy ? t('canceling') : t('cancelRun')}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={!canRun}
          onClick={onRun}
          className="h-[42px] rounded-[10px] bg-accent text-[13.5px] font-bold text-text-inverse hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('runSelection')}
        </button>
      )}
    </div>
  );
}
