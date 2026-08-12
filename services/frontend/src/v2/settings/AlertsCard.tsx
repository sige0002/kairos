// Settings > Data quality > Alerts — form-first editor for the ACTIVE robot's
// topic_monitor alert rules (GET/PUT /api/v1/config/alerts). Replaces the old
// "not exposed by the API" note with a real rules table (topic / metric / op /
// threshold / clear_after_s / cooldown_s / severity) plus an Advanced raw-YAML
// editor. topic_monitor loads alerts.yaml ONCE at startup (no live-reload path),
// so an edit applies on the next monitor restart — the badge says so. A
// `metric: loss` rule is accepted but flagged inline (loss_rate is null in the
// monitor, so it can never fire). The optional derived_rules block is shown
// read-only and preserved on save.
//
// TWO EDITORS, ONE FILE: the table and the raw-YAML textarea both write the
// same alerts.yaml, and each Save sends ONLY its own view. Left unguarded that
// silently destroyed work (observed 2026-08-04): raw-YAML edits + the main
// Save wrote the stale table state, showed "Saved", and kept the never-sent
// YAML on screen. So each side tracks its own unsaved-ness — the form Save is
// blocked while the YAML has unsaved edits (with the reason inline), Save YAML
// states that it discards unsaved table edits, and every successful save
// re-seeds BOTH views from the server response (never relying on the query
// cache noticing a change — a byte-identical response keeps its object
// identity and would skip the effect).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { getConfigOptions } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import { Badge, Button, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  alertsConfigKey,
  KNOWN_METRICS,
  KNOWN_OPS,
  formatValidationDetails,
  putAlertsConfig,
  type AlertsConfig,
  type AlertsPayload,
  type AspectPutBody,
} from './configAspects';

interface RuleForm {
  topic: string;
  metric: string;
  op: string;
  threshold: string;
  clearAfter: string;
  cooldown: string;
  severity: string;
}

function toRuleForms(cfg: AlertsConfig | null): RuleForm[] {
  return (cfg?.rules ?? []).map((r) => ({
    topic: r.topic ?? '',
    metric: r.metric ?? 'hz',
    op: r.op ?? 'lt',
    threshold: String(r.threshold ?? 0),
    clearAfter: String(r.clear_after_s ?? 0),
    cooldown: String(r.cooldown_s ?? 0),
    severity: r.severity ?? 'warning',
  }));
}

function toConfig(
  rules: RuleForm[],
  derived: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    rules: rules
      .filter((r) => r.topic.trim())
      .map((r) => ({
        topic: r.topic.trim(),
        metric: r.metric,
        op: r.op,
        threshold: Number.parseFloat(r.threshold) || 0,
        clear_after_s: Number.parseFloat(r.clearAfter) || 0,
        cooldown_s: Number.parseFloat(r.cooldown) || 0,
        severity: r.severity,
      })),
  };
  if (derived != null) out.derived_rules = derived;
  return out;
}

const CELL =
  'rounded-control border border-gray-200 px-1.5 py-1 text-[12px] focus:border-teal-600 focus:outline-none';

