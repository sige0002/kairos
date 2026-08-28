// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > System > Generated files. Analysis is operator-triggered rather
// than folded into the frequently-polled /system request: walking report/ can
// be expensive on a long-lived installation.

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Modal } from '../../components/ui';
import { formatBytes } from '../review/format';
import { useTranslation } from 'react-i18next';
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

const CATEGORY_OPTIONS: ReportCategory[] = ['preview', 'analysis', 'validation'];

function criteriaKey(criteria: ReportCleanupCriteria): string {
  return JSON.stringify(criteria);
}

function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation('settings');
  return (
    <p
      role="alert"
      className="rounded-control border border-status-danger-border bg-status-danger-bg px-3 py-2 text-xs text-status-danger-text"
    >
      {error instanceof Error ? error.message : t('generatedFiles.operationFailed')}
    </p>
  );
}

export function GeneratedFilesSection() {
  const { t } = useTranslation('settings');
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
      className="flex flex-col gap-2.5 border-t border-border pt-5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
            {t('generatedFiles.title')}
          </h3>
          <p className="mt-1 text-[11.5px] text-text-muted">
            {t('generatedFiles.title')}
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-[13px] font-semibold text-text-primary">
            {reportTotal == null
              ? t('generatedFiles.notAnalyzed')
              : formatBytes(reportTotal)}
          </div>
          {preview.data && (
            <div className="text-[11px] text-text-muted">
              {t('generatedFiles.fileCount', {
                count: preview.data.report_total_files,
              })}
            </div>
          )}
        </div>
        <Button variant="ghost" onClick={analyze} disabled={preview.isPending}>
          {reportTotal == null
            ? t('generatedFiles.analyze')
            : t('generatedFiles.review')}
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => !cleanup.isPending && setOpen(false)}
        title={t('generatedFiles.dialogTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={cleanup.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!canDelete}
              onClick={() => cleanup.mutate(criteria)}
            >
              {cleanup.isPending
                ? t('generatedFiles.deleting')
                : t('generatedFiles.delete', {
                    size: formatBytes(preview.data?.selected_bytes ?? 0),
                  })}
            </Button>
          </>
        }
      >
        <div className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1">
          <p className="text-xs text-text-muted">{t('generatedFiles.dialogIntro')}</p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-semibold text-text-primary">
              {t('generatedFiles.title')}
            </legend>
            {CATEGORY_OPTIONS.map((option) => (
              <label
                key={option}
                className="flex items-start gap-2 rounded-control border border-border p-2.5"
              >
                <input
                  type="checkbox"
                  checked={categorySet.has(option)}
                  disabled={categorySet.has(option) && criteria.categories.length === 1}
                  onChange={() => toggleCategory(option)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="block text-xs font-semibold text-text-primary">
                    {option === 'preview'
                      ? t('generatedFiles.video')
                      : option === 'analysis'
                        ? t('generatedFiles.analysis')
                        : t('generatedFiles.validation')}
                  </span>
                  <span className="block text-[11px] text-text-muted">
                    {option === 'preview'
                      ? t('generatedFiles.videoDetail')
                      : option === 'analysis'
                        ? t('generatedFiles.analysisDetail')
                        : t('generatedFiles.validationDetail')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-semibold text-text-primary">
              {t('generatedFiles.generatedBefore')}
              <select
                value={criteria.older_than_days}
                onChange={(event) =>
                  changeCriteria({ older_than_days: Number(event.target.value) })
                }
                className="rounded-control border border-border bg-surface px-2.5 py-2 font-normal text-text-primary"
              >
                <option value={7}>{t('generatedFiles.ages.seven')}</option>
                <option value={30}>{t('generatedFiles.ages.thirty')}</option>
                <option value={90}>{t('generatedFiles.ages.ninety')}</option>
                <option value={0}>{t('generatedFiles.ages.any')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-text-primary">
              {t('generatedFiles.captureScope')}
              <select
                value={criteria.capture_scope}
                onChange={(event) =>
                  changeCriteria({ capture_scope: event.target.value as CaptureScope })
                }
                className="rounded-control border border-border bg-surface px-2.5 py-2 font-normal text-text-primary"
              >
                <option value="source_available">
                  {t('generatedFiles.scopes.source_available')}
                </option>
                <option value="orphaned">{t('generatedFiles.scopes.orphaned')}</option>
                <option value="all">{t('generatedFiles.scopes.all')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-text-primary sm:col-span-2">
              {t('generatedFiles.pipeline')}
              <select
                value={criteria.pipeline ?? ''}
                onChange={(event) =>
                  changeCriteria({ pipeline: event.target.value || null })
                }
                className="rounded-control border border-border bg-surface px-2.5 py-2 font-normal text-text-primary"
              >
                <option value="">{t('generatedFiles.allSelected')}</option>
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
            {preview.isPending
              ? t('generatedFiles.analyzing')
              : t('generatedFiles.updatePreview')}
          </Button>

          {preview.isError && <ErrorNote error={preview.error} />}
          {cleanup.isError && <ErrorNote error={cleanup.error} />}

          {preview.data && (
            <div className="rounded-control border border-border bg-surface-muted p-3 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-text-primary">
                  {t('generatedFiles.selected')}
                </span>
                <span
                  data-testid="cleanup-selected"
                  className="ml-auto font-mono font-semibold text-text-primary"
                >
                  {formatBytes(preview.data.selected_bytes)}
                </span>
              </div>
              <p className="mt-1 text-text-muted">
                {t('generatedFiles.selectedSummary', {
                  sets: String(preview.data.selected_units),
                  captures: String(preview.data.selected_captures),
                  files: String(preview.data.selected_files),
                })}
              </p>
              {preview.data.protected_active_units > 0 && (
                <p
                  data-testid="cleanup-protected"
                  className="mt-2 text-status-warning-text"
                >
                  {t('generatedFiles.activeProtected', {
                    count: preview.data.protected_active_units,
                  })}
                </p>
              )}
              {preview.data.source_unavailable_units > 0 && (
                <p className="mt-2 text-status-danger-text">
                  {t('generatedFiles.sourceUnavailable', {
                    count: preview.data.source_unavailable_units,
                  })}
                </p>
              )}
              {preview.data.scan_errors > 0 && (
                <p className="mt-2 text-status-danger-text">
                  {t('generatedFiles.scanErrors', { count: preview.data.scan_errors })}
                </p>
              )}
              {dirty && (
                <p className="mt-2 font-semibold text-status-warning-text">
                  {t('generatedFiles.criteriaChanged')}
                </p>
              )}
            </div>
          )}

          {validationWarning && !dirty && (
            <div
              data-testid="validation-reset-warning"
              className="rounded-control border border-status-danger-border bg-status-danger-bg p-3 text-xs text-status-danger-text"
            >
              <p className="font-semibold">
                {t('generatedFiles.validationResets', {
                  count: preview.data?.validation_resets ?? 0,
                })}
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={validationAcknowledged}
                  onChange={(event) => setValidationAcknowledged(event.target.checked)}
                  className="mt-0.5 accent-status-danger-accent"
                />
                <span>{t('generatedFiles.acknowledgment')}</span>
              </label>
            </div>
          )}

          {cleanupResult && (
            <div
              role={cleanupIncomplete ? 'alert' : 'status'}
              className={`rounded-control border p-3 text-xs ${
                cleanupIncomplete
                  ? 'border-status-warning-border bg-status-warning-bg text-status-warning-text'
                  : 'border-status-success-border bg-status-success-bg text-status-success-text'
              }`}
            >
              {cleanupIncomplete ? t('generatedFiles.cleanupIncomplete') : ''}
              {t('generatedFiles.deleted', {
                files: String(cleanupResult.deleted_files),
                sets: String(cleanupResult.deleted_units),
                size: formatBytes(cleanupResult.deleted_bytes),
              })}
              {cleanupResult.protected_active_units > 0 &&
                ` ${t('generatedFiles.activeSkipped', {
                  count: cleanupResult.protected_active_units,
                })}`}
              {cleanupResult.failed_units.length > 0 &&
                ` ${t('generatedFiles.failedRemain', {
                  count: cleanupResult.failed_units.length,
                })}`}
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
