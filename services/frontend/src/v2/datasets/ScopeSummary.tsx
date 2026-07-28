// Bottom-pane SUMMARY view (2026-07-21 center-split round): a scope overview
// shown whenever no episode is selected. Scope = the selected (task, condition)
// group, else the whole filtered catalog. Everything is computed from real row
// fields (see data.ts aggregate/outcomeBreakdown).
//
// HONESTY: the success/failure donut is over LABELED rows only (task_result
// present); unlabeled rows are surfaced separately as "n without labels" and are
// NEVER folded into the rate or counted as successes. A scope with zero labeled
// rows shows a plain note instead of a fabricated 0% chart.
//
// Chart palette (dataviz skill): teal.600 = success, red.600 = failure — a 2-slot
// categorical palette validated by scripts/validate_palette.js on the light card
// surface (CVD ΔE 13.1 deutan, contrast >= 3:1, all six checks PASS), with direct
// labels + a 2px surface gap as the required secondary encoding. Quality uses the
// app's reserved status tones (green/amber/red), always paired with a text label.

import { cn } from '../../components/ui';
import { red, teal } from '../tokens';
import {
  formatBytes,
  formatCount,
  formatWhen,
  isMixedSchema,
  operatorSegment,
  outcomeBreakdown,
} from './data';
import type { GroupAggregate } from './data';
import type { ScopeSummary as Scope } from './useDatasetsState';

const NO_CONDITION_LABEL = '(no condition)';

/** Success/failure donut over labeled rows. Direct-labelled legend + centered
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
      aria-label={`Task outcome: ${pct}% success (${success} of ${labeled} labeled episodes)`}
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
          <span data-testid="dataset-success-rate" className="font-mono text-[26px] font-bold text-gray-900">
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

/** Topic-set (schema) section — the answer to "can these episodes convert into
 *  ONE training set?", which nothing in the UI used to state.
 *
 *  One set = a quiet confirmation line. More than one = the split is named.
 *  Rows without a signature are reported separately and never folded into
 *  either verdict.
 *
 *  The WARNING is scoped to a selected (task, condition) group, because that is
 *  the thing someone builds from. The whole-catalog view is expected to hold
 *  many topic sets — alarming there would train people to ignore the amber, so
 *  the catalog states the same fact neutrally. */