export function AlertsCard() {
  const queryClient = useQueryClient();
  // alerts.yaml is the ACTIVE robot's file, so the cache entry is keyed by robot
  // (see alertsConfigKey). Until the active robot is known there is no rules
  // file to show — better a moment of "Loading" than another robot's rules.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const activeRobot = optionsQuery.data?.active_robot;
  const alertsKey = alertsConfigKey(activeRobot ?? '');
  const query = useQuery({
    queryKey: alertsKey,
    queryFn: ({ signal }) => apiGet<AlertsPayload>('/config/alerts', { signal }),
    enabled: !!activeRobot,
  });

  const [rules, setRules] = useState<RuleForm[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saved, setSaved] = useState(false);
  // What each editor was last seeded from — the reference "unsaved edits" is
  // measured against (see the header).
  const [seededRulesJson, setSeededRulesJson] = useState('[]');
  const [seededRaw, setSeededRaw] = useState('');

  const derived = query.data?.config?.derived_rules ?? null;

  // The payload both buffers currently hold. Compared by identity: react-query's
  // structural sharing keeps the same object for a deep-equal refetch, so an
  // unchanged file is indistinguishable from no refetch at all — which is what
  // makes identity the right test for "the file actually moved".
  const seededDataRef = useRef<AlertsPayload | null>(null);

  const seedFrom = useCallback((data: AlertsPayload) => {
    seededDataRef.current = data;
    const forms = toRuleForms(data.config);
    setRules(forms);
    setSeededRulesJson(JSON.stringify(forms));
    setRawText(data.raw ?? '');
    setSeededRaw(data.raw ?? '');
  }, []);

  // True while the next query-data change is our own save's response landing in
  // the cache — onSuccess has already seeded from it, and re-running the seed
  // here would also clear the Saved banner the moment it appeared.
  const justSavedRef = useRef(false);

  // A newer server payload withheld because the operator has unsaved edits.
  const [pendingServer, setPendingServer] = useState<AlertsPayload | null>(null);

  const formDirty = JSON.stringify(rules) !== seededRulesJson;
  const rawDirty = rawText !== seededRaw;
  // Read by the seeding effect, which must NOT re-run merely because dirtiness
  // flipped (typing one character would otherwise look like a server change).
  const dirtyRef = useRef(false);
  dirtyRef.current = formDirty || rawDirty;

  // A REFETCH is not a save. After a drop long enough to fall outside the SSE
  // ring buffer the server sends `resync` and the client refetches every query
  // (sse/useEventStream.ts), and RECORDING/robot switches invalidate config keys
  // too. Re-seeding unconditionally there threw away whatever the operator had
  // typed, silently — the justSavedRef guard below only ever covered our own
  // save. So: adopt a newer file only into a CLEAN buffer; when the buffer is
  // dirty, hold the payload and say so instead of overwriting their work.
  useEffect(() => {
    const data = query.data;
    if (!data) return;
    if (justSavedRef.current) {
      justSavedRef.current = false;
      return;
    }
    if (seededDataRef.current === data) return;
    if (dirtyRef.current) {
      setPendingServer(data);
      return;
    }
    seedFrom(data);
    setSaved(false);
  }, [query.data, seedFrom]);

  const mutation = useMutation({
    mutationFn: (body: AspectPutBody) => putAlertsConfig(body),
    onSuccess: (data) => {
      setSaved(true);
      justSavedRef.current = true;
      // Our own write settles any withheld server change: the file is now ours.
      setPendingServer(null);
      queryClient.setQueryData(alertsKey, data);
      // Re-seed BOTH views from what the server actually wrote — the effect
      // above cannot be relied on for this (a response deep-equal to the cache
      // keeps its identity and never fires it).
      seedFrom(data);
    },
  });

  const path = query.data?.path;
  const details = formatValidationDetails(mutation.error);
  // Prefer the freshest warnings: the last save response, else the loaded file.
  const warnings = mutation.data?.warnings ?? query.data?.warnings ?? [];

  const setRule = (i: number, patch: Partial<RuleForm>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const saveForm = () => {
    setSaved(false);
    mutation.mutate({ config: toConfig(rules, derived) });
  };
  const saveRaw = () => {
    setSaved(false);
    mutation.mutate({ raw: rawText });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-alerts">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Alert rules
        </h2>
        <Badge tone="amber" dot>
          applies on monitor restart
        </Badge>
      </div>

      {optionsQuery.isError ? (
        <ErrorMessage error={optionsQuery.error} />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending || !activeRobot ? (
        <p className="text-sm text-gray-500">Loading alert rules…</p>
      ) : (
        <>
          <p className="text-[11.5px] leading-relaxed text-gray-500">
            Explicit per-topic threshold rules (a rule fires when <code>metric op threshold</code>
            holds, with clear/cooldown hysteresis). Topics without an explicit rule are still
            covered on their Hz by the monitor&apos;s auto-derived rules and default incident
            synthesizer — these rules override that coverage for the topics they name.
          </p>

          <div className="overflow-x-auto rounded-control border border-gray-200" data-testid="alerts-rules">
            <table className="w-full min-w-[720px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                  <th className="px-2 py-1.5 text-left">Topic</th>
                  <th className="px-2 py-1.5 text-left">Metric</th>
                  <th className="px-2 py-1.5 text-left">Op</th>
                  <th className="px-2 py-1.5 text-left">Threshold</th>
                  <th className="px-2 py-1.5 text-left">clear_after_s</th>
                  <th className="px-2 py-1.5 text-left">cooldown_s</th>
                  <th className="px-2 py-1.5 text-left">Severity</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-2 py-3 text-center text-[12px] text-gray-500">
                      No explicit rules — derived coverage applies. Add a rule to override a topic.
                    </td>
                  </tr>
                ) : (
                  rules.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50 last:border-b-0 align-top">
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={`rule topic ${i}`}
                          className={cn(CELL, 'font-mono w-full min-w-[180px]')}
                          value={r.topic}
                          placeholder="/hsrb/joint_states"
                          onChange={(e) => setRule(i, { topic: e.target.value })}
                        />
                        {r.metric === 'loss' && (
                          <p
                            data-testid={`alerts-loss-warn-${i}`}
                            className="mt-1 text-[10.5px] text-amber-700"
                          >
                            metric “loss” can never fire (loss_rate is null) — use hz or gap.
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={`rule metric ${i}`}
                          className={cn(CELL, r.metric === 'loss' && 'border-amber-300 bg-amber-50')}
                          value={r.metric}
                          onChange={(e) => setRule(i, { metric: e.target.value })}
                        >
                          {KNOWN_METRICS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={`rule op ${i}`}
                          className={CELL}
                          value={r.op}
                          onChange={(e) => setRule(i, { op: e.target.value })}
                        >
                          {KNOWN_OPS.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={`rule threshold ${i}`}
                          type="number"
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.threshold}
                          onChange={(e) => setRule(i, { threshold: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={`rule clear_after_s ${i}`}
                          type="number"
                          min={0}
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.clearAfter}
                          onChange={(e) => setRule(i, { clearAfter: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={`rule cooldown_s ${i}`}
                          type="number"
                          min={0}
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.cooldown}
                          onChange={(e) => setRule(i, { cooldown: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={`rule severity ${i}`}
                          className={CELL}
                          value={r.severity}
                          onChange={(e) => setRule(i, { severity: e.target.value })}
                        >
                          <option value="warning">warning</option>
                          <option value="danger">danger</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          aria-label={`remove rule ${i}`}
                          className="rounded-control px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-50 hover:text-red-600"
                          onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            data-testid="alerts-add-rule"
            className="self-start rounded-control border border-gray-200 px-2 py-1 text-[11.5px] text-gray-600 hover:bg-gray-50"
            onClick={() =>
              setRules((rs) => [
                ...rs,
                { topic: '', metric: 'hz', op: 'lt', threshold: '15', clearAfter: '3', cooldown: '10', severity: 'warning' },
              ])
            }
          >
            + Add rule
          </button>

          {derived && (
            <div className="rounded-control border border-gray-200 bg-gray-50 p-2.5" data-testid="alerts-derived">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                derived_rules (auto-derived hz coverage — edit via Advanced)
              </p>
              <pre className="overflow-x-auto font-mono text-[11px] text-gray-600">
                {JSON.stringify(derived, null, 2)}
              </pre>
            </div>
          )}

          {warnings.length > 0 && (
            <ul className="list-disc rounded-control border border-amber-200 bg-amber-50 pl-6 pr-3 py-2 text-[11.5px] text-amber-800" data-testid="alerts-warnings">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {pendingServer && (
            <div
              data-testid="alerts-server-changed"
              className="flex flex-col gap-2 rounded-control border border-amber-300 bg-amber-50 p-2.5 text-[11.5px] text-amber-800"
            >
              <p>
                <span className="font-semibold">alerts.yaml changed on the server</span> while you
                were editing — another terminal saved it, or the active robot changed. Your unsaved
                edits are kept and nothing here was overwritten, but saving now writes over that
                newer file.
              </p>
              <button
                type="button"
                data-testid="alerts-load-server"
                onClick={() => {
                  seedFrom(pendingServer);
                  setPendingServer(null);
                  setSaved(false);
                }}
                className="self-start rounded-control border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-800 hover:bg-amber-100"
              >
                Load the server copy (discards my edits)
              </button>
            </div>
          )}

          {mutation.isError && (
            <div>
              <ErrorMessage error={mutation.error} />
              {details.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-red-700" data-testid="alerts-errors">
                  {details.map((d, i) => (
                    <li key={i} className="font-mono">
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {saved && !mutation.isPending && (
            <p data-testid="alerts-saved" className="text-[12.5px] font-medium text-teal-700">
              Saved — applies on the next topic_monitor restart.
              <span className="ml-1 font-normal text-gray-500">
                The file is rewritten in canonical form, so comments, key order and YAML
                anchors are not kept; the editor above now shows the file as written.
              </span>
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              data-testid="alerts-save"
              onClick={saveForm}
              disabled={mutation.isPending || rawDirty}
              className="px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            {rawDirty ? (
              <span
                data-testid="alerts-form-save-blocked"
                className="text-[11px] text-amber-700"
              >
                The Advanced YAML below has unsaved edits — this Save would
                silently drop them. Use “Save YAML”, or reopen Data quality to
                discard them.
              </span>
            ) : (
              <span className="text-[11px] text-gray-500">The server validates on save.</span>
            )}
          </div>

          {/* Advanced: raw YAML (edits derived_rules and anything the table omits). */}
          <div className="rounded-control border border-gray-200">
            <button
              type="button"
              data-testid="alerts-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"
            >
              <span className={cn('text-gray-500 transition-transform', advancedOpen && 'rotate-90')}>
                ▸
              </span>
              Advanced — edit raw YAML
              {rawDirty && (
                <span
                  data-testid="alerts-raw-dirty"
                  className="rounded-chip bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700"
                >
                  unsaved
                </span>
              )}
              {path && <span className="font-mono text-[11px] font-normal text-gray-500">{path}</span>}
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-2 border-t border-gray-100 p-3.5" data-testid="alerts-advanced">
                <textarea
                  aria-label="alerts config yaml"
                  className="h-56 w-full rounded-control border border-gray-200 p-2 font-mono text-xs focus:border-teal-600 focus:outline-none"
                  spellCheck={false}
                  value={rawText}
                  placeholder="rules: []"
                  onChange={(e) => setRawText(e.target.value)}
                />
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    data-testid="alerts-save-raw"
                    onClick={saveRaw}
                    disabled={mutation.isPending}
                    className="px-4 py-1.5 text-sm disabled:opacity-50"
                  >
                    {mutation.isPending ? 'Saving…' : 'Save YAML'}
                  </Button>
                  {formDirty && (
                    <span
                      data-testid="alerts-raw-discard-warn"
                      className="text-[11px] text-amber-700"
                    >
                      The rules table above has unsaved edits — Save YAML writes
                      the file from this text and discards them.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
