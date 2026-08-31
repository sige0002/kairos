// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor > Store — what the catalog knows about ITSELF (contract §8 / §9-3).
//
// This panel exists because the store's two worst conditions are invisible in an
// ordinary capture list:
//
//   * a rebuild that could not read some sidecars. §8 rule 4 forbids inventing a
//     row for them, so those captures appear NOWHERE else in the UI — this list
//     is the only place their path and reason can be seen.
//   * a reconciler pass that refused to apply itself because too many copies
//     vanished at once (§9-3). The catalog then looks perfectly normal while the
//     disk is not, so SUSPECT has to be stated loudly and say exactly what it
//     stopped and what it did not.
//
// Nothing here is derived or softened: every figure is the server's own, an
// unreported field reads as "—", and the absence of findings is only called
// clean when something actually looked.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../i18n/format';
import { repairStore } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import type { CorruptEntry } from '../../api/types';
import { Badge, Button, Card, CardHeader } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { readCaptureError } from '../captures/errors';
import { useStoreHealth } from '../store/useStoreHealth';
import { useTranslation } from 'react-i18next';

function formatInstant(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}

/** Render one value of a server-supplied summary dict without assuming its
 *  shape: these summaries are `Record<string, unknown>` on purpose, and guessing
 *  their keys is how a UI starts showing fields the backend stopped sending. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-2 px-[18px] py-4" data-testid={testId}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Key/value rows straight from a server summary dict (keys shown verbatim). */
