// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > System > Generated files. Analysis is operator-triggered rather
// than folded into the frequently-polled /system request: walking report/ can
// be expensive on a long-lived installation.

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Modal } from '../../components/ui';
import { formatBytes } from '../review/format';
import {
  cleanupReports,
  previewReportCleanup,
  type CaptureScope,
  type ReportCategory,
  type ReportCleanupCriteria,
  type ReportCleanupResult,
} from './reportStorageApi';

const DEFAULT_CRITERIA: ReportCleanupCriteria = {
  categories: ['preview', 'analysis'],
  older_than_days: 30,
  pipeline: null,
  capture_scope: 'source_available',
};

const CATEGORY_OPTIONS: Array<{
  value: ReportCategory;
  label: string;
  detail: string;
}> = [
  {
    value: 'preview',
    label: 'Video previews',
    detail: 'MP4 previews; regenerated on demand.',
  },
  {
    value: 'analysis',
    label: 'Analysis reports',
    detail: 'Signal, loss, clock and plugin reports.',
  },
  {
    value: 'validation',
    label: 'Validation results',
    detail: 'May return captures to Not validated.',
  },
];

function criteriaKey(criteria: ReportCleanupCriteria): string {
  return JSON.stringify(criteria);
}

function ErrorNote({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
    >
      {error instanceof Error ? error.message : 'The storage operation failed.'}
    </p>
  );
}

