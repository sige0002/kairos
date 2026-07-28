// Pure mapping for the Collect "Active warnings" card and the System status
// "Topic rates" row — both sourced from REAL live data (the SSE alert buffer +
// the monitor's metrics snapshot), never fabricated (honesty rule).
//
// The card's warnings are the union of two honest signals:
//  - target topics not publishing (the recorder's arming snapshot — start-time
//    coverage, frozen at resume), and
//  - FIRING monitor alerts (hz/gap/… threshold breaches) restricted to the
//    topics this console records — which is what catches a topic that was
//    healthy at start and degraded MID-recording (the arming snapshot can't).
//
// Kept DOM-free so the filtering/counting is unit-testable without React.

import type { AlertEvent, MetricsSnapshot, RecordArming } from '../../api/types';
import { matchesTopic } from '../../features/record/topics';
import { toAlertRows, type AlertRow } from '../monitor/alerts';

/**
 * The firing alert rows the Collect card shows, restricted to the topics this
 * console records: the arming snapshot's exact target list when the recorder
 * has one, else the configured `default_topics` patterns. With neither (no
 * arming yet AND empty config) every firing alert passes — a broad warning
 * beats a silently hidden one.
 */
export function firingAlertRows(
  alerts: AlertEvent[],
  arming: RecordArming | null,
  defaultTopics: string[],
): AlertRow[] {
  const firing = toAlertRows(alerts, Infinity).filter((r) => r.state === 'firing');
  const targets = arming
    ? new Set([
        ...arming.matched_topics,
        ...arming.missing_topics,
        ...(arming.unsubscribed_topics ?? []),
      ])
    : null;
  if (targets && targets.size > 0) return firing.filter((r) => targets.has(r.topic));
  if (defaultTopics.length > 0) {
    return firing.filter((r) => defaultTopics.some((p) => matchesTopic(p, r.topic)));
  }
  return firing;
}

export interface ArmingWarning {
  /** Every target the recorder is not capturing yet (both causes). */
  topics: string[];
  /** Headline — states only the cause the recorder actually observed. */
  title: string;
  /** Sub-line explaining what the operator should expect / do. */
  detail: string;
}

/**
 * The "targets not being captured" warning, split by CAUSE so the card never
 * calls a live topic dead. `missing_topics` is "no publisher on the graph";
 * `unsubscribed_topics` is "published, but the recorder has not subscribed
 * yet" — the operator sees those at full rate in Monitor, so reporting them as
 * "not publishing" reads as a bug and sends them to fix the wrong thing.
 * Returns null when every target is matched.
 */
export function armingWarning(arming: RecordArming | null): ArmingWarning | null {
  const missing = arming?.missing_topics ?? [];
  const unsubscribed = arming?.unsubscribed_topics ?? [];
  const topics = [...missing, ...unsubscribed];
  if (topics.length === 0) return null;
  const n = topics.length;
  const plural = n === 1 ? '' : 's';
  if (unsubscribed.length === 0) {
    return {
      topics,
      title: `${n} target topic${plural} not publishing`,
      detail: "Recording continues, but these won't be captured until they appear.",
    };
  }
  if (missing.length === 0) {
    return {
      topics,
      title: `${n} target topic${plural} not subscribed yet`,
      detail:
        'These are publishing — the recorder has not subscribed yet (discovery).',
    };
  }
  return {
    topics,
    title: `${n} target topic${plural} not being captured`,
    detail: `${missing.length} not publishing, ${unsubscribed.length} awaiting subscription.`,
  };
}

export interface TopicRates {
  ok: number;
  judged: number;
}

/**
 * "N/M at expected rate" for the System status card: of the topics the monitor
 * actually judged (backend per-topic `status`, OL-②.2), how many are `ok`.
 * `unknown` (no reference rate yet / baseline still learning) is excluded from
 * M so the line never blames a topic nobody measured; null when there is no
 * judged topic at all (monitor down / no snapshot) → the row renders "—".
 */
export function topicRates(metrics: MetricsSnapshot | undefined): TopicRates | null {
  const topics = metrics?.topics ?? [];
  const judged = topics.filter((t) => t.status && t.status !== 'unknown');
  if (judged.length === 0) return null;
  return {
    ok: judged.filter((t) => t.status === 'ok').length,
    judged: judged.length,
  };
}
