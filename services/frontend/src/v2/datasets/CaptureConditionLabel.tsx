// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collection-time condition shown beside a capture in Datasets.

import type { CaptureListItem } from '../../api/types';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('datasets');
  const condition = state.conditionForCapture(capture);
  const value =
    condition.status === 'ready'
      ? condition.value
      : condition.status === 'loading'
        ? t('loadingCondition')
        : condition.status === 'unavailable'
          ? t('unavailableCondition')
          : t('conditionNotRecorded');
  const title =
    condition.status === 'unavailable'
      ? t('conditionUnavailableHint')
      : condition.status === 'not-recorded'
        ? t('conditionMissingHint')
        : condition.status === 'ready'
          ? condition.value
          : undefined;

  return (
    <span
      data-testid={testId}
      title={title}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-chip border border-border bg-surface-muted px-2 py-[2px] text-[10.5px] text-text-secondary"
    >
      <span className="shrink-0 font-semibold">{t('conditionLabel')}</span>{' '}
      <span className="truncate">{value}</span>
    </span>
  );
}
