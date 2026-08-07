// Bottom-pane SUMMARY view: an overview of the current scope, shown whenever no
// member is selected. Scope = the selected dataset, else every member of every
// dataset in the list. Everything is computed from real capture fields (see
// data.ts aggregate/outcomeBreakdown).
//
// HONESTY: the success/failure donut is over LABELED members only (task_result
// present); unlabeled ones are surfaced separately as "n without labels" and are
// NEVER folded into the rate or counted as successes. A scope with zero labeled
// members shows a plain note instead of a fabricated 0% chart, and a total whose
// members did not all report the field says how many answered.
//
// Chart palette (dataviz skill): teal.600 = success, red.600 = failure — a 2-slot
// categorical palette validated by scripts/validate_palette.js on the light card
// surface (CVD ΔE 13.1 deutan, contrast >= 3:1, all six checks PASS), with direct
// labels + a 2px surface gap as the required secondary encoding. Quality and
// availability use the app's reserved status tones, always paired with a text
// label.

import { Badge } from '../../components/ui';
import { red, teal } from '../tokens';
import {
  bytesSegment,
  formatBytes,
  formatCount,
  formatWhen,
  memberCount,
  memberNoun,
  operatorSegment,
  outcomeBreakdown,
} from './data';
import type { DatasetAggregate } from './data';
import type { ScopeSummary as Scope } from './useDatasetsState';

/** Success/failure donut over labeled members. Direct-labelled legend + centered
 *  success rate; a 2px surface gap separates the two slices. */