function SummaryRows({ summary }: { summary: Record<string, unknown> }) {
  const { t } = useTranslation('monitor');
  const entries = Object.entries(summary);
  if (entries.length === 0) {
    return <p className="text-[12.5px] text-text-muted">{t('store.summaryEmpty')}</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-3 text-[12.5px]">
          <span className="font-mono text-text-muted">{key}</span>
          <div className="flex-1 border-b border-dotted border-border" />
          <span
            className="max-w-[60%] truncate text-right font-mono font-semibold text-text-primary"
            title={formatValue(value)}
          >
            {formatValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CorruptList({ entries }: { entries: CorruptEntry[] }) {
  const { t } = useTranslation('monitor');
  return (
    <ul className="flex flex-col gap-1.5" data-testid="store-health-corrupt-list">
      {entries.map((entry, i) => (
        <li
          key={`${entry.path}:${i}`}
          data-testid="store-health-corrupt-row"
          className="flex flex-col gap-0.5 rounded-control border border-status-danger-border bg-status-danger-bg px-3 py-2"
        >
          <span className="break-all font-mono text-[12px] font-semibold text-status-danger-text">
            {entry.path}
          </span>
          <span className="text-[12px] text-status-danger-text">{entry.reason}</span>
          {entry.capture_id && (
            <span className="font-mono text-[11px] text-status-danger-text">
              {t('store.capture', { id: entry.capture_id })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StoreHealthCard() {
  const { t } = useTranslation('monitor');
  const queryClient = useQueryClient();
  const healthQuery = useStoreHealth();

  const repair = useMutation({
    mutationFn: repairStore,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storeHealth });
      // A repair runs a reconciler pass with the operator's approval, so the
      // missing-transitions it had been withholding land now — the capture list
      // is stale the moment this returns.
      queryClient.invalidateQueries({ queryKey: queryKeys.captures });
    },
  });

  const health = healthQuery.data;
  const state =
    health?.state === 'suspect' || health?.state === 'ok' ? health.state : null;
  const suspect = state === 'suspect';
  const corrupt = health?.corrupt ?? [];
  const warnings = health?.warnings ?? [];
  // Which pass produced the corrupt list, and when it looked. A scan is a scan
  // whoever ran it: the reconciler now reports the same complete observation the
  // rebuild does, so treating a rebuild as the only real scan would report a
  // fresh reconciler all-clear as "nothing has been read".
  const corruptSource = health?.corrupt_source ?? null;
  const corruptObservedAt = health?.corrupt_observed_at ?? null;
  const scanned =
    corruptSource !== null || !!health?.rebuild_summary || !!health?.rebuilt_at;
  const scanLabel = corruptSource === 'reconcile' ? 'reconciler pass' : 'rebuild';

  // The 409 the contract singles out (§9-3): an approval given while the volume
  // cannot be identified is refused, and the operator has to fix the mount
  // first. It stays on screen — and keeps Repair disabled — until they act on
  // it and re-read the store's condition.
  const repairError = repair.error ? readCaptureError(repair.error) : null;
  const volumeUnidentified = repairError?.code === 'volume_unidentified';

  const refresh = () => {
    repair.reset();
    void healthQuery.refetch();
  };

  return (
    <Card className="flex min-w-0 flex-col" data-testid="store-health-panel">
      <CardHeader
        title={
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              {t('store.title')}
            </h2>
            {state === 'ok' && (
              <Badge tone="green" dot data-testid="store-health-state">
                {t('store.ok')}
              </Badge>
            )}
            {state === 'suspect' && (
              <Badge tone="red" dot data-testid="store-health-state">
                {t('store.suspect')}
              </Badge>
            )}
            {state === null && (
              <Badge tone="gray" data-testid="store-health-state">
                {t('store.notReported')}
              </Badge>
            )}
            {health?.instance_id && (
              <span className="font-mono text-[11.5px] text-text-muted">
                {health.instance_id}
              </span>
            )}
          </div>
        }
        right={
          <Button
            variant="ghost"
            className="px-3 py-1 text-[12.5px]"
            data-testid="store-health-refresh"
            onClick={refresh}
            disabled={healthQuery.isFetching}
          >
            {healthQuery.isFetching ? t('store.reading') : t('store.refresh')}
          </Button>
        }
      />

      {healthQuery.isError ? (
        <div className="flex flex-col gap-2 px-[18px] py-4">
          <ErrorMessage error={healthQuery.error} />
          <p className="text-[12.5px] text-text-muted">{t('store.unreadable')}</p>
        </div>
      ) : !health ? (
        <p className="px-[18px] py-6 text-[12.5px] text-text-muted">
          {t('store.loading')}
        </p>
      ) : (
        <>
          {/* ---- SUSPECT (§9-3) ---- */}
          {suspect && (
            <div
              className="mx-[18px] mt-4 flex flex-col gap-2 rounded-control border border-status-danger-border bg-status-danger-bg px-3.5 py-3"
              data-testid="store-health-suspect"
            >
              <span className="text-[13px] font-bold uppercase tracking-[0.04em] text-status-danger-text">
                {t('store.suspectTitle')}
              </span>
              <p className="text-[12.5px] font-semibold text-status-danger-text">
                {health.suspect_reason ?? t('store.noReason')}
              </p>
              <p className="text-[11.5px] text-status-danger-text">
                {t('store.latched', { time: formatInstant(health.suspect_at) })}
              </p>
              <p className="text-[12.5px] leading-relaxed text-status-danger-text">
                {t('store.suspectWhy')}
              </p>
              <p className="text-[12.5px] leading-relaxed text-status-danger-text">
                {t('store.suspectRecording')}
              </p>
            </div>
          )}

          <div className="flex flex-col divide-y divide-border">
            {/* ---- Repair (§9-3) ---- */}
            <Section title={t('store.repair')} testId="store-health-repair-section">
              <p className="text-[12.5px] leading-relaxed text-text-secondary">
                {t('store.repairHelp')}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="store-health-repair"
                  onClick={() => repair.mutate()}
                  disabled={!suspect || volumeUnidentified || repair.isPending}
                >
                  {repair.isPending ? t('store.repairing') : t('store.repairStore')}
                </Button>
                {!suspect && (
                  <span
                    className="text-[12px] text-text-muted"
                    data-testid="store-health-repair-idle"
                  >
                    {t('store.repairIdle')}
                  </span>
                )}
              </div>

              {repairError && (
                <div
                  data-testid="store-health-repair-error"
                  data-error-code={repairError.code}
                  className="rounded-control border border-status-danger-border bg-status-danger-bg px-3 py-2 text-[12.5px] text-status-danger-text"
                >
                  <p className="font-semibold">{repairError.message}</p>
                  {repairError.guidance && (
                    <p className="mt-1">{repairError.guidance}</p>
                  )}
                  {volumeUnidentified && (
                    <p className="mt-1">{t('store.repairVolume')}</p>
                  )}
                </div>
              )}

              {repair.isSuccess && repair.data && (
                <div
                  data-testid="store-health-repair-result"
                  className="flex flex-col gap-1.5 rounded-control border border-status-success-border bg-status-success-bg px-3 py-2 text-[12.5px] text-status-success-text"
                >
                  <span className="font-semibold">
                    {repair.data.repaired
                      ? t('store.repairApplied')
                      : t('store.repairMissing')}
                  </span>
                  {repair.data.reconcile && (
                    <SummaryRows summary={repair.data.reconcile} />
                  )}
                </div>
              )}
            </Section>

            {/* ---- Corrupt sidecars (§8 rule 4) ---- */}
            <Section
              title={t('store.corrupt', { count: corrupt.length })}
              testId="store-health-corrupt"
            >
              <p className="text-[12.5px] leading-relaxed text-text-secondary">
                {t('store.corruptHelp')}
              </p>
              {corrupt.length > 0 ? (
                <>
                  <CorruptList entries={corrupt} />
                  <p
                    className="text-[11.5px] text-text-muted"
                    data-testid="store-health-corrupt-observed"
                  >
                    {t('store.observed', {
                      source: scanLabel,
                      time: corruptObservedAt
                        ? ` at ${formatInstant(corruptObservedAt)}`
                        : '',
                    })}
                  </p>
                </>
              ) : !scanned ? (
                <p
                  className="text-[12.5px] text-status-warning-text"
                  data-testid="store-health-corrupt-empty"
                >
                  {t('store.noScan')}
                </p>
              ) : (
                <p
                  className="text-[12.5px] text-text-muted"
                  data-testid="store-health-corrupt-empty"
                >
                  {t('store.cleanScan', {
                    source: scanLabel,
                    time: corruptObservedAt
                      ? `, at ${formatInstant(corruptObservedAt)}`
                      : '',
                  })}
                </p>
              )}
            </Section>

            {/* ---- Deletion availability (§2) ---- */}
            <Section title={t('store.deletion')} testId="store-health-delete">
              {health.delete_available === false ? (
                <>
                  <Badge tone="amber">{t('store.deletionOff')}</Badge>
                  <p className="text-[12.5px] leading-relaxed text-text-primary">
                    {t('store.deletionOffHelp')}
                  </p>
                  {health.delete_unavailable_reason && (
                    <p className="font-mono text-[11.5px] text-text-muted">
                      {health.delete_unavailable_reason}
                    </p>
                  )}
                </>
              ) : health.delete_available === true ? (
                <p className="text-[12.5px] text-text-secondary">
                  {t('store.deletionOn')}
                </p>
              ) : (
                <p className="text-[12.5px] text-text-muted">
                  {t('store.deletionUnknown')}
                </p>
              )}
            </Section>

            {/* ---- Rebuild (§8) ---- */}
            <Section title={t('store.rebuild')} testId="store-health-rebuild">
              <div className="flex items-baseline gap-3 text-[12.5px]">
                <span className="text-text-muted">{t('store.rebuiltAt')}</span>
                <div className="flex-1" />
                <span className="font-mono font-semibold text-text-primary">
                  {formatInstant(health.rebuilt_at)}
                </span>
              </div>
              {health.rebuild_summary ? (
                <SummaryRows summary={health.rebuild_summary} />
              ) : (
                <p className="text-[12.5px] text-text-muted">{t('store.noRebuild')}</p>
              )}
              {warnings.length > 0 ? (
                <ul
                  className="flex flex-col gap-1 rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12px] text-status-warning-text"
                  data-testid="store-health-warnings"
                >
                  {warnings.map((w, i) => (
                    <li key={`${w}:${i}`}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p
                  className="text-[12px] text-text-muted"
                  data-testid="store-health-warnings-empty"
                >
                  {t('store.noWarnings')}
                </p>
              )}
            </Section>

            {/* ---- Last reconciler pass (§9-3 evidence) ---- */}
            <Section title={t('store.reconciler')} testId="store-health-reconcile">
              <div className="flex items-baseline gap-3 text-[12.5px]">
                <span className="text-text-muted">{t('store.ranAt')}</span>
                <div className="flex-1" />
                <span className="font-mono font-semibold text-text-primary">
                  {formatInstant(health.last_reconcile_at)}
                </span>
              </div>
              {health.last_reconcile ? (
                <SummaryRows summary={health.last_reconcile} />
              ) : (
                <p className="text-[12.5px] text-text-muted">
                  {t('store.noReconcile')}
                </p>
              )}
            </Section>
          </div>
        </>
      )}
    </Card>
  );
}
