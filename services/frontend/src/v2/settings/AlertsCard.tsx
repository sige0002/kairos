// Settings > Data quality > Alerts — form-first editor for the ACTIVE robot's
// topic_monitor alert rules (GET/PUT /api/v1/config/alerts). Replaces the old
// "not exposed by the API" note with a real rules table (topic / metric / op /
// threshold / clear_after_s / cooldown_s / severity) plus an Advanced raw-YAML
// editor. topic_monitor loads alerts.yaml ONCE at startup (no live-reload path),
// so an edit applies on the next monitor restart — the badge says so. A
// `metric: loss` rule is accepted but flagged inline (loss_rate is null in the
// monitor, so it can never fire). The optional derived_rules block is shown
// read-only and preserved on save.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Badge, Button, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  ALERTS_CONFIG_KEY,
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
  'rounded-control border border-gray-200 px-1.5 py-1 text-[12px] focus:border-teal-500 focus:outline-none';

export function AlertsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ALERTS_CONFIG_KEY,
    queryFn: ({ signal }) => apiGet<AlertsPayload>('/config/alerts', { signal }),
  });

  const [rules, setRules] = useState<RuleForm[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saved, setSaved] = useState(false);

  const derived = query.data?.config?.derived_rules ?? null;

  useEffect(() => {
    if (query.data) {
      setRules(toRuleForms(query.data.config));
      setRawText(query.data.raw ?? '');
      setSaved(false);
    }
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (body: AspectPutBody) => putAlertsConfig(body),
    onSuccess: (data) => {
      setSaved(true);
      queryClient.setQueryData(ALERTS_CONFIG_KEY, data);
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
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Alert rules
        </span>
        <Badge tone="amber" dot>
          applies on monitor restart
        </Badge>
      </div>

      {query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending ? (
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
                <tr className="border-b border-gray-100 bg-gray-50 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-400">
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
                    <td colSpan={8} className="px-2 py-3 text-center text-[12px] text-gray-400">
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
                          className="rounded-control px-2 py-1 text-[12px] text-gray-400 hover:bg-gray-50 hover:text-red-600"
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
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              data-testid="alerts-save"
              onClick={saveForm}
              disabled={mutation.isPending}
              className="px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            <span className="text-[11px] text-gray-400">The server validates on save.</span>
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
              <span className={cn('text-gray-400 transition-transform', advancedOpen && 'rotate-90')}>
                ▸
              </span>
              Advanced — edit raw YAML
              {path && <span className="font-mono text-[11px] font-normal text-gray-400">{path}</span>}
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-2 border-t border-gray-100 p-3.5" data-testid="alerts-advanced">
                <textarea
                  aria-label="alerts config yaml"
                  className="h-56 w-full rounded-control border border-gray-200 p-2 font-mono text-xs focus:border-teal-500 focus:outline-none"
                  spellCheck={false}
                  value={rawText}
                  placeholder="rules: []"
                  onChange={(e) => setRawText(e.target.value)}
                />
                <Button
                  type="button"
                  data-testid="alerts-save-raw"
                  onClick={saveRaw}
                  disabled={mutation.isPending}
                  className="self-start px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {mutation.isPending ? 'Saving…' : 'Save YAML'}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
