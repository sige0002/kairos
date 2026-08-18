// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Resolves the condition recorded with a capture.
//
// A collection_context is immutable evidence from the instant recording began.
// Older captures have no such context, so only those legacy rows may fall back
// to the current Batch label.

import type { CaptureListItem } from '../../api/types';

export type CaptureConditionView =
  | { status: 'ready'; value: string }
  | { status: 'loading' | 'unavailable' | 'not-recorded'; value: null };

export type LegacyConditionLookup =
  | { status: 'ready'; value: string | null | undefined }
  | { status: 'loading' | 'unavailable' };

function recordedValue(value: string | null | undefined): CaptureConditionView {
  const trimmed = value?.trim();
  return trimmed
    ? { status: 'ready', value: trimmed }
    : { status: 'not-recorded', value: null };
}

/** Whether this capture has an immutable collection-time context. `undefined`
 * and `null` are both the legacy API/sidecar shape, not an explicit empty
 * snapshot. */
export function hasCollectionContext(capture: CaptureListItem): boolean {
  return capture.collection_context != null;
}

/** Resolve a capture's recorded condition without ever allowing a current
 * Batch relabel to overwrite immutable capture history. */
export function resolveCaptureCondition(
  capture: CaptureListItem,
  legacy: LegacyConditionLookup,
): CaptureConditionView {
  if (hasCollectionContext(capture)) {
    return recordedValue(capture.collection_context?.condition);
  }
  if (legacy.status !== 'ready') return { status: legacy.status, value: null };
  return recordedValue(legacy.value);
}
