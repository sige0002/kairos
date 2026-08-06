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
import type { StreamFailure } from '../../features/stream/useWebRtcStream';
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
  /** Readings the ingest could not identify, excluded from BOTH sides above
   *  (E-23). Non-zero means this ratio describes fewer topics than arrived. */
  withheld: number;
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
  // E-23: the SSE ingest drops readings whose shape it cannot identify, and
  // BOTH sides of this ratio come from the array it filtered — so a dropped
  // row leaves the numerator and the denominator together and "12 / 12 at
  // expected" is reported for a robot that published 13. The withheld count
  // travels with the ratio so the card can refuse to call that complete. This
  // is the screen an operator watches WHILE RECORDING; it is the last place a
  // missing reading should be invisible.
  const withheld = metrics?.malformed_dropped ?? 0;
  const judged = topics.filter((t) => t.status && t.status !== 'unknown');
  if (judged.length === 0 && withheld === 0) return null;
  return {
    ok: judged.filter((t) => t.status === 'ok').length,
    judged: judged.length,
    withheld,
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

/** What the System card's Cameras row is allowed to say, in one place. */
export interface CameraSummaryInput {
  totalCameras: number;
  /** Panes whose own WebRTC stream is not connected. Every pane negotiates
   *  separately, so this is a count across ALL of them, not the main one. */
  streamsDown: number;
  /** The cause they agree on, 'mixed' when they do not, null when unknown.
   *  A PRIMITIVE on purpose: this rides inside CameraHealth, which is compared
   *  field-by-field with `===` to decide whether the parent's state changed —
   *  an array would be a fresh reference every render and never settle. */
  streamFault: StreamFailure | 'mixed' | null;
  silentTopics: number;
  unmonitoredTopics: number;
  framesStale: boolean;
}

export interface CameraSummary {
  value: string;
  chip: string;
  tone: 'green' | 'amber' | 'gray';
  title?: string;
}

/** One cause in the operator's terms, or null when they disagree.
 *
 *  Naming a single reason for a mixed set would be a guess dressed as a
 *  diagnosis, and the three causes send the operator to three different places:
 *  the streamer service, the network, or this browser. */
function streamFaultReason(fault: StreamFailure | 'mixed' | null): string | null {
  if (fault === null) return null;
  if (fault === 'mixed') return 'more than one reason';
  if (fault === 'signaling') return 'the streamer did not answer';
  if (fault === 'peer') return 'the network connection dropped';
  return 'this browser has no WebRTC';
}

/**
 * The Cameras row of the System card (E-37).
 *
 * The rule this enforces: the row may not read as "everything is fine" while
 * any pane's stream is down. It used to, because only the MAIN pane's phase
 * reached this card — four black tiles beside one working stream summarised as
 * "5 cameras OK" in green, and a total blackout said "main stream failed",
 * which describes one pane and one clause for a console with no pictures at
 * all.
 *
 * Faults are ranked by what the operator can act on first: a silent source
 * topic outranks a stream fault (there is no picture to rescue at the
 * transport layer if nothing is publishing), and a stream fault outranks a
 * stale-frame report from the main tile.
 */
export function cameraSummary(input: CameraSummaryInput): CameraSummary {
  const { totalCameras, streamsDown, silentTopics, unmonitoredTopics, framesStale } = input;
  if (totalCameras === 0) return { value: 'none open', chip: '—', tone: 'gray' };
  const gap = unmonitoredTopics > 0 ? ` · ${unmonitoredTopics} not monitored` : '';

  if (silentTopics > 0) {
    return {
      value: `${silentTopics} of ${totalCameras} cameras: topic silent${gap}`,
      chip: 'CHECK',
      tone: 'amber',
    };
  }
  if (streamsDown > 0) {
    const reason = streamFaultReason(input.streamFault);
    return {
      value:
        `${streamsDown} of ${totalCameras} cameras: no video` +
        (reason ? ` — ${reason}` : '') +
        gap,
      title:
        'Each camera negotiates its own stream, so this counts every pane, not ' +
        'just the main one. The reason comes from where the connection failed: ' +
        'the streamer not answering is a service to restart, a dropped ' +
        'connection is the network between here and it.',
      chip: 'CHECK',
      tone: 'amber',
    };
  }
  if (framesStale) {
    return {
      value: `main stream: no frames${gap}`,
      chip: 'CHECK',
      tone: 'amber',
    };
  }
  if (unmonitoredTopics > 0) {
    const known = totalCameras - unmonitoredTopics;
    return {
      value: `${known} of ${totalCameras} cameras OK${gap}`,
      title:
        'These panes are outside the monitored set, so nothing measures ' +
        'whether their source topics are still publishing. The preview keeps ' +
        'showing frames either way.',
      chip: '—',
      tone: 'gray',
    };
  }
  return {
    value: `${totalCameras} camera${totalCameras === 1 ? '' : 's'} OK`,
    chip: 'OK',
    tone: 'green',
  };
}
