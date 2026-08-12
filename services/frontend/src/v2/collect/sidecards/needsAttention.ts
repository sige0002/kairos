// System status rows that are NOT passing, restated for the Active warnings
// card in the operator's terms (#13).
//
// These are not alerts and are not given an invented severity: each item quotes
// the row it came from — its own label, its own figure, its own chip and tone —
// and adds only two things the row has no room for, what it means for the take
// in progress and what to do about it. Nothing here measures anything; the
// measuring already happened in useSystemRows.
//
// Kept DOM-free so the filtering and the wording are unit-testable without
// React.

import type { Tone } from './Chip';
import type { SysRow } from './useSystemRows';

/** The chip text a System status row shows when it is not passing. */
const CHECK = 'CHECK';

export interface NeedsAttentionItem {
  /** The System status row this came from, verbatim — so the operator can find
   *  it on the card above rather than wonder whether it is a second finding. */
  label: string;
  /** That row's own figure, quoted. Never a second derivation of it: two
   *  derivations disagreeing is the bug this whole file answers. */
  value: string;
  chip: string;
  tone: Tone;
  /** What it means for the take in progress. */
  impact: string;
  /** What to do about it. */
  action: string;
}

/**
 * Plain-language impact/action, keyed by a row's `cause` when it has one and by
 * its label otherwise.
 *
 * Wording rules (honesty): a rate shortfall is an observed shortfall, never
 * "loss" or "dropped"; nothing claims a number this console did not measure;
 * and where recording is genuinely unaffected the text says so, because an
 * operator who reads every check as "stop now" stops reading them.
 *
 * The monitor is an INDEPENDENT receive-side subscriber, not a tap on the
 * recorder. What it counts is a floor on what was published — it is not
 * evidence about what the recorder wrote — so the rate entries below report
 * what the monitor observed and keep the hedge about the recording explicit.
 */
const COPY: Record<string, { impact: string; action: string }> = {
  'Required data': {
    impact:
      'Some target topics were not being captured when this take started, so ' +
      'the recording is missing them.',
    action:
      'Fix those topics and start again if the take needs them — this snapshot ' +
      'is not re-checked while the take runs.',
  },
  // 'Topic rates' has no entry of its own: the label does not say WHICH of the
  // four states below the row is in, and one sentence covering all of them was
  // false for the unreadable-only case (it named a rate shortfall nobody had
  // measured). A rates row arriving with no `cause` therefore takes the honest
  // FALLBACK rather than any of these.
  'rates-shortfall': {
    impact:
      'The monitor is receiving some topics below their expected rate. It ' +
      'subscribes separately from the recorder, so this does not establish what ' +
      'the recording holds — but a topic short here is one to check before ' +
      'trusting the take.',
    action:
      'Open Monitor to see which topics are below rate, then decide whether to ' +
      'keep this take.',
  },
  'rates-unreadable': {
    impact:
      'Every topic the monitor could read is at its expected rate, but some ' +
      'readings arrived in a shape this console could not parse — no usable ' +
      'topic name — so they count on neither side of that ratio. It describes ' +
      'what was readable, not everything the robot published.',
    action:
      'Nothing is established about those readings either way. Check Monitor, ' +
      'and if it persists check that the monitor and this console run the same ' +
      'build.',
  },
  'rates-mixed': {
    impact:
      'Two things at once: the monitor is receiving some topics below their ' +
      'expected rate, and some readings arrived in a shape this console could ' +
      'not parse, so the ratio covers fewer topics than the robot published.',
    action:
      'Open Monitor for the topics below rate. The unparseable readings count ' +
      'on neither side, so treat the ratio as a floor rather than the whole ' +
      'picture.',
  },
  'rates-none-readable': {
    impact:
      'No topic here is established either way: the readings this console could ' +
      'parse have no reference rate yet, and the rest arrived in a shape it ' +
      'could not parse at all.',
    action:
      'Give the monitor a moment to settle its rate references, and check ' +
      'Monitor if the unparseable readings persist.',
  },
  Cameras: {
    impact:
      'At least one camera pane has no picture, so nothing here confirms what ' +
      'those cameras are seeing.',
    action:
      'Check the camera and the streamer service — the row above says which ' +
      'case it is.',
  },
  'Monitor link': {
    impact:
      'The live monitoring feed is not reaching this console, so the figures ' +
      'above may be out of date. Recording runs in a separate service and is ' +
      'not necessarily affected.',
    action:
      'Check the monitor service. Until it answers, treat the live rows as ' +
      'unknown rather than as fine.',
  },
  Storage: {
    impact:
      'Free space on the recording disk is low. A long take can fill it and end ' +
      'before you stop it.',
    action: 'Free space or move finished captures off the disk before recording more.',
  },
  Build: {
    impact:
      'The robot and this console are running different builds, so what you see ' +
      'here may not match what the robot actually does.',
    action: 'Rebuild and restart the robot side so both run the same build.',
  },
  Recorder: {
    impact:
      'The recorder is not answering, so nothing here can confirm whether a ' +
      'take is running or being written to disk.',
    action: 'Check the recorder service before starting — a take may already be running.',
  },
};

/**
 * For a row this file has no wording for yet. Says only what is established —
 * that the check is not passing — rather than guessing at a consequence.
 *
 * Its existence is the point: a row (or a `cause`) added to useSystemRows later
 * reaches the warnings card without anyone remembering to come back here, so
 * the card cannot silently go back to claiming "no active warnings" over a
 * CHECK. Note what it does NOT cover — see the chip filter below.
 */
const FALLBACK = {
  impact: 'This check is not passing, so the take cannot be called clean.',
  action: 'Read the row on the System status card above before relying on this take.',
};

export interface NeedsAttentionOptions {
  /**
   * Whether the card is already rendering the arming block above this list.
   * That block names the uncaptured target topics one by one, which is the same
   * start-time gap the "Required data" row counts — listing it twice would read
   * as two separate problems.
   */
  uncapturedShown?: boolean;
}

export function needsAttentionItems(
  rows: SysRow[],
  { uncapturedShown = false }: NeedsAttentionOptions = {},
): NeedsAttentionItem[] {
  return (
    rows
      // Rows are selected by the exact chip text, which is a CONVENTION rather
      // than something derived: per-row chip vocabularies exist, and Recorder is
      // the live example — it spells its states REC / STOPPING / ARMED / READY
      // and reaches CHECK only when it has no answer at all. So FALLBACK above
      // protects unknown LABELS and unknown causes, NOT unknown chip spellings.
      // A row that starts reporting a not-passing state under some other word
      // must either spell it CHECK or be added to this filter, or it will pass
      // through this card in silence — which is the bug this file exists for.
      .filter((r) => r.chip === CHECK)
      .filter((r) => !(uncapturedShown && r.label === 'Required data'))
      .map((r) => ({
        label: r.label,
        value: r.value,
        chip: r.chip,
        tone: r.tone,
        // The cause wins where a row has one: it is the specific thing that
        // happened, and the label is only its heading. A cause with no entry
        // falls through to FALLBACK rather than to the label's wording, which
        // could describe a different cause entirely.
        ...(COPY[r.cause ?? r.label] ?? FALLBACK),
      }))
  );
}
