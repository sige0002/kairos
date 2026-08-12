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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStoreHealth, repairStore } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import type { CorruptEntry, StoreHealth } from '../../api/types';
import { Badge, Button, Card, CardHeader } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { readCaptureError } from '../captures/errors';
import { STORE_HEALTH_POLL_MS } from '../pollingPolicy';

function formatInstant(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { hour12: false });
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
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Key/value rows straight from a server summary dict (keys shown verbatim). */
function SummaryRows({ summary }: { summary: Record<string, unknown> }) {
  const entries = Object.entries(summary);
  if (entries.length === 0) {
    return <p className="text-[12.5px] text-gray-500">The summary is empty.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-3 text-[12.5px]">
          <span className="font-mono text-gray-500">{key}</span>
          <div className="flex-1 border-b border-dotted border-gray-200" />
          <span className="max-w-[60%] truncate text-right font-mono font-semibold text-gray-800" title={formatValue(value)}>
            {formatValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CorruptList({ entries }: { entries: CorruptEntry[] }) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="store-health-corrupt-list">
      {entries.map((entry, i) => (
        <li
          key={`${entry.path}:${i}`}
          data-testid="store-health-corrupt-row"
          className="flex flex-col gap-0.5 rounded-control border border-red-200 bg-red-50 px-3 py-2"
        >
          <span className="break-all font-mono text-[12px] font-semibold text-red-800">
            {entry.path}
          </span>
          <span className="text-[12px] text-red-700">{entry.reason}</span>
          {entry.capture_id && (
            <span className="font-mono text-[11px] text-red-700">
              capture {entry.capture_id}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StoreHealthCard() {
  const queryClient = useQueryClient();
  const healthQuery = useQuery<StoreHealth>({
    queryKey: queryKeys.storeHealth,
    queryFn: ({ signal }) => getStoreHealth(signal),
    refetchInterval: STORE_HEALTH_POLL_MS,
  });

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
  const state = health?.state === 'suspect' || health?.state === 'ok' ? health.state : null;
  const suspect = state === 'suspect';
  const corrupt = health?.corrupt ?? [];
  const warnings = health?.warnings ?? [];
  // Which pass produced the corrupt list, and when it looked. A scan is a scan
  // whoever ran it: the reconciler now reports the same complete observation the
  // rebuild does, so treating a rebuild as the only real scan would report a
  // fresh reconciler all-clear as "nothing has been read".
  const corruptSource = health?.corrupt_source ?? null;
  const corruptObservedAt = health?.corrupt_observed_at ?? null;
  const scanned = corruptSource !== null || !!health?.rebuild_summary || !!health?.rebuilt_at;
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
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
              Store health
            </h2>
            {state === 'ok' && (
              <Badge tone="green" dot data-testid="store-health-state">
                ok
              </Badge>
            )}
            {state === 'suspect' && (
              <Badge tone="red" dot data-testid="store-health-state">
                suspect
              </Badge>
            )}
            {state === null && (
              <Badge tone="gray" data-testid="store-health-state">
                not reported
              </Badge>
            )}
            {health?.instance_id && (
              <span className="font-mono text-[11.5px] text-gray-500">{health.instance_id}</span>
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
            {healthQuery.isFetching ? 'Reading…' : 'Refresh'}
          </Button>
        }
      />

      {healthQuery.isError ? (
        <div className="flex flex-col gap-2 px-[18px] py-4">
          <ErrorMessage error={healthQuery.error} />
          <p className="text-[12.5px] text-gray-500">
            The store&apos;s condition could not be read, so nothing below is known — this is not
            an all-clear.
          </p>
        </div>
      ) : !health ? (
        <p className="px-[18px] py-6 text-[12.5px] text-gray-500">Reading store health…</p>
      ) : (
        <>
          {/* ---- SUSPECT (§9-3) ---- */}
          {suspect && (
            <div
              className="mx-[18px] mt-4 flex flex-col gap-2 rounded-control border border-red-200 bg-red-50 px-3.5 py-3"
              data-testid="store-health-suspect"
            >
              <span className="text-[13px] font-bold uppercase tracking-[0.04em] text-red-800">
                Suspect — automatic clean-up is halted
              </span>
              <p className="text-[12.5px] font-semibold text-red-800">
                {health.suspect_reason ?? 'No reason was reported.'}
              </p>
              <p className="text-[11.5px] text-red-700">
                Latched {formatInstant(health.suspect_at)}. It does not re-fire: only a repair
                clears it.
              </p>
              <p className="text-[12.5px] leading-relaxed text-red-700">
                More local copies vanished in one reconciler pass than the store is willing to
                believe, which is what an unmounted volume looks like from the inside. Until an
                operator confirms the storage, the store has STOPPED applying automatic
                missing-transitions, STOPPED the reaper, and STOPPED digests on this storage.
              </p>
              <p className="text-[12.5px] leading-relaxed text-red-700">
                It has NOT stopped recording: start and stop still work, review saves still write,
                and browsing the catalog is unaffected.
              </p>
            </div>
          )}

          <div className="flex flex-col divide-y divide-gray-100">
            {/* ---- Repair (§9-3) ---- */}
            <Section title="Repair" testId="store-health-repair-section">
              <p className="text-[12.5px] leading-relaxed text-gray-600">
                Repair is the operator&apos;s acknowledgement that the storage really is as it
                appears. It clears SUSPECT and re-runs the withheld reconciler pass, so the captures
                whose files are gone are marked missing.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="store-health-repair"
                  onClick={() => repair.mutate()}
                  disabled={!suspect || volumeUnidentified || repair.isPending}
                >
                  {repair.isPending ? 'Repairing…' : 'Repair store'}
                </Button>
                {!suspect && (
                  <span className="text-[12px] text-gray-500" data-testid="store-health-repair-idle">
                    The store is not in SUSPECT — there is nothing to acknowledge.
                  </span>
                )}
              </div>

              {repairError && (
                <div
                  data-testid="store-health-repair-error"
                  data-error-code={repairError.code}
                  className="rounded-control border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"
                >
                  <p className="font-semibold">{repairError.message}</p>
                  {repairError.guidance && <p className="mt-1">{repairError.guidance}</p>}
                  {volumeUnidentified && (
                    <p className="mt-1">
                      Repair stays disabled until the storage is checked again — an approval that
                      cannot name the volume it is approving is not an approval.
                    </p>
                  )}
                </div>
              )}

              {repair.isSuccess && repair.data && (
                <div
                  data-testid="store-health-repair-result"
                  className="flex flex-col gap-1.5 rounded-control border border-green-200 bg-green-50 px-3 py-2 text-[12.5px] text-green-800"
                >
                  <span className="font-semibold">
                    {repair.data.repaired
                      ? 'Repair applied — SUSPECT cleared and the pass re-ran.'
                      : 'The server did not report a repair.'}
                  </span>
                  {repair.data.reconcile && <SummaryRows summary={repair.data.reconcile} />}
                </div>
              )}
            </Section>

            {/* ---- Corrupt sidecars (§8 rule 4) ---- */}
            <Section title={`Corrupt sidecars (${corrupt.length})`} testId="store-health-corrupt">
              <p className="text-[12.5px] leading-relaxed text-gray-600">
                A sidecar that exists but cannot be read. These captures have no row in the capture
                list — reporting them as absent would lose the only clue — so this is the only place
                they appear.
              </p>
              {corrupt.length > 0 ? (
                <>
                  <CorruptList entries={corrupt} />
                  <p
                    className="text-[11.5px] text-gray-500"
                    data-testid="store-health-corrupt-observed"
                  >
                    Observed by the {scanLabel}
                    {corruptObservedAt ? ` at ${formatInstant(corruptObservedAt)}` : ''}.
                  </p>
                </>
              ) : !scanned ? (
                <p className="text-[12.5px] text-amber-700" data-testid="store-health-corrupt-empty">
                  No scan has completed in this process, so no sidecar has been read. That is not an
                  all-clear.
                </p>
              ) : (
                <p className="text-[12.5px] text-gray-500" data-testid="store-health-corrupt-empty">
                  The last {scanLabel} read every sidecar it found
                  {corruptObservedAt ? `, at ${formatInstant(corruptObservedAt)}` : ''}.
                </p>
              )}
            </Section>

            {/* ---- Deletion availability (§2) ---- */}
            <Section title="Deletion" testId="store-health-delete">
              {health.delete_available === false ? (
                <>
                  <Badge tone="amber">deletion switched off</Badge>
                  <p className="text-[12.5px] leading-relaxed text-gray-700">
                    <code>objects/</code>, <code>.trash/</code> and <code>.incoming/</code> are not on
                    one filesystem, so moving a capture to the trash would be a cross-device copy
                    instead of a rename. That is why the delete APIs are withheld rather than
                    silently degraded: an EXDEV copy is not the atomic move the design depends on,
                    and a half-copied delete is exactly the outcome the trash step exists to prevent.
                    Put the three directories on one filesystem and restart the orchestrator.
                  </p>
                  {health.delete_unavailable_reason && (
                    <p className="font-mono text-[11.5px] text-gray-500">
                      {health.delete_unavailable_reason}
                    </p>
                  )}
                </>
              ) : health.delete_available === true ? (
                <p className="text-[12.5px] text-gray-600">
                  Available — the three directories share one filesystem, so a delete is an atomic
                  rename into <code>.trash/</code>.
                </p>
              ) : (
                <p className="text-[12.5px] text-gray-500">Delete availability was not reported.</p>
              )}
            </Section>

            {/* ---- Rebuild (§8) ---- */}
            <Section title="Last rebuild" testId="store-health-rebuild">
              <div className="flex items-baseline gap-3 text-[12.5px]">
                <span className="text-gray-500">Rebuilt at</span>
                <div className="flex-1" />
                <span className="font-mono font-semibold text-gray-800">
                  {formatInstant(health.rebuilt_at)}
                </span>
              </div>
              {health.rebuild_summary ? (
                <SummaryRows summary={health.rebuild_summary} />
              ) : (
                <p className="text-[12.5px] text-gray-500">
                  No rebuild has run in this process — the catalog was read from the database as it
                  stood.
                </p>
              )}
              {warnings.length > 0 ? (
                <ul
                  className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
                  data-testid="store-health-warnings"
                >
                  {warnings.map((w, i) => (
                    <li key={`${w}:${i}`}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-gray-500" data-testid="store-health-warnings-empty">
                  No warnings were reported.
                </p>
              )}
            </Section>

            {/* ---- Last reconciler pass (§9-3 evidence) ---- */}
            <Section title="Last reconciler pass" testId="store-health-reconcile">
              <div className="flex items-baseline gap-3 text-[12.5px]">
                <span className="text-gray-500">Ran at</span>
                <div className="flex-1" />
                <span className="font-mono font-semibold text-gray-800">
                  {formatInstant(health.last_reconcile_at)}
                </span>
              </div>
              {health.last_reconcile ? (
                <SummaryRows summary={health.last_reconcile} />
              ) : (
                <p className="text-[12.5px] text-gray-500">
                  No pass has completed in this process yet.
                </p>
              )}
            </Section>
          </div>
        </>
      )}
    </Card>
  );
}
