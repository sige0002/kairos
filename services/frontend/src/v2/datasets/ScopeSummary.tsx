// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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
import { useTranslation } from 'react-i18next';
import { red, teal } from '../tokens';
import {
  bytesSegment,
  formatBytes,
  formatCount,
  formatWhen,
  operatorSegment,
  outcomeBreakdown,
} from './data';
import { formatMemberLabel } from '../../i18n/format';
import type { DatasetAggregate } from './data';
import type { ScopeSummary as Scope } from './useDatasetsState';
import type { CaptureSearchQuery } from '../../api/types';

function SelectionQuerySummary({
  query,
}: {
  query: CaptureSearchQuery | null | undefined;
}) {
  const { t } = useTranslation('datasets');
  if (!query) return null;
  const parts: string[] = [];
  if (query.states?.length) {
    parts.push(t('selectionStates', { states: query.states.join(', ') }));
  }
  if (query.review_statuses?.length) {
    parts.push(t('selectionReview', { statuses: query.review_statuses.join(', ') }));
  }
  if (query.present_on_instance !== undefined && query.present_on_instance !== null) {
    parts.push(
      query.present_on_instance
        ? t('selectionPresentHere')
        : t('selectionNotPresentHere'),
    );
  }
  if (query.started_from || query.started_to) {
    parts.push(
      t('selectionRecordedRange', {
        from: query.started_from ?? '…',
        to: query.started_to ?? '…',
      }),
    );
  }
  if (query.exclude_dataset_id) {
    parts.push(t('selectionExcludingDataset', { id: query.exclude_dataset_id }));
  }
  if (query.predicates?.length) {
    const predicates = query.predicates
      .map(
        (predicate) => `${predicate.field} ${predicate.operator} “${predicate.value}”`,
      )
      .join(` ${(query.join ?? 'and').toUpperCase()} `);
    parts.push(t('selectionPredicates', { predicates }));
  }
  return <>{parts.length > 0 ? parts.join('; ') : t('allRecordings')}</>;
}

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
  const { t } = useTranslation('datasets');
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
      aria-label={t('outcomeAria', {
        percent: String(pct),
        success: String(success),
        labeled: String(labeled),
      })}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
          {fPct === 0 ? (
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={teal[600]}
              strokeWidth={stroke}
            />
          ) : sPct === 0 ? (
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={red[600]}
              strokeWidth={stroke}
            />
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
            className="font-mono text-[26px] font-bold text-text-primary"
          >
            {pct}%
          </span>
          <span className="text-[10.5px] uppercase tracking-[0.05em] text-text-muted">
            {t('success')}
          </span>
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11.5px] text-text-secondary">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden />
          ✓ {success} {t('success')}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm bg-status-danger-accent"
            aria-hidden
          />
          ✗ {failure} {t('failure')}
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
  const { t } = useTranslation('datasets');
  const { slices, awaiting, warn } = agg.availability;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {t('availabilityWhere')}
      </h3>

      {slices.length === 0 ? (
        <span
          data-testid="dataset-availability-empty"
          className="text-[12px] text-text-muted"
        >
          {t('availabilityEmpty')}
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
              className="flex items-center gap-1.5 text-[12px] text-text-secondary"
            >
              <Badge
                tone={slice.tone}
                dot
                title={slice.detail}
                className="whitespace-nowrap"
              >
                {slice.label}
              </Badge>
              {slice.count}
            </span>
          ))}
        </div>
      )}

      {awaiting > 0 && (
        <span
          data-testid="dataset-availability-awaiting"
          className="text-[11.5px] text-text-muted"
        >
          {t('availabilityAwaiting', { count: awaiting })}
        </span>
      )}
      {warn > 0 && (
        <span
          data-testid="dataset-availability-warn"
          className="text-[11.5px] font-semibold text-status-warning-text"
        >
          {t('availabilityWarn', { count: warn })}
        </span>
      )}
      {unresolved > 0 && (
        <span
          data-testid="dataset-availability-unresolved"
          className="text-[11.5px] font-semibold text-status-warning-text"
        >
          {t('availabilityUnresolved', { count: String(unresolved) })}
        </span>
      )}
    </div>
  );
}

function StatTile({
  value,
  label,
  title,
}: {
  value: string;
  label: string;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex flex-col gap-0.5 rounded-[10px] border border-border px-[12px] py-[9px]"
    >
      {/* Most values here are numbers, but "operator" puts a NAME in this slot
          and an operator id has no break opportunity — measured 360px outside
          the tile. `break-words` only breaks what cannot otherwise fit, so the
          numbers are untouched. */}
      <span className="break-words font-mono text-[16px] font-semibold text-text-primary">
        {value}
      </span>
      <span className="text-[11px] text-text-muted">{label}</span>
    </div>
  );
}

