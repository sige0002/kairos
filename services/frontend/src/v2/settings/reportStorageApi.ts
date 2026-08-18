// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings-local contract for generated-report maintenance. Deliberately no
// path field: the backend resolves semantic criteria beneath its own data dir.

import { apiPost } from '../../api/client';

export type ReportCategory = 'preview' | 'analysis' | 'validation';
export type CaptureScope = 'source_available' | 'orphaned' | 'all';

export interface ReportCleanupCriteria {
  categories: ReportCategory[];
  older_than_days: number;
  pipeline: string | null;
  capture_scope: CaptureScope;
}

export interface PipelineReportUsage {
  pipeline: string;
  category: ReportCategory;
  bytes: number;
  files: number;
  units: number;
}

export interface ReportStoragePreview {
  report_total_bytes: number;
  report_total_files: number;
  selected_bytes: number;
  selected_files: number;
  selected_units: number;
  selected_captures: number;
  validation_resets: number;
  orphaned_units: number;
  source_unavailable_units: number;
  protected_active_units: number;
  scan_errors: number;
  available_pipelines: string[];
  by_pipeline: PipelineReportUsage[];
}

export interface ReportCleanupFailure {
  pipeline: string;
  capture_id: string;
  message: string;
}

export interface ReportCleanupResult {
  deleted_bytes: number;
  deleted_files: number;
  deleted_units: number;
  protected_active_units: number;
  failed_units: ReportCleanupFailure[];
  remaining_report_bytes: number;
}

export function previewReportCleanup(
  criteria: ReportCleanupCriteria,
): Promise<ReportStoragePreview> {
  return apiPost('/report-storage/preview', criteria);
}

export function cleanupReports(
  criteria: ReportCleanupCriteria,
): Promise<ReportCleanupResult> {
  return apiPost('/report-storage/cleanup', criteria);
}
