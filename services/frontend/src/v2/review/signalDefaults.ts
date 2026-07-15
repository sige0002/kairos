// Signals-defaults consumption hook for the Review > Signals section (S1').
// Self-contained + DOM-free: `loadSignalDefaults()` fetches the per-robot signals
// aspect (GET /api/v1/config/signals) and tolerates a 404/error by falling back
// to the built-in defaults; `applyDefaults(report, defaults)` is a pure function
// that picks the default topic + fields for a signal_report. Wiring into
// SignalSection.tsx is deliberately left to that file's owner (see handoff note).

import { apiGet } from '../../api/client';
import type { SignalReport } from '../../api/types';

/** One per-msg_type default field selection. */
export interface SignalDefaultRule {
  msgType: string;
  fields: string[];
}

/** The resolved signals defaults the Review section consumes. */
export interface SignalDefaults {
  /** fnmatch patterns on field paths; matching leaves are hidden. */
  hiddenFieldPatterns: string[];
  /** Preferred topic to open first (null = derive from rules/first topic). */
  defaultTopic: string | null;
  defaults: SignalDefaultRule[];
  /** No rule matched → select the first N non-hidden numeric leaves. */
  fallbackFields: number;
}

/** Built-in fallback used on 404/error and when a robot has no signals file:
 *  hide `header.*`, auto-select the first 4 non-hidden numeric leaves. */
export const BUILTIN_SIGNAL_DEFAULTS: SignalDefaults = {
  hiddenFieldPatterns: ['header.*'],
  defaultTopic: null,
  defaults: [],
  fallbackFields: 4,
};

/** The subset of GET /api/v1/config/signals this hook reads. */
interface SignalsAspectPayload {
  config: {
    hidden_field_patterns?: string[];
    default_topic?: string | null;
    defaults?: { msg_type?: string; fields?: string[] }[];
    fallback_fields?: number;
  } | null;
}

/** Fetch the per-robot signals defaults, or the built-in fallback on any error
 *  (404 when a robot has no signals file, network failure, malformed body). */
export async function loadSignalDefaults(): Promise<SignalDefaults> {
  try {
    const { config } = await apiGet<SignalsAspectPayload>('/config/signals');
    if (!config) return BUILTIN_SIGNAL_DEFAULTS;
    return {
      hiddenFieldPatterns:
        config.hidden_field_patterns ?? BUILTIN_SIGNAL_DEFAULTS.hiddenFieldPatterns,
      defaultTopic: config.default_topic ?? null,
      defaults: (config.defaults ?? []).map((d) => ({
        msgType: d.msg_type ?? '',
        fields: d.fields ?? [],
      })),
      fallbackFields: config.fallback_fields ?? BUILTIN_SIGNAL_DEFAULTS.fallbackFields,
    };
  } catch {
    return BUILTIN_SIGNAL_DEFAULTS;
  }
}

/** fnmatch-style glob → anchored RegExp. `*` matches any run (including dots, so
 *  `header.*` hides `header.stamp.sec`), `?` matches one char; the rest literal. */
function globToRegExp(pattern: string): RegExp {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

function isHidden(field: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(field));
}

/** Split a topic's field paths into visible / hidden per the defaults' patterns.
 *  Pure — the Signals section uses it to drive the "Show all fields" toggle
 *  (hidden fields stay selectable once revealed; a SELECTED hidden field is
 *  always shown so an active series can't become untogglable). */
export function partitionFields(
  all: string[],
  selected: string[],
  patterns: string[],
): { visible: string[]; hidden: string[] } {
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const f of all) {
    if (isHidden(f, patterns) && !selected.includes(f)) hidden.push(f);
    else visible.push(f);
  }
  return { visible, hidden };
}

function ruleFor(
  msgType: string | null | undefined,
  defaults: SignalDefaults,
): SignalDefaultRule | undefined {
  if (!msgType) return undefined;
  return defaults.defaults.find((r) => r.msgType === msgType);
}

/** The default topic + field selection applyDefaults resolves for a report. */
export interface AppliedDefaults {
  topic: string | null;
  fields: string[];
}

/**
 * Pick the default topic + fields for a signal_report:
 *   - topic  = the configured `default_topic` when present in the report, else
 *              the first topic whose msg_type matches a rule, else the first topic.
 *   - fields = the matching rule's fields that the report actually carries; when
 *              no rule matched (or none of its fields exist), the first
 *              `fallbackFields` non-hidden numeric leaves.
 * Pure: no fetch, no DOM — unit-testable in isolation.
 */
export function applyDefaults(
  report: SignalReport,
  defaults: SignalDefaults,
): AppliedDefaults {
  const topicsMap = report.topics ?? {};
  const names = Object.keys(topicsMap);
  if (names.length === 0) return { topic: null, fields: [] };

  let topic: string | null = null;
  if (defaults.defaultTopic && names.includes(defaults.defaultTopic)) {
    topic = defaults.defaultTopic;
  }
  if (!topic) {
    topic = names.find((n) => ruleFor(topicsMap[n]?.msg_type, defaults)) ?? names[0]!;
  }

  const tr = topicsMap[topic]!;
  const present = tr.fields ?? {};
  const rule = ruleFor(tr.msg_type, defaults);

  let fields: string[] = [];
  if (rule) fields = rule.fields.filter((f) => f in present);
  if (fields.length === 0) {
    fields = Object.keys(present)
      .filter((f) => !isHidden(f, defaults.hiddenFieldPatterns))
      .slice(0, Math.max(0, defaults.fallbackFields));
  }
  return { topic, fields };
}