function QualityDot({
  tone,
  label,
  count,
}: {
  tone: string;
  label: string;
  count: number;
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${tone}`} aria-hidden />
      {label} {count}
    </span>
  );
}

export function ScopeSummary({ scope }: { scope: Scope }) {
  const { t } = useTranslation(['datasets', 'common']);
  const agg = scope.aggregate;
  const outcome = outcomeBreakdown(agg);
  const bytes = bytesSegment(agg);
  const selectionRecipes = scope.selectionRecipes ?? [];

  return (
    <div
      data-testid="dataset-scope-summary"
      className="flex min-w-0 flex-col gap-4 px-[18px] py-4"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('summary')}
        </h3>
        <span
          data-testid="dataset-summary-scope"
          className="text-[15px] font-bold text-text-primary"
        >
          {scope.label}
        </span>
        <span className="text-[11.5px] text-text-muted">
          {scope.kind === 'catalog' ? t('catalogScope') : t('datasetScope')}
        </span>
      </div>

      {agg.memberCount === 0 ? (
        <p data-testid="dataset-summary-empty" className="text-[13px] text-text-muted">
          {t('noMembersScope')}
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
                className="max-w-[190px] text-[12.5px] leading-relaxed text-text-muted"
              >
                {t('noTaskResults')}
              </p>
            )}

            <div
              className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3"
              data-testid="dataset-summary-stats"
            >
              <StatTile
                value={formatCount(agg.memberCount)}
                label={formatMemberLabel(agg.memberCount)}
              />
              <StatTile
                value={formatCount(agg.availability.usable)}
                label={t('readableHere')}
              />
              <StatTile
                value={bytes ? bytes.text : '—'}
                label={t('totalSize')}
                title={bytes?.title ?? t('noMemberSize')}
              />
              <StatTile
                value={agg.messages.known > 0 ? formatCount(agg.messages.total) : '—'}
                label={t('messages')}
                title={
                  agg.messages.known > 0
                    ? t('totalMessages', { count: agg.messages.known })
                    : t('noMemberMessages')
                }
              />
              <StatTile value={operatorSegment(agg).text} label={t('operators')} />
              <StatTile
                value={formatWhen(agg.lastRecordedAt).split(',')[0] ?? '—'}
                label={t('lastRecorded')}
              />
            </div>
          </div>

          <AvailabilitySection agg={agg} unresolved={scope.unresolved} />

          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
              {t('recordedConditions')}
            </h3>
            <div
              data-testid="dataset-summary-conditions"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-secondary"
            >
              {scope.conditions.labels.map(({ value, count }) => (
                <span key={value}>
                  {value}: {count}
                </span>
              ))}
              {scope.conditions.notRecorded > 0 && (
                <span>
                  {t('notRecordedCount', { count: scope.conditions.notRecorded })}
                </span>
              )}
              {scope.conditions.unavailable > 0 && (
                <span>
                  {t('unavailableCount', { count: scope.conditions.unavailable })}
                </span>
              )}
            </div>
          </div>

          {scope.kind === 'dataset' && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                {t('selectionHistory')}
              </h3>
              {selectionRecipes.length === 0 ? (
                <span
                  data-testid="dataset-selection-recipes-empty"
                  className="text-[12px] text-text-muted"
                >
                  {t('noSelectionRecipe')}
                </span>
              ) : (
                <ul
                  data-testid="dataset-selection-recipes"
                  className="space-y-1 text-[12px] text-text-secondary"
                >
                  {selectionRecipes.map((recipe) => (
                    <li key={recipe.recipe_id}>
                      {formatWhen(recipe.recorded_at)} — {recipe.join.toUpperCase()}{' '}
                      {recipe.conditions.length === 0
                        ? t('allRecordings')
                        : recipe.conditions
                            .map(
                              (condition) =>
                                `${condition.field} ${condition.operator} “${condition.value}”`,
                            )
                            .join(` ${recipe.join.toUpperCase()} `)}
                      {'; '}{' '}
                      {t('selectionRecipe', {
                        added: String(recipe.succeeded),
                        failed: String(recipe.failed),
                        matched: String(recipe.matched),
                      })}
                      {recipe.bulk_run_id &&
                        `; ${t('selectionServerRun', { id: recipe.bulk_run_id })}${
                          recipe.attempt != null
                            ? `, ${t('selectionAttempt', { count: recipe.attempt })}`
                            : ''
                        }${recipe.cumulative ? ` ${t('selectionCumulativeReceipt')}` : ''}`}
                      {recipe.catalog_truncated && ` — ${t('selectionTruncated')}`}
                      {recipe.selection_query && (
                        <span
                          data-testid={`dataset-selection-query-${recipe.recipe_id}`}
                          className="mt-0.5 block break-words text-[11px] leading-relaxed text-text-muted"
                        >
                          {t('serverSelectionLabel')}{' '}
                          <SelectionQuerySummary query={recipe.selection_query} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
              {t('quality')}
            </h3>
            {agg.qualityLabeledCount > 0 ? (
              <div
                data-testid="dataset-summary-quality"
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-secondary"
              >
                <QualityDot
                  tone="bg-status-success-accent"
                  label={t('common:status.good')}
                  count={agg.qualityGood}
                />
                <QualityDot
                  tone="bg-status-warning-accent"
                  label={t('common:status.needsReview')}
                  count={agg.qualityNeedsReview}
                />
                <QualityDot
                  tone="bg-status-danger-accent"
                  label={t('common:status.notUsable')}
                  count={agg.qualityNotUsable}
                />
              </div>
            ) : (
              <span className="text-[12px] text-text-muted">
                {t('noQualityLabels')}
              </span>
            )}
            {outcome.unlabeled > 0 && (
              <span
                data-testid="dataset-summary-unlabeled"
                className="text-[11.5px] text-text-muted"
              >
                {t('unlabeledOutcome', { count: outcome.unlabeled })}
              </span>
            )}
            {agg.bytes.unknown > 0 && (
              <span
                data-testid="dataset-summary-sizeless"
                className="text-[11.5px] text-text-muted"
              >
                {t('unknownSize', {
                  unknown: String(agg.bytes.unknown),
                  total: formatBytes(agg.bytes.total),
                  known: String(agg.bytes.known),
                })}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
