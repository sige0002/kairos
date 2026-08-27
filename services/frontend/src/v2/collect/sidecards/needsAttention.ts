// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
import { i18n } from '../../../i18n';

/** The chip text a System status row shows when it is not passing. */
export interface NeedsAttentionItem {
  id?: string;
  /** The System status row this came from, verbatim — so the operator can find
   *  it on the card above rather than wonder whether it is a second finding. */
  label: string;
  /** That row's own figure, quoted. Never a second derivation of it: two
   *  derivations disagreeing is the bug this whole file answers. */
  value: string;
  chip: string;
  tone: Tone;
  /** Machine-readable reason supplied by the System status row. */
  cause?: string;
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
const copyFor = (key: string): { impact: string; action: string } => {
  const t = i18n.getFixedT(i18n.language, 'collect');
  switch (key) {
    case 'required-data':
      return {
        impact: t('checkRequiredDataImpact'),
        action: t('checkRequiredDataAction'),
      };
    // 'Topic rates' has no entry of its own: the label does not say WHICH of the
    // four states below the row is in, and one sentence covering all of them was
    // false for the unreadable-only case (it named a rate shortfall nobody had
    // measured). A rates row arriving with no `cause` therefore takes the honest
    // FALLBACK rather than any of these.
    case 'rates-shortfall':
      return {
        impact: t('checkRatesShortfallImpact'),
        action: t('checkRatesShortfallAction'),
      };
    case 'rates-unreadable':
      return {
        impact: t('checkRatesUnreadableImpact'),
        action: t('checkRatesUnreadableAction'),
      };
    case 'rates-mixed':
      return { impact: t('checkRatesMixedImpact'), action: t('checkRatesMixedAction') };
    case 'rates-none-readable':
      return {
        impact: t('checkRatesNoneReadableImpact'),
        action: t('checkRatesNoneReadableAction'),
      };
    case 'cameras':
      return { impact: t('checkCamerasImpact'), action: t('checkCamerasAction') };
    case 'monitor-link':
      return { impact: t('checkMonitorImpact'), action: t('checkMonitorAction') };
    case 'storage':
      return { impact: t('checkStorageImpact'), action: t('checkStorageAction') };
    case 'build':
    case 'Build':
      return { impact: t('checkBuildImpact'), action: t('checkBuildAction') };
    case 'recorder':
      return { impact: t('checkRecorderImpact'), action: t('checkRecorderAction') };
    default:
      return { impact: t('checkFallbackImpact'), action: t('checkFallbackAction') };
  }
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
      .filter((r) => r.status === 'check' || r.chip === 'CHECK')
      .filter(
        (r) =>
          !(
            uncapturedShown &&
            (r.id === 'required-data' || r.label === 'Required data')
          ),
      )
      .map((r) => ({
        id: r.id,
        label: r.label,
        value: r.value,
        chip: r.chip,
        tone: r.tone,
        cause: r.cause,
        // The cause wins where a row has one: it is the specific thing that
        // happened, and the label is only its heading. A cause with no entry
        // falls through to FALLBACK rather than to the label's wording, which
        // could describe a different cause entirely.
        ...copyFor(r.cause ?? r.id ?? r.label),
      }))
  );
}
