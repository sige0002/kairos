// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Non-blocking global notice for conditions invisible in a capture list.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useUiStore } from '../../store/uiStore';
import { cn } from '../../components/ui';
import { useStoreHealth } from './useStoreHealth';
import type { StoreHealth } from '../../api/types';
import { formatDateTime } from '../../i18n/format';

function observedBy(
  t: TFunction<'common'>,
  health: {
    corrupt_source?: 'rebuild' | 'reconcile' | null;
    corrupt_observed_at?: string | null;
  },
): string {
  const source = t(
    health.corrupt_source === 'reconcile'
      ? 'storeHealthBanner.sourceReconciler'
      : 'storeHealthBanner.sourceRebuild',
  );
  if (!health.corrupt_observed_at) return source;
  const date = new Date(health.corrupt_observed_at);
  const time = Number.isNaN(date.getTime())
    ? health.corrupt_observed_at
    : formatDateTime(date);
  return t('storeHealthBanner.observedAt', { source, time });
}

function errorMessage(t: TFunction<'common'>, error: unknown): string {
  return error instanceof Error ? error.message : t('storeHealthBanner.requestFailed');
}

function informationalNoticeKey(health: StoreHealth): string | null {
  if (health.state !== 'ok') return null;
  if (health.corrupt.length !== 0) return null;
  if (health.delete_available !== true) return null;
  if (health.warnings.length === 0) return null;
  if (
    health.dismissible_warnings?.length !== health.warnings.length ||
    health.warnings.some(
      (warning, index) => health.dismissible_warnings?.[index] !== warning,
    )
  ) {
    return null;
  }

  const rebuiltAt = health.rebuilt_at?.trim();
  if (!rebuiltAt) return null;

  return `kairos.store-health.notice.v1:${JSON.stringify([
    health.instance_id,
    rebuiltAt,
    health.warnings,
  ])}`;
}

function safeIsAcknowledged(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function safeSetAcknowledged(key: string): boolean {
  try {
    window.localStorage.setItem(key, '1');
    return true;
  } catch {
    // Ignore storage errors; banner remains visible.
    return false;
  }
}

/**
 * A compact status strip for every main and solo screen. It intentionally has
 * no Repair action: repair is an acknowledgement with storage consequences and
 * belongs in Monitor > Store, where its explanation and refusal state remain
 * visible. Nothing here blocks the operator's current task.
 */
export function StoreHealthBanner({ solo = false }: { solo?: boolean }) {
  const { t } = useTranslation('common');
  const query = useStoreHealth();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const health = query.data;

  const openMonitor = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'monitor');
    params.set('view', 'store');
    if (solo) {
      params.set('solo', '1');
    } else params.delete('solo');
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
    setActiveTab('monitor');
  };

  if (query.isPending && !health) {
    return (
      <div
        data-testid="store-health-banner"
        data-state="loading"
        className="my-2.5 flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-[12px] text-text-secondary"
      >
        <span className="animate-pulse" aria-hidden="true">
          ●
        </span>
        {t('storeHealthBanner.loading')}
      </div>
    );
  }

  if (
    query.isError ||
    !health ||
    (health.state !== 'ok' && health.state !== 'suspect')
  ) {
    return (
      <div
        role="status"
        data-testid="store-health-banner"
        data-state="unavailable"
        className="my-2.5 flex flex-wrap items-center gap-2 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] text-status-warning-text"
      >
        <span className="font-semibold">{t('storeHealthBanner.unavailableTitle')}</span>
        <span>{t('storeHealthBanner.unavailableHelp')}</span>
        {query.isError && (
          <span className="text-status-warning-text">
            {errorMessage(t, query.error)}
          </span>
        )}
        <button
          type="button"
          data-testid="store-health-banner-retry"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="ml-auto font-semibold underline underline-offset-2 disabled:no-underline"
        >
          {query.isFetching
            ? t('storeHealthBanner.retrying')
            : t('storeHealthBanner.retry')}
        </button>
      </div>
    );
  }

  const corruptCount = health.corrupt.length;
  const hasWarnings = health.warnings.length > 0;
  const deleteUnavailable = health.delete_available !== true;

  if (
    health.state === 'ok' &&
    corruptCount === 0 &&
    !hasWarnings &&
    !deleteUnavailable
  ) {
    return null;
  }

  const noticeKey = informationalNoticeKey(health);

  if (noticeKey) {
    if (dismissedKey === noticeKey || safeIsAcknowledged(noticeKey)) {
      return null;
    }
  }

  const suspect = health.state === 'suspect';
  return (
    <div
      role="status"
      data-testid="store-health-banner"
      data-state={suspect ? 'suspect' : 'warning'}
      className={cn(
        'my-2.5 flex flex-wrap items-center gap-2 rounded-control border px-3 py-2 text-[12px]',
        suspect
          ? 'border-status-danger-border bg-status-danger-bg text-status-danger-text'
          : 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
      )}
    >
      {suspect && (
        <>
          <span className="font-semibold">{t('storeHealthBanner.suspectTitle')}</span>
          <span>{health.suspect_reason ?? t('storeHealthBanner.noReason')}</span>
        </>
      )}
      {corruptCount > 0 && (
        <span>
          {t('storeHealthBanner.corruptFound', {
            count: corruptCount,
            observation: observedBy(t, health),
          })}
        </span>
      )}
      {hasWarnings && <span>{health.warnings.join(' ')}</span>}
      {deleteUnavailable && (
        <span>
          {t('storeHealthBanner.deleteUnavailable', {
            reason: health.delete_unavailable_reason ?? t('storeHealthBanner.noReason'),
          })}
        </span>
      )}
      <button
        type="button"
        data-testid="store-health-banner-monitor"
        onClick={openMonitor}
        className="ml-auto font-semibold underline underline-offset-2"
      >
        {t('storeHealthBanner.openMonitor')}
      </button>
      {noticeKey && (
        <button
          type="button"
          data-testid="store-health-banner-dismiss"
          onClick={() => {
            if (safeSetAcknowledged(noticeKey)) {
              setDismissedKey(noticeKey);
            }
          }}
          className="font-semibold underline underline-offset-2"
        >
          {t('storeHealthBanner.dismiss')}
        </button>
      )}
    </div>
  );
}
