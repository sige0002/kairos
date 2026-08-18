// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Non-blocking global notice for conditions invisible in a capture list.

import { useUiStore } from '../../store/uiStore';
import { cn } from '../../components/ui';
import { useStoreHealth } from './useStoreHealth';

function observedBy(health: {
  corrupt_source?: 'rebuild' | 'reconcile' | null;
  corrupt_observed_at?: string | null;
}): string {
  const source = health.corrupt_source === 'reconcile' ? 'reconciler pass' : 'rebuild';
  if (!health.corrupt_observed_at) return source;
  const date = new Date(health.corrupt_observed_at);
  return Number.isNaN(date.getTime())
    ? `${source} at ${health.corrupt_observed_at}`
    : `${source} at ${date.toLocaleString('en-GB', { hour12: false })}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

/**
 * A compact status strip for every main and solo screen. It intentionally has
 * no Repair action: repair is an acknowledgement with storage consequences and
 * belongs in Monitor > Store, where its explanation and refusal state remain
 * visible. Nothing here blocks the operator's current task.
 */
export function StoreHealthBanner({ solo = false }: { solo?: boolean }) {
  const query = useStoreHealth();
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
        className="my-2.5 flex items-center gap-2 rounded-control border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600"
      >
        <span className="animate-pulse" aria-hidden="true">●</span>
        Checking store health…
      </div>
    );
  }

  if (query.isError || !health || (health.state !== 'ok' && health.state !== 'suspect')) {
    return (
      <div
        role="status"
        data-testid="store-health-banner"
        data-state="unavailable"
        className="my-2.5 flex flex-wrap items-center gap-2 rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
      >
        <span className="font-semibold">Store status unavailable.</span>
        <span>Nothing is known; this is not an all-clear.</span>
        {query.isError && <span className="text-amber-800">{errorMessage(query.error)}</span>}
        <button
          type="button"
          data-testid="store-health-banner-retry"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="ml-auto font-semibold underline underline-offset-2 disabled:no-underline"
        >
          {query.isFetching ? 'Checking…' : 'Retry'}
        </button>
      </div>
    );
  }

  const corruptCount = health.corrupt.length;
  const hasWarnings = health.warnings.length > 0;
  if (health.state === 'ok' && corruptCount === 0 && !hasWarnings) return null;

  const suspect = health.state === 'suspect';
  return (
    <div
      role="status"
      data-testid="store-health-banner"
      data-state={suspect ? 'suspect' : 'warning'}
      className={cn(
        'my-2.5 flex flex-wrap items-center gap-2 rounded-control border px-3 py-2 text-[12px]',
        suspect
          ? 'border-red-300 bg-red-50 text-red-900'
          : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      {suspect && (
        <>
          <span className="font-semibold">Suspect — automatic cleanup is halted.</span>
          <span>{health.suspect_reason ?? 'No reason was reported.'}</span>
        </>
      )}
      {corruptCount > 0 && (
        <span>
          {corruptCount} corrupt sidecar{corruptCount === 1 ? '' : 's'} found by{' '}
          {observedBy(health)}; affected recordings may not appear in lists.
        </span>
      )}
      {hasWarnings && <span>{health.warnings.join(' ')}</span>}
      <button
        type="button"
        data-testid="store-health-banner-monitor"
        onClick={openMonitor}
        className="ml-auto font-semibold underline underline-offset-2"
      >
        Open Monitor
      </button>
    </div>
  );
}
