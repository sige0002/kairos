// Feature-local types + helpers for the two single-file config aspect editors
// Settings > Data quality drives: Signals defaults (GET/PUT /api/v1/config/signals)
// and topic_monitor alert rules (GET/PUT /api/v1/config/alerts). Kept here (not in
// api/types.ts) because these types are only used by the Settings cards; the
// PUT helpers wrap the shared apiPut so client.ts stays untouched.

import { ApiError, apiPut } from '../../api/client';

// ---- Signals (S1') --------------------------------------------------------

/** One per-msg_type default field selection for the Review Signals view. */
export interface SignalDefaultRule {
  msg_type: string;
  fields: string[];
}

/** config/<robot>/signals/default.yaml (display-only; applies immediately). */
export interface SignalsConfig {
  hidden_field_patterns?: string[];
  default_topic?: string | null;
  defaults?: SignalDefaultRule[];
  fallback_fields?: number;
}

/** GET/PUT /api/v1/config/signals — parsed config + raw YAML + on-disk path. */
export interface SignalsPayload {
  config: SignalsConfig | null;
  raw: string | null;
  path: string | null;
}

// ---- Alerts (F2'') --------------------------------------------------------

/** The metrics the monitor evaluates. `loss` is valid but can NEVER fire
 *  (loss_rate is null in ROS 2) — the UI warns when it is selected. */
export const KNOWN_METRICS = ['hz', 'bandwidth', 'gap', 'late', 'loss'] as const;
export const KNOWN_OPS = ['lt', 'gt', 'le', 'ge'] as const;
export type AlertMetric = (typeof KNOWN_METRICS)[number];
export type AlertOp = (typeof KNOWN_OPS)[number];

/** One threshold alert rule (mirrors topic_monitor.models.AlertRule). */
export interface AlertRule {
  topic: string;
  metric: string;
  op: string;
  threshold: number;
  clear_after_s?: number;
  cooldown_s?: number;
  severity?: string;
}

/** config/<robot>/monitoring/alerts.yaml. `derived_rules` is the optional
 *  auto-derived-rule tuning block, shown read-only when present. */
export interface AlertsConfig {
  rules?: AlertRule[];
  derived_rules?: Record<string, unknown> | null;
}

/** GET/PUT /api/v1/config/alerts — adds `warnings` (e.g. a loss rule). */
export interface AlertsPayload {
  config: AlertsConfig | null;
  raw: string | null;
  path: string | null;
  warnings: string[];
}

// ---- query keys + PUT helpers --------------------------------------------

export const SIGNALS_CONFIG_KEY = ['config', 'signals'] as const;
export const ALERTS_CONFIG_KEY = ['config', 'alerts'] as const;

/** PUT body for a single-file aspect editor: the form sends `config`, the
 *  Advanced editor sends `raw` YAML text (the frontend ships no YAML parser). */
export type AspectPutBody =
  | { config: Record<string, unknown> }
  | { raw: string };

export function putSignalsConfig(body: AspectPutBody): Promise<SignalsPayload> {
  return apiPut<SignalsPayload>('/config/signals', body);
}

export function putAlertsConfig(body: AspectPutBody): Promise<AlertsPayload> {
  return apiPut<AlertsPayload>('/config/alerts', body);
}

/** Flatten a 422 pydantic error envelope (`details.errors: [{loc, msg}]`) into
 *  readable `loc: msg` lines for inline display (mirrors ConfigTab). */
export function formatValidationDetails(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const errors = error.details?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => {
    const rec = e as { loc?: unknown[]; msg?: string };
    const loc = Array.isArray(rec.loc) ? rec.loc.join('.') : '';
    return loc ? `${loc}: ${rec.msg ?? ''}` : (rec.msg ?? '');
  });
}