function SchemaSection({ agg, scopeKind }: { agg: GroupAggregate; scopeKind: Scope['kind'] }) {
  const mixed = isMixedSchema(agg);
  const known = agg.schemas.length > 0;
  const alarming = mixed && scopeKind === 'group';

  return (
    <div className="flex flex-col gap-1.5 border-t border-gray-100 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Topic set
      </span>

      {!known ? (
        <span data-testid="dataset-schema-unknown" className="text-[12px] text-gray-400">
          No topic signature recorded for these exports — the topic sets can&apos;t be
          compared.
        </span>
      ) : mixed ? (
        <div
          data-testid="dataset-schema-mixed"
          className={cn(
            'flex flex-col gap-2 rounded-[10px] border px-3 py-[10px]',
            alarming ? 'border-amber-200 bg-amber-50' : 'border-gray-100 bg-gray-50',
          )}
        >
          <span
            className={cn(
              'text-[12.5px] font-semibold',
              alarming ? 'text-amber-800' : 'text-gray-700',
            )}
          >
            {agg.schemas.length} different topic sets in this scope
          </span>
          <span
            className={cn(
              'text-[11.5px] leading-relaxed',
              alarming ? 'text-amber-900/80' : 'text-gray-500',
            )}
          >
            {alarming
              ? "These episodes don't share one observation/action space, so they can't be converted into a single training set. Filter or split the scope before building."
              : 'The catalog spans several observation/action spaces — expected here. Select a task / condition to check whether that group is uniform.'}
          </span>
          <ul className="flex flex-col gap-1">
            {agg.schemas.map((s) => (
              <li
                key={s.hash}
                data-testid={`dataset-schema-variant-${s.label}`}
                className={cn(
                  'flex flex-wrap items-center gap-x-2 text-[11.5px]',
                  alarming ? 'text-amber-900' : 'text-gray-600',
                )}
              >
                <span
                  className={cn(
                    'rounded-chip px-1.5 py-[1px] font-mono text-[10.5px] font-bold',
                    alarming ? 'bg-amber-200/70' : 'bg-gray-200/70',
                  )}
                >
                  {s.label}
                </span>
                <span>
                  {s.episodeCount} {s.episodeCount === 1 ? 'episode' : 'episodes'}
                </span>
                {s.topicCount !== null && (
                  <span className={alarming ? 'text-amber-900/70' : 'text-gray-400'}>
                    · {s.topicCount} topics
                  </span>
                )}
                <span
                  className={cn(
                    'font-mono text-[10.5px]',
                    alarming ? 'text-amber-900/60' : 'text-gray-400',
                  )}
                  title={s.hash}
                >
                  · {s.hash.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <span data-testid="dataset-schema-single" className="text-[12px] text-gray-600">
          1 topic set
          {agg.schemas[0]!.topicCount !== null && ` · ${agg.schemas[0]!.topicCount} topics`}
          <span className="ml-1.5 font-mono text-[10.5px] text-gray-400" title={agg.schemas[0]!.hash}>
            {agg.schemas[0]!.hash.slice(0, 8)}
          </span>
        </span>
      )}

      {known && agg.schemaUnknown > 0 && (
        <span data-testid="dataset-schema-unsigned" className="text-[11.5px] text-gray-400">
          {agg.schemaUnknown} without a topic signature — excluded from this comparison.
        </span>
      )}
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] border border-gray-100 px-[12px] py-[9px]">
      <span className="font-mono text-[16px] font-semibold text-gray-900">{value}</span>
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

  return (
    <div data-testid="dataset-scope-summary" className="flex min-w-0 flex-col gap-4 px-[18px] py-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Summary
        </span>
        <span data-testid="dataset-summary-scope" className="text-[15px] font-bold text-gray-900">
          {scope.label}
        </span>
        {scope.kind === 'group' && (
          <span className="text-[12px] text-gray-500">
            · {scope.condition ?? NO_CONDITION_LABEL}
          </span>
        )}
        <span className="text-[11.5px] text-gray-400">
          {scope.kind === 'catalog'
            ? 'across the filtered catalog'
            : 'for this task / condition'}
        </span>
      </div>

      {agg.episodeCount === 0 ? (
        <p data-testid="dataset-summary-empty" className="text-[13px] text-gray-400">
          No datasets in this scope yet.
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
                No task-result labels in this scope yet — there&apos;s no success/failure rate
                to chart.
              </p>
            )}

            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3" data-testid="dataset-summary-stats">
              <StatTile value={formatCount(agg.episodeCount)} label="episodes" />
              <StatTile value={formatCount(agg.setCount)} label="sets" />
              <StatTile value={operatorSegment(agg).text} label="operators" />
              <StatTile value={formatBytes(agg.totalBytes)} label="total size" />
              <StatTile value={formatCount(agg.totalMessages)} label="messages" />
              <StatTile value={formatWhen(agg.lastExportedAt).split(',')[0] ?? '—'} label="last exported" />
            </div>
          </div>

          <SchemaSection agg={agg} scopeKind={scope.kind} />

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
                <QualityDot tone="bg-amber-600" label="Needs review" count={agg.qualityNeedsReview} />
                <QualityDot tone="bg-red-600" label="Not usable" count={agg.qualityNotUsable} />
              </div>
            ) : (
              <span className="text-[12px] text-gray-400">No quality labels in this scope.</span>
            )}
            {outcome.unlabeled > 0 && (
              <span data-testid="dataset-summary-unlabeled" className="text-[11.5px] text-gray-400">
                {outcome.unlabeled} without labels — excluded from the success rate (not counted
                as successes).
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
