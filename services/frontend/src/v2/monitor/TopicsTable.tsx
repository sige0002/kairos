// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Topics table (below the frequency chart): real per-topic health rows,
// merging ROS graph discovery with the live SSE metrics snapshot — same data
// source as the old Monitor/Live-tab table (src/features/monitor/useMonitorRows.ts).
// Two independent, separate click targets per row:
//   • the leftmost "Rec" checkbox picks the topic set for the NEXT recording
//     start (v1 LiveTab semantics — never affects a capture already running);
//     it drives the shared uiStore recordSelected set (a Collect-side start reads
//     the same fields). Clicking it does NOT touch the chart selection.
//   • clicking anywhere else on the row TOGGLES the topic in/out of the chart's
//     overlaid set (v1 Graph parity); charted rows carry a swatch in their
//     series colour and are highlighted.

import { useMemo, useState } from 'react';
import {
  formatBandwidth,
  formatBaseline,
  formatGap,
  rowTone,
  type MonitorRow,
} from '../../features/monitor/useMonitorRows';
import { Badge, Card, cn } from '../../components/ui';
import { useUiStore } from '../../store/uiStore';
import { MAX_SERIES, paletteColor } from './chartSeries';
import { useTranslation } from 'react-i18next';

// Rec checkbox + the original six metric columns (leading 34px is the Rec cell).
const GRID_COLS = 'grid-cols-[34px_1fr_84px_84px_96px_84px_96px]';

