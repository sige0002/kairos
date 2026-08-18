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

export const ALL_CAPTURES = '__all__';
// A batch target value: `batch:<batch_id>` — runs the pipeline over every
// capture of that batch whose bytes are here (the blast-radius check: verify a
// whole suspect batch in one click). Single captures use the bare capture_id.
export const BATCH_VALUE_PREFIX = 'batch:';

const SELECT_CLASS =
  'rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-600 focus:outline-none';

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
  return (
    <div className="flex flex-col gap-3 overflow-auto border-r border-gray-100 px-[18px] py-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Parameters
      </h3>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="validation-target" className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-500">Target</span>
          {selectedCapture && (
            <AvailabilityChip capture={selectedCapture} testId="target-availability" />
          )}
        </label>
        <select
          id="validation-target"
          aria-label="target"
          value={targetId}
          onChange={(e) => onTargetChange(e.target.value)}
          disabled={running}
          className={SELECT_CLASS}
        >
          <option value="">{capturesLoading ? 'Loading…' : '— Select —'}</option>
          <optgroup label="Captures">
            {captures.length === 0 ? (
              <option value="" disabled>
                No finished captures
              </option>
            ) : (
              <>
                <option value={ALL_CAPTURES}>
                  — All captures on this host (server selection) —
                </option>
                {captures.map((c) => (
                  <option key={c.capture_id} value={c.capture_id}>
                    {captureOptionLabel(c)}
                  </option>
                ))}
              </>
            )}
          </optgroup>
          <optgroup label="Batches (validate every capture of a batch)">
            {batches.length === 0 ? (
              <option value="" disabled>
                No batches with captures
              </option>
            ) : (
              batches.map((b) => {
                return (
                  <option key={b.batch_id} value={`${BATCH_VALUE_PREFIX}${b.batch_id}`}>
                    {formatBatchLabel(b.batch_seq, b.created_at)} · {b.task}
                    {' (server selection)'}
                  </option>
                );
              })
            )}
          </optgroup>
        </select>
        {targetNote && (
          <span
            data-testid="target-note"
            className="text-[11px] leading-relaxed text-amber-700"
          >
            {targetNote}
          </span>
        )}
        {selectionMessage && (
          <span
            role="alert"
            data-testid="validation-selection-message"
            className="rounded-control border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800"
          >
            {selectionMessage}
          </span>
        )}
        {/* This picker is one page. All/Batch execution is a server snapshot;
            only individual capture choices are page-scoped. */}
        {catalogTruncated && (
          <span
            data-testid="catalog-truncated"
            className="rounded-control border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800"
          >
            This is page {capturePage}. Older individual captures are not offered here
            until you move to the next page; All and Batch create a server selection
            instead.
          </span>
        )}
        <div
          data-testid="validation-capture-pagination"
          className="flex items-center gap-2 text-[11px] text-gray-500"
        >
          <button
            type="button"
            data-testid="validation-captures-previous"
            disabled={!canPreviousCapturePage || running}
            onClick={() => onCapturePageChange('previous')}
            className="rounded-chip border border-gray-200 px-2 py-0.5 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span aria-live="polite">Page {capturePage}</span>
          <button
            type="button"
            data-testid="validation-captures-next"
            disabled={!canNextCapturePage || running}
            onClick={() => onCapturePageChange('next')}
            className="rounded-chip border border-gray-200 px-2 py-0.5 font-semibold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
        <span className="text-[11px] text-gray-500">
          Validation only — reviewing and dataset membership live in their own screens.
        </span>
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
        <span className="text-xs font-semibold text-gray-700">One-click presets</span>
        {presetsLoading ? (
          <p className="text-[11px] text-gray-500">Loading presets…</p>
        ) : presets.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-gray-500">
            No presets configured. Add{' '}
            <span className="font-mono">
              config/&lt;robot&gt;/validation_presets.yaml
            </span>
            .
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
              className="flex items-center gap-2 rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-left hover:border-teal-400 hover:bg-teal-50/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-gray-700">
                  {p.name}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-gray-500">
                  {p.pipeline}
                </span>
              </span>
              <Badge tone={p.pending > 0 ? 'teal' : 'gray'} dot={p.pending > 0}>
                {p.pending > 0 ? `${p.pending} pending` : 'up to date'}
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
          className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800"
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
          className="h-[34px] rounded-[10px] border border-amber-300 bg-amber-50 text-[12.5px] font-semibold text-amber-900 hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retryBusy ? 'Retrying failures…' : 'Retry failed captures'}
        </button>
      )}

      {cancelError && (
        <div
          role="alert"
          data-testid="cancel-error"
          className="flex flex-col gap-1 rounded-control border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900"
        >
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em]">
            Not cancelled
          </span>
          <span className="font-semibold">{cancelError}</span>
          <span>The job is still running — try again, or check it in Monitor.</span>
          <button
            type="button"
            onClick={onDismissCancelError}
            data-testid="cancel-error-dismiss"
            className="self-start text-[11.5px] font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {running ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex text-xs text-gray-500">
            <span>{progressLabel}</span>
            <div className="flex-1" />
            <span className="font-mono font-semibold">{progressPct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <span
              className="block h-full rounded-full bg-teal-600 transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {onCancelRun && (
            <button
              type="button"
              data-testid="cancel-run"
              disabled={cancelBusy}
              onClick={onCancelRun}
              className="h-[34px] rounded-[10px] border border-gray-200 bg-white text-[12.5px] font-semibold text-gray-600 hover:border-red-200 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelBusy ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={!canRun}
          onClick={onRun}
          className="h-[42px] rounded-[10px] bg-teal-700 text-[13.5px] font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run on selection
        </button>
      )}
    </div>
  );
}
