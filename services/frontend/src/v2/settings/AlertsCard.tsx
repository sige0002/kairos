// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
import { useTranslation } from 'react-i18next';
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
  'rounded-control border border-border px-1.5 py-1 text-[12px] focus:border-accent focus:outline-none';

export function AlertsCard() {
  const { t } = useTranslation('settings');
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
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('alerts.title')}
        </h2>
        <Badge tone="amber" dot>
          {t('alerts.restart')}
        </Badge>
      </div>

      {optionsQuery.isError ? (
        <ErrorMessage error={optionsQuery.error} />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending || !activeRobot ? (
        <p className="text-sm text-text-muted">{t('alerts.loading')}</p>
      ) : (
        <>
          <p className="text-[11.5px] leading-relaxed text-text-muted">
            {t('alerts.intro')}
          </p>

          <div
            className="overflow-x-auto rounded-control border border-border"
            data-testid="alerts-rules"
          >
            <table className="w-full min-w-[720px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                  <th className="px-2 py-1.5 text-left">{t('alerts.columns.topic')}</th>
                  <th className="px-2 py-1.5 text-left">
                    {t('alerts.columns.metric')}
                  </th>
                  <th className="px-2 py-1.5 text-left">{t('alerts.columns.op')}</th>
                  <th className="px-2 py-1.5 text-left">
                    {t('alerts.columns.threshold')}
                  </th>
                  <th className="px-2 py-1.5 text-left">
                    {t('alerts.columns.clearAfter')}
                  </th>
                  <th className="px-2 py-1.5 text-left">
                    {t('alerts.columns.cooldown')}
                  </th>
                  <th className="px-2 py-1.5 text-left">
                    {t('alerts.columns.severity')}
                  </th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-2 py-3 text-center text-[12px] text-text-muted"
                    >
                      {t('alerts.empty')}
                    </td>
                  </tr>
                ) : (
                  rules.map((r, i) => (
                    <tr
                      key={i}
                      className="border-b border-border last:border-b-0 align-top"
                    >
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={t('alerts.aria.topic', { index: String(i) })}
                          className={cn(CELL, 'font-mono w-full min-w-[180px]')}
                          value={r.topic}
                          placeholder="/hsrb/joint_states"
                          onChange={(e) => setRule(i, { topic: e.target.value })}
                        />
                        {r.metric === 'loss' && (
                          <p
                            data-testid={`alerts-loss-warn-${i}`}
                            className="mt-1 text-[10.5px] text-status-warning-text"
                          >
                            {t('alerts.lossWarning')}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={t('alerts.aria.metric', { index: String(i) })}
                          className={cn(
                            CELL,
                            r.metric === 'loss' &&
                              'border-status-warning-border bg-status-warning-bg',
                          )}
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
                          aria-label={t('alerts.aria.op', { index: String(i) })}
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
                          aria-label={t('alerts.aria.threshold', { index: String(i) })}
                          type="number"
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.threshold}
                          onChange={(e) => setRule(i, { threshold: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={t('alerts.aria.clearAfter', { index: String(i) })}
                          type="number"
                          min={0}
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.clearAfter}
                          onChange={(e) => setRule(i, { clearAfter: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          aria-label={t('alerts.aria.cooldown', { index: String(i) })}
                          type="number"
                          min={0}
                          className={cn(CELL, 'font-mono w-20')}
                          value={r.cooldown}
                          onChange={(e) => setRule(i, { cooldown: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          aria-label={t('alerts.aria.severity', { index: String(i) })}
                          className={CELL}
                          value={r.severity}
                          onChange={(e) => setRule(i, { severity: e.target.value })}
                        >
                          <option value="warning">
                            {t('alerts.severity.warning')}
                          </option>
                          <option value="danger">{t('alerts.severity.danger')}</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          aria-label={t('alerts.aria.remove', { index: String(i) })}
                          className="rounded-control px-2 py-1 text-[12px] text-text-muted hover:bg-surface-muted hover:text-status-danger-text"
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
            className="self-start rounded-control border border-border px-2 py-1 text-[11.5px] text-text-secondary hover:bg-surface-muted"
            onClick={() =>
              setRules((rs) => [
                ...rs,
                {
                  topic: '',
                  metric: 'hz',
                  op: 'lt',
                  threshold: '15',
                  clearAfter: '3',
                  cooldown: '10',
                  severity: 'warning',
                },
              ])
            }
          >
            {t('alerts.add')}
          </button>

          {derived && (
            <div
              className="rounded-control border border-border bg-surface-muted p-2.5"
              data-testid="alerts-derived"
            >
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                {t('alerts.derived')}
              </p>
              <pre className="overflow-x-auto font-mono text-[11px] text-text-secondary">
                {JSON.stringify(derived, null, 2)}
              </pre>
            </div>
          )}

          {warnings.length > 0 && (
            <ul
              className="list-disc rounded-control border border-status-warning-border bg-status-warning-bg pl-6 pr-3 py-2 text-[11.5px] text-status-warning-text"
              data-testid="alerts-warnings"
            >
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {pendingServer && (
            <div
              data-testid="alerts-server-changed"
              className="flex flex-col gap-2 rounded-control border border-status-warning-border bg-status-warning-bg p-2.5 text-[11.5px] text-status-warning-text"
            >
              <p>{t('alerts.serverChanged')}</p>
              <button
                type="button"
                data-testid="alerts-load-server"
                onClick={() => {
                  seedFrom(pendingServer);
                  setPendingServer(null);
                  setSaved(false);
                }}
                className="self-start rounded-control border border-status-warning-border bg-surface px-2.5 py-1 font-semibold text-status-warning-text hover:bg-status-warning-bg"
              >
                {t('alerts.loadServer')}
              </button>
            </div>
          )}

          {mutation.isError && (
            <div>
              <ErrorMessage error={mutation.error} />
              {details.length > 0 && (
                <ul
                  className="mt-1 list-disc pl-5 text-xs text-status-danger-text"
                  data-testid="alerts-errors"
                >
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
            <p
              data-testid="alerts-saved"
              className="text-[12.5px] font-medium text-accent"
            >
              {t('alerts.saved')}
              <span className="ml-1 font-normal text-text-muted">
                {t('alertsNormalised')}
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
              {mutation.isPending ? t('common.saving') : t('alerts.saveForm')}
            </Button>
            {rawDirty ? (
              <span
                data-testid="alerts-form-save-blocked"
                className="text-[11px] text-status-warning-text"
              >
                {t('alerts.rawDirty')}
              </span>
            ) : (
              <span className="text-[11px] text-text-muted">
                {t('recording.schemaNote')}
              </span>
            )}
          </div>

          {/* Advanced: raw YAML (edits derived_rules and anything the table omits). */}
          <div className="rounded-control border border-border">
            <button
              type="button"
              data-testid="alerts-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-text-primary hover:bg-surface-muted"
            >
              <span
                className={cn(
                  'text-text-muted transition-transform',
                  advancedOpen && 'rotate-90',
                )}
              >
                ▸
              </span>
              {t('alerts.rawTitle')}
              {rawDirty && (
                <span
                  data-testid="alerts-raw-dirty"
                  className="rounded-chip bg-status-warning-bg px-1.5 text-[10px] font-semibold text-status-warning-text"
                >
                  {t('alerts.rawDirty')}
                </span>
              )}
              {path && (
                <span className="font-mono text-[11px] font-normal text-text-muted">
                  {path}
                </span>
              )}
            </button>
            {advancedOpen && (
              <div
                className="flex flex-col gap-2 border-t border-border p-3.5"
                data-testid="alerts-advanced"
              >
                <textarea
                  aria-label={t('alerts.aria.raw')}
                  className="h-56 w-full rounded-control border border-border p-2 font-mono text-xs focus:border-accent focus:outline-none"
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
                    {mutation.isPending ? t('common.saving') : t('alerts.saveYaml')}
                  </Button>
                  {formDirty && (
                    <span
                      data-testid="alerts-raw-discard-warn"
                      className="text-[11px] text-status-warning-text"
                    >
                      {t('alerts.discardForm')}
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
