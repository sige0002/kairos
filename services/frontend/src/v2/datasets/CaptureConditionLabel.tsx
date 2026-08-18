// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collection-time condition shown beside a capture in Datasets.

import type { CaptureListItem } from '../../api/types';
import type { DatasetsState } from './useDatasetsState';

export function CaptureConditionLabel({
  capture,
  state,
  testId,
}: {
  capture: CaptureListItem;
  state: DatasetsState;
  testId: string;
}) {
  const condition = state.conditionForCapture(capture);
  const value =
    condition.status === 'ready'
      ? condition.value
      : condition.status === 'loading'
        ? 'loading…'
        : condition.status === 'unavailable'
          ? 'unavailable'
          : 'not recorded';
  const title =
    condition.status === 'unavailable'
      ? 'This legacy recording’s condition could not be loaded from its Batch. Reload this screen to retry.'
      : condition.status === 'not-recorded'
        ? 'No condition was recorded when this recording started.'
        : condition.status === 'ready'
          ? condition.value
          : undefined;

  return (
    <span
      data-testid={testId}
      title={title}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-chip border border-gray-200 bg-gray-50 px-2 py-[2px] text-[10.5px] text-gray-600"
    >
      <span className="shrink-0 font-semibold">Condition:</span>{' '}
      <span className="truncate">{value}</span>
    </span>
  );
}