function OutcomeDonut({
  success,
  failure,
  labeled,
  rate,
}: {
  success: number;
  failure: number;
  labeled: number;
  rate: number; // 0..1, caller guarantees labeled > 0
}) {
  const size = 132;
  const stroke = 20;
  const c = size / 2;
  const r = (size - stroke) / 2;
  const pct = Math.round(rate * 100);
  const sPct = rate * 100;
  const fPct = 100 - sPct;
  const gap = 2; // surface gap in pathLength(100) units

  return (
    <figure
      data-testid="dataset-outcome-donut"
      className="m-0 flex flex-col items-center gap-2"
      aria-label={`Task outcome: ${pct}% success (${success} of ${labeled} labeled members)`}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
          {fPct === 0 ? (
            <circle cx={c} cy={c} r={r} fill="none" stroke={teal[600]} strokeWidth={stroke} />
          ) : sPct === 0 ? (
            <circle cx={c} cy={c} r={r} fill="none" stroke={red[600]} strokeWidth={stroke} />
          ) : (
            <>
              <circle
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={teal[600]}
                strokeWidth={stroke}
                pathLength={100}
                strokeDasharray={`${Math.max(sPct - gap, 0.001)} 100`}
                transform={`rotate(-90 ${c} ${c})`}
              />
              <circle
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={red[600]}
                strokeWidth={stroke}
                pathLength={100}
                strokeDasharray={`${Math.max(fPct - gap, 0.001)} 100`}
                transform={`rotate(${-90 + sPct * 3.6} ${c} ${c})`}
              />
            </>
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            data-testid="dataset-success-rate"
            className="font-mono text-[26px] font-bold text-gray-900"
          >
            {pct}%
          </span>
          <span className="text-[10.5px] uppercase tracking-[0.05em] text-gray-400">success</span>
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11.5px] text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-600" aria-hidden />✓{' '}
          {success} success
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-600" aria-hidden />✗{' '}
          {failure} failure
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Where the members' BYTES are — the question a dataset cannot answer by itself,
 * because §6 made membership a claim about a capture rather than a copy of it.
 *
 * "not here yet" is stated as a normal state, not a fault: on a split deployment
 * the operator reviews before the bytes are pulled across (§12), so a dataset
 * that cites captures which have not landed is the expected order of events. The
 * states that DO need a look (missing, corrupt) are the only ones in amber.
 */
function AvailabilitySection({
  agg,
  unresolved,
}: {
  agg: DatasetAggregate;
  unresolved: number;
}) {
  const { slices, awaiting, warn } = agg.availability;

  return (
    <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Where the recordings are
      </span>

      {slices.length === 0 ? (
        <span data-testid="dataset-availability-empty" className="text-[12px] text-gray-400">
          No member capture is loaded, so nothing can be said about where the bytes
          are.
        </span>
      ) : (
        <div
          data-testid="dataset-availability"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          {slices.map((slice) => (
            <span
              key={slice.kind}
              data-testid={`dataset-availability-${slice.kind}`}
              className="flex items-center gap-1.5 text-[12px] text-gray-600"
            >
              <Badge tone={slice.tone} dot title={slice.detail} className="whitespace-nowrap">
                {slice.label}
              </Badge>
              {slice.count}
            </span>
          ))}
        </div>
      )}

      {awaiting > 0 && (
        <span data-testid="dataset-availability-awaiting" className="text-[11.5px] text-gray-500">
          {awaiting} of these have no local copy yet. On a split deployment the bytes
          are pulled after the review — expected, not a failure.
        </span>
      )}
      {warn > 0 && (
        <span
          data-testid="dataset-availability-warn"
          className="text-[11.5px] font-semibold text-amber-700"
        >
          {warn} need a look: the files vanished outside kairos, or a manifest cannot
          be read.
        </span>
      )}
      {unresolved > 0 && (
        <span
          data-testid="dataset-availability-unresolved"
          className="text-[11.5px] font-semibold text-amber-700"
        >
          {memberCount(unresolved)} {unresolved === 1 ? 'has' : 'have'} no capture row
          in the loaded catalog — nothing above describes {unresolved === 1 ? 'it' : 'them'}.
        </span>
      )}
    </div>
  );
}

function StatTile({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div
      title={title}
      className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-[12px] py-[9px]"
    >
      {/* Most values here are numbers, but "operator" puts a NAME in this slot
          and an operator id has no break opportunity — measured 360px outside
          the tile. `break-words` only breaks what cannot otherwise fit, so the
          numbers are untouched. */}
      <span className="break-words font-mono text-[16px] font-semibold text-gray-900">
        {value}
      </span>
      <span className="text-[11px] text-gray-400">{label}</span>
    </div>
  );
}

function QualityDot({ tone, label, count }: { tone: string; label: string; count: number }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${tone}`} aria-hidden />
      {label} {count}
    </span>
  );
}

export function ScopeSummary({ scope }: { scope: Scope }) {
  const agg = scope.aggregate;
  const outcome = outcomeBreakdown(agg);
  const bytes = bytesSegment(agg);

  return (
    <div data-testid="dataset-scope-summary" className="flex min-w-0 flex-col gap-4 px-[18px] py-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Summary
        </span>
        <span data-testid="dataset-summary-scope" className="text-[15px] font-bold text-gray-900">
          {scope.label}
        </span>
        <span className="text-[11.5px] text-gray-400">
          {scope.kind === 'catalog'
            ? 'every member, across the datasets in view'
            : 'for this dataset'}
        </span>
      </div>

      {agg.memberCount === 0 ? (
        <p data-testid="dataset-summary-empty" className="text-[13px] text-gray-400">
          No members in this scope yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            {outcome.labeled > 0 ? (
              <OutcomeDonut
                success={outcome.success}
                failure={outcome.failure}
                labeled={outcome.labeled}
                rate={outcome.successRate!}
              />
            ) : (
              <p
                data-testid="dataset-donut-empty"
                className="max-w-[190px] text-[12.5px] leading-relaxed text-gray-500"
              >
                No task-result labels in this scope yet — there&apos;s no success/failure
                rate to chart.
              </p>
            )}

            <div
              className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3"
              data-testid="dataset-summary-stats"
            >
              <StatTile
                value={formatCount(agg.memberCount)}
                label={memberNoun(agg.memberCount)}
              />
              <StatTile value={formatCount(agg.availability.usable)} label="readable here" />
              <StatTile
                value={bytes ? bytes.text : '—'}
                label="total size"
                title={bytes?.title ?? 'No member reports a size.'}
              />
              <StatTile
                value={agg.messages.known > 0 ? formatCount(agg.messages.total) : '—'}
                label="messages"
                title={
                  agg.messages.known > 0
                    ? `Total over the ${memberCount(agg.messages.known)} reporting a count.`
                    : 'No member reports a message count.'
                }
              />
              <StatTile value={operatorSegment(agg).text} label="operators" />
              <StatTile
                value={formatWhen(agg.lastRecordedAt).split(',')[0] ?? '—'}
                label="last recorded"
              />
            </div>
          </div>

          <AvailabilitySection agg={agg} unresolved={scope.unresolved} />

          <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Quality
            </span>
            {agg.qualityLabeledCount > 0 ? (
              <div
                data-testid="dataset-summary-quality"
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-600"
              >
                <QualityDot tone="bg-green-600" label="Good" count={agg.qualityGood} />
                <QualityDot
                  tone="bg-amber-600"
                  label="Needs review"
                  count={agg.qualityNeedsReview}
                />
                <QualityDot tone="bg-red-600" label="Not usable" count={agg.qualityNotUsable} />
              </div>
            ) : (
              <span className="text-[12px] text-gray-400">No quality labels in this scope.</span>
            )}
            {outcome.unlabeled > 0 && (
              <span data-testid="dataset-summary-unlabeled" className="text-[11.5px] text-gray-400">
                {outcome.unlabeled} without labels — excluded from the success rate (not
                counted as successes).
              </span>
            )}
            {agg.bytes.unknown > 0 && (
              <span data-testid="dataset-summary-sizeless" className="text-[11.5px] text-gray-400">
                {agg.bytes.unknown} report no size — {formatBytes(agg.bytes.total)} covers
                the other {agg.bytes.known}.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
