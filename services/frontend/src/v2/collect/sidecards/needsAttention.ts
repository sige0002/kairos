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
 * Plain-language impact/action per row kind.
 *
 * Wording rules (honesty): a rate shortfall is an observed shortfall, never
 * "loss" or "dropped"; nothing claims a number this console did not measure;
 * and where recording is genuinely unaffected the text says so, because an
 * operator who reads every check as "stop now" stops reading them.
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
  'Topic rates': {
    impact:
      'Not every topic is arriving at its expected rate. The take can continue, ' +
      'but those topics may hold less data than a normal one.',
    action:
      'Open Monitor to see which topics are off rate, then decide whether to ' +
      'keep this take.',
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
 * Its existence is the point: a row added to useSystemRows later reaches the
 * warnings card without anyone remembering to come back here, so the card
 * cannot silently go back to claiming "no active warnings" over a CHECK.
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
  return rows
    .filter((r) => r.chip === CHECK)
    .filter((r) => !(uncapturedShown && r.label === 'Required data'))
    .map((r) => ({
      label: r.label,
      value: r.value,
      chip: r.chip,
      tone: r.tone,
      ...(COPY[r.label] ?? FALLBACK),
    }));
}