export function GeneratedFilesSection() {
  const [open, setOpen] = useState(false);
  const [criteria, setCriteria] = useState<ReportCleanupCriteria>(DEFAULT_CRITERIA);
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  const [validationAcknowledged, setValidationAcknowledged] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<ReportCleanupResult | null>(null);

  const preview = useMutation({
    mutationFn: previewReportCleanup,
    onSuccess: (_data, variables) => {
      setPreviewedKey(criteriaKey(variables));
      setValidationAcknowledged(false);
    },
  });
  const cleanup = useMutation({
    mutationFn: cleanupReports,
    onSuccess: (result) => {
      setCleanupResult(result);
      setPreviewedKey(null);
      preview.mutate(criteria);
    },
  });

  const dirty = previewedKey !== criteriaKey(criteria);
  const validationWarning = (preview.data?.validation_resets ?? 0) > 0;
  const cleanupIncomplete = (cleanupResult?.failed_units.length ?? 0) > 0;
  const canDelete =
    !dirty &&
    (preview.data?.selected_units ?? 0) > 0 &&
    !preview.isPending &&
    !cleanup.isPending &&
    (!validationWarning || validationAcknowledged);

  const reportTotal = preview.data?.report_total_bytes;
  const categorySet = useMemo(
    () => new Set(criteria.categories),
    [criteria.categories],
  );

  function changeCriteria(patch: Partial<ReportCleanupCriteria>) {
    setCriteria((current) => ({ ...current, ...patch }));
    setValidationAcknowledged(false);
    setCleanupResult(null);
  }

  function toggleCategory(category: ReportCategory) {
    const selected = categorySet.has(category);
    if (selected && criteria.categories.length === 1) return;
    changeCriteria({
      categories: selected
        ? criteria.categories.filter((item) => item !== category)
        : [...criteria.categories, category],
    });
  }

  function analyze() {
    setOpen(true);
    setCleanupResult(null);
    preview.mutate(criteria);
  }

  return (
    <div
      data-testid="generated-files"
      className="flex flex-col gap-2.5 border-t border-gray-100 pt-5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
            Generated files
          </h3>
          <p className="mt-1 text-[11.5px] text-gray-500">
            Reclaim derived previews and reports without deleting capture data.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-[13px] font-semibold text-gray-800">
            {reportTotal == null ? 'Not analyzed' : formatBytes(reportTotal)}
          </div>
          {preview.data && (
            <div className="text-[11px] text-gray-500">
              {preview.data.report_total_files} generated files
            </div>
          )}
        </div>
        <Button variant="ghost" onClick={analyze} disabled={preview.isPending}>
          {reportTotal == null ? 'Analyze storage' : 'Review cleanup'}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => !cleanup.isPending && setOpen(false)}
        title="Clean up generated files"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={cleanup.isPending}
            >
              Close
            </Button>
            <Button
              variant="danger"
              disabled={!canDelete}
              onClick={() => cleanup.mutate(criteria)}
            >
              {cleanup.isPending
                ? 'Deleting…'
                : `Delete ${formatBytes(preview.data?.selected_bytes ?? 0)}`}
            </Button>
          </>
        }
      >
        <div className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1">
          <p className="text-xs text-gray-500">
            Choose conditions, update the preview, then delete. Paths are resolved by
            the server and cannot be entered here.
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-semibold text-gray-800">
              Generated file types
            </legend>
            {CATEGORY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex items-start gap-2 rounded-control border border-gray-200 p-2.5"
              >
                <input
                  type="checkbox"
                  checked={categorySet.has(option.value)}
                  disabled={
                    categorySet.has(option.value) && criteria.categories.length === 1
                  }
                  onChange={() => toggleCategory(option.value)}
                  className="mt-0.5 accent-teal-700"
                />
                <span>
                  <span className="block text-xs font-semibold text-gray-800">
                    {option.label}
                  </span>
                  <span className="block text-[11px] text-gray-500">
                    {option.detail}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700">
              Generated before
              <select
                value={criteria.older_than_days}
                onChange={(event) =>
                  changeCriteria({ older_than_days: Number(event.target.value) })
                }
                className="rounded-control border border-gray-200 bg-white px-2.5 py-2 font-normal text-gray-800"
              >
                <option value={7}>7 days ago</option>
                <option value={30}>30 days ago</option>
                <option value={90}>90 days ago</option>
                <option value={0}>Any time</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700">
              Capture scope
              <select
                value={criteria.capture_scope}
                onChange={(event) =>
                  changeCriteria({ capture_scope: event.target.value as CaptureScope })
                }
                className="rounded-control border border-gray-200 bg-white px-2.5 py-2 font-normal text-gray-800"
              >
                <option value="source_available">Source on this device</option>
                <option value="orphaned">Orphaned reports only</option>
                <option value="all">All reports</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 sm:col-span-2">
              Pipeline
              <select
                value={criteria.pipeline ?? ''}
                onChange={(event) =>
                  changeCriteria({ pipeline: event.target.value || null })
                }
                className="rounded-control border border-gray-200 bg-white px-2.5 py-2 font-normal text-gray-800"
              >
                <option value="">All selected types</option>
                {(preview.data?.available_pipelines ?? []).map((pipeline) => (
                  <option key={pipeline} value={pipeline}>
                    {pipeline}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <Button
            variant="ghost"
            onClick={() => preview.mutate(criteria)}
            disabled={preview.isPending || cleanup.isPending}
          >
            {preview.isPending ? 'Analyzing…' : 'Update preview'}
          </Button>

          {preview.isError && <ErrorNote error={preview.error} />}
          {cleanup.isError && <ErrorNote error={cleanup.error} />}

          {preview.data && (
            <div className="rounded-control border border-gray-200 bg-gray-50 p-3 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-gray-700">Selected</span>
                <span
                  data-testid="cleanup-selected"
                  className="ml-auto font-mono font-semibold text-gray-900"
                >
                  {formatBytes(preview.data.selected_bytes)}
                </span>
              </div>
              <p className="mt-1 text-gray-500">
                {preview.data.selected_units} report sets ·{' '}
                {preview.data.selected_captures} captures ·{' '}
                {preview.data.selected_files} files
              </p>
              {preview.data.protected_active_units > 0 && (
                <p data-testid="cleanup-protected" className="mt-2 text-amber-700">
                  {preview.data.protected_active_units} active report sets are protected
                  and excluded.
                </p>
              )}
              {preview.data.source_unavailable_units > 0 && (
                <p className="mt-2 text-red-700">
                  {preview.data.source_unavailable_units} report sets have no source on
                  this device and may not be regenerable here.
                </p>
              )}
              {preview.data.scan_errors > 0 && (
                <p className="mt-2 text-red-700">
                  {preview.data.scan_errors} filesystem entries could not be measured
                  and are excluded.
                </p>
              )}
              {dirty && (
                <p className="mt-2 font-semibold text-amber-700">
                  Conditions changed — update the preview before deleting.
                </p>
              )}
            </div>
          )}

          {validationWarning && !dirty && (
            <div
              data-testid="validation-reset-warning"
              className="rounded-control border border-red-200 bg-red-50 p-3 text-xs text-red-800"
            >
              <p className="font-semibold">
                {preview.data?.validation_resets} captures will return to Not validated.
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={validationAcknowledged}
                  onChange={(event) => setValidationAcknowledged(event.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>I understand that validation must be run again.</span>
              </label>
            </div>
          )}

          {cleanupResult && (
            <div
              role={cleanupIncomplete ? 'alert' : 'status'}
              className={`rounded-control border p-3 text-xs ${
                cleanupIncomplete
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-green-200 bg-green-50 text-green-800'
              }`}
            >
              {cleanupIncomplete ? 'Cleanup incomplete. ' : ''}Deleted{' '}
              {cleanupResult.deleted_units} report sets (
              {formatBytes(cleanupResult.deleted_bytes)}).
              {cleanupResult.protected_active_units > 0 &&
                ` ${cleanupResult.protected_active_units} active sets were skipped.`}
              {cleanupResult.failed_units.length > 0 &&
                ` ${cleanupResult.failed_units.length} sets failed and remain on disk.`}
              {cleanupIncomplete && (
                <ul
                  data-testid="cleanup-failures"
                  className="mt-2 max-h-32 list-disc space-y-1 overflow-y-auto pl-4 font-mono text-[11px]"
                >
                  {cleanupResult.failed_units.map((failure) => (
                    <li key={`${failure.pipeline}:${failure.capture_id}`}>
                      {failure.pipeline} / {failure.capture_id}: {failure.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