// TopicStatus -> the mock's short chip words (only OK / CHECK appear in the
// mock's sample rows; DANGER / SILENT / — extend it to the backend's full enum).
export function TopicsTable({
  rows,
  isDiscovering,
  chartedTopics,
  onToggle,
  recordSelected = new Set<string>(),
  onToggleRec = () => {},
}: {
  rows: MonitorRow[];
  isDiscovering: boolean;
  /** Ordered set of topics currently overlaid on the chart; index → series colour. */
  chartedTopics: string[];
  onToggle: (name: string) => void;
  /** Topics checked for the NEXT recording start (shared uiStore recordSelected). */
  recordSelected?: Set<string>;
  /** Toggle a topic in/out of the next-recording set (uiStore toggleRecordTopic). */
  onToggleRec?: (name: string) => void;
}) {
  const { t } = useTranslation('monitor');
  const baselineLabels = {
    learning: t('baseline.learning'),
    baseline: t('baseline.default'),
    unstable: t('baseline.unstable'),
  };
  const statusKeys = {
    ok: 'topics.ok',
    warning: 'topics.warning',
    danger: 'topics.danger',
    inactive: 'topics.inactive',
    unknown: 'topics.unknown',
  } as const;
  const statusLabel = (row: MonitorRow) =>
    row.measured ? t(statusKeys[row.status ?? 'unknown']) : t('topics.unknown');
  // Robot-edge reachability (same idiom as GraphTab's GraphPanel): explain an
  // empty table instead of just... being empty (honesty principle).
  const monitorBridge = useUiStore((s) => s.monitorBridge);
  const atCap = chartedTopics.length >= MAX_SERIES;
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = useMemo(
    () =>
      normalizedQuery
        ? rows.filter((row) => row.name.toLowerCase().includes(normalizedQuery))
        : rows,
    [normalizedQuery, rows],
  );

  return (
    <Card
      data-testid="topics-table"
      className="flex max-h-[270px] shrink-0 flex-col lg:min-h-[270px] lg:max-h-none lg:flex-[1_1_0%]"
    >
      <div className="border-b border-border px-[18px] py-2">
        <input
          type="search"
          aria-label={t('topics.searchLabel')}
          data-testid="topics-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('topics.searchPlaceholder')}
          className="h-8 w-full rounded-control border border-border bg-surface px-3 font-mono text-[12px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-focus"
        />
      </div>
      <div
        className={cn(
          'grid gap-2 border-b border-border px-[18px] py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted',
          GRID_COLS,
        )}
      >
        <span title={t('topics.includeNext')}>{t('topics.rec')}</span>
        <span>{t('topics.topic')}</span>
        <span>Hz</span>
        <span>{t('topics.expected')}</span>
        <span>{t('topics.bandwidth')}</span>
        <span>{t('topics.maxGap')}</span>
        <span>{t('topics.status')}</span>
      </div>
      {atCap && (
        <p
          data-testid="topics-table-cap"
          className="border-b border-status-warning-border bg-status-warning-bg px-[18px] py-1 text-[10.5px] text-status-warning-text"
        >
          {t('topics.chartCap', {
            current: String(MAX_SERIES),
            max: String(MAX_SERIES),
          })}
        </p>
      )}
      <div className="overflow-auto">
        {isDiscovering ? (
          <p className="px-[18px] py-6 text-center text-xs text-text-muted">
            {t('topics.discovering')}
          </p>
        ) : rows.length === 0 ? (
          <p
            data-testid="topics-table-empty"
            className="px-[18px] py-6 text-center text-xs text-text-muted"
          >
            {monitorBridge === 'down' ? t('topics.offline') : t('topics.none')}
          </p>
        ) : filteredRows.length === 0 ? (
          <p
            data-testid="topics-table-no-results"
            className="px-[18px] py-6 text-center text-xs text-text-muted"
          >
            {t('topics.noMatch', { query: query.trim() })}
          </p>
        ) : (
          filteredRows.map((row) => {
            const chartIdx = chartedTopics.indexOf(row.name);
            const charted = chartIdx >= 0;
            const recChecked = recordSelected.has(row.name);
            return (
              // The row is the chart-toggle target (a div-as-button, since it
              // hosts an interactive checkbox — a checkbox nested in a real
              // <button> is invalid). The Rec checkbox is a sibling grid cell
              // that stops click propagation, so the two targets never overlap.
              <div
                key={row.name}
                role="button"
                tabIndex={0}
                data-testid={`topic-row-${row.name}`}
                aria-pressed={charted}
                onClick={() => onToggle(row.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onToggle(row.name);
                  }
                }}
                className={cn(
                  'grid w-full cursor-pointer items-center gap-2 border-b border-border px-[18px] py-2 text-left transition-colors hover:bg-surface-muted',
                  GRID_COLS,
                  charted && 'bg-interaction-selected hover:bg-interaction-selected',
                )}
              >
                <span className="flex items-center">
                  <input
                    type="checkbox"
                    data-testid={`rec-check-${row.name}`}
                    aria-label={t('topics.recordTopic', { topic: row.name })}
                    checked={recChecked}
                    // Keep the checkbox click from bubbling to the row's
                    // chart-toggle handler (separate targets).
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onToggleRec(row.name)}
                    className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border"
                    style={
                      charted
                        ? {
                            background: paletteColor(chartIdx),
                            borderColor: paletteColor(chartIdx),
                          }
                        : {
                            background: 'transparent',
                            borderColor: 'rgb(var(--color-border-default))',
                          }
                    }
                  />
                  <span className="truncate font-mono text-[12.5px] text-text-primary">
                    {row.name}
                  </span>
                </span>
                <span className="font-mono text-[12.5px] text-text-primary">
                  {row.hz != null ? row.hz.toFixed(1) : '—'}
                </span>
                <span className="font-mono text-[12.5px] text-text-muted">
                  {row.expected_hz != null
                    ? row.expected_hz
                    : (formatBaseline(row, baselineLabels) ?? '—')}
                </span>
                <span className="font-mono text-[12.5px] text-text-primary">
                  {formatBandwidth(row.bandwidth_bps)}
                </span>
                <span className="font-mono text-[12.5px] text-text-primary">
                  {formatGap(row)}
                </span>
                <Badge tone={rowTone(row)}>{statusLabel(row)}</Badge>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
