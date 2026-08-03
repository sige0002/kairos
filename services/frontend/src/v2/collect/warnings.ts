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
import type { MonitorRow } from '../../features/monitor/useMonitorRows';
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

/**
 * "Nothing is publishing" and "the WRONG THINGS are publishing" render
 * identically today — same 0/N counters, same "not publishing" wording — even
 * when a hundred foreign topics are streaming at full rate. The only evidence
 * anywhere was an unlabelled "N measured · M discovered" on Monitor Overview,
 * so a robot-config mismatch was effectively unreachable from Collect and read
 * as a dead robot.
 *
 * The distinguishing fact is cheap: the configured topics are silent while the
 * graph is busy. That is not proof of a mismatch — a robot can legitimately
 * publish other things — so this returns a possibility to check, never a
 * verdict, and stays silent for the genuinely quiet graph where the existing
 * wording is already right.
 */
export interface ConfigMismatchHint {
  configuredSilent: number;
  discovered: number;
}

/** How many times more topics than configured must be on the graph before the
 *  mismatch is worth raising. A robot publishing a few extras is ordinary; one
 *  publishing an order of magnitude more than we asked for is a question. */
const MISMATCH_RATIO = 3;

export function configMismatchHint(
  configuredSilent: number,
  discovered: number,
): ConfigMismatchHint | null {
  // Nothing silent -> nothing to explain. Nothing discovered -> the graph really
  // is quiet, which the existing "not publishing" wording already describes.
  if (configuredSilent === 0 || discovered === 0) return null;
  if (discovered < configuredSilent * MISMATCH_RATIO) return null;
  return { configuredSilent, discovered };
}

// ---- per-topic liveness ----------------------------------------------------

/**
 * Whether a topic is publishing, silent, outside what anyone measures, or
 * beyond what we can tell at all.
 *
 * `unmonitored` and `unknown` are both "we cannot say", kept apart because they
 * have different fixes: `unmonitored` is a topic nobody was asked to watch (add
 * it to the monitored set and the answer appears), `unknown` is the monitor
 * itself not answering (nothing about any topic is established).
 */
export type TopicLiveness = 'live' | 'silent' | 'unmonitored' | 'unknown';

/**
 * Whether a camera tile's SOURCE topic is still publishing.
 *
 * Frame deltas cannot answer this. qa-ui hooked RTCPeerConnection and found the
 * streamer keeps delivering a real 15fps after the source dies — it re-encodes
 * the frozen last frame — so `framesStaleMs` correctly never fires and the tile
 * happily reports a live rate for a picture that stopped changing. The monitor
 * already knows the topic went silent (it shows SILENT, and the add-camera
 * picker drops to "No image topics found"), so the honest signal is there; it
 * just was not being read.
 *
 * Neither "we cannot say" answer is ever rendered as one of the others: with no
 * measurement we have not established anything.
 */
export function topicLiveness(rows: MonitorRow[], topic: string): TopicLiveness {
  if (rows.length === 0) return 'unknown';
  const row = rows.find((r) => r.name === topic);
  // Discovery no longer lists it: its publisher is gone. This is the case the
  // add-camera picker already surfaces as "No image topics found".
  if (!row) return 'silent';
  if (row.status === 'inactive') return 'silent';
  // Measured and not flagged inactive: the monitor is seeing traffic on it.
  // Measurement outranks the publisher count below — the count is a momentary
  // discovery sample, and a restart flap must not override observed frames;
  // real silence flips `status` to inactive within the monitor's own window.
  if (row.measured) return 'live';
  // Unmeasured, but discovery itself counted the publishers and found none:
  // the topic is on the graph only because something subscribes to it (our own
  // preview subscription is enough). No publisher means no frames, regardless
  // of monitoring coverage — a definite silent, not a coverage gap, and it
  // holds even when the monitor is blind (the count comes from the /topics
  // poll, not the metrics snapshot).
  if (row.publisher_count === 0) return 'silent';
  // On the graph, but nobody is measuring it — which is NOT the same as
  // publishing, and used to be read that way. A topic stays in discovery for as
  // long as anything is attached to it, and the streamer's own preview
  // subscription is enough to keep it there after the publisher dies. So graph
  // presence was being turned into a confident frame rate for a picture that
  // had stopped changing — the same lie the silent overlay was built to stop,
  // reachable by design for any camera outside the monitored set (on the HSR
  // profile that is everything the add-camera picker offers).
  //
  // One measured row anywhere proves the monitor is answering, which is what
  // makes this a gap in COVERAGE rather than a blind monitor.
  return rows.some((r) => r.measured) ? 'unmonitored' : 'unknown';
}
