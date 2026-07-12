// Topics table (below the frequency chart): real per-topic health rows,
// merging ROS graph discovery with the live SSE metrics snapshot — same data
// source as the old Monitor/Live-tab table (src/features/monitor/useMonitorRows.ts).
// Clicking a row selects the topic the chart above plots.

import {
  formatBandwidth,
  formatBaseline,
  formatGap,
  rowTone,
  type MonitorRow,
} from '../../features/monitor/useMonitorRows';
import { Badge, Card, cn } from '../../components/ui';
import { useUiStore } from '../../store/uiStore';

const GRID_COLS = 'grid-cols-[1fr_84px_84px_96px_84px_96px]';

// TopicStatus -> the mock's short chip words (only OK / CHECK appear in the
// mock's sample rows; DANGER / SILENT / — extend it to the backend's full enum).
const STATUS_LABEL: Record<string, string> = {
  ok: 'OK',
  warning: 'CHECK',
  danger: 'DANGER',
  inactive: 'SILENT',
  unknown: '—',
};

function statusLabel(row: MonitorRow): string {
  return STATUS_LABEL[row.measured ? (row.status ?? 'unknown') : 'unknown']!;
}

export function TopicsTable({
  rows,
  isDiscovering,
  selectedTopic,
  onSelect,
}: {
  rows: MonitorRow[];
  isDiscovering: boolean;
  selectedTopic: string | null;
  onSelect: (name: string) => void;
}) {
  // Robot-edge reachability (same idiom as GraphTab's GraphPanel): explain an
  // empty table instead of just... being empty (honesty principle).
  const monitorBridge = useUiStore((s) => s.monitorBridge);

  return (
    <Card className="flex max-h-[270px] shrink-0 flex-col">
      <div
        className={cn(
          'grid gap-2 border-b border-gray-100 px-[18px] py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400',
          GRID_COLS,
        )}
      >
        <span>Topic</span>
        <span>Hz</span>
        <span>Expected</span>
        <span>Bandwidth</span>
        <span>Max gap</span>
        <span>Status</span>
      </div>
      <div className="overflow-auto">
        {isDiscovering ? (
          <p className="px-[18px] py-6 text-center text-xs text-gray-400">Discovering topics…</p>
        ) : rows.length === 0 ? (
          <p
            data-testid="topics-table-empty"
            className="px-[18px] py-6 text-center text-xs text-gray-400"
          >
            {monitorBridge === 'down'
              ? 'Robot offline — no topics discovered (the monitor on the robot side is unreachable).'
              : 'No topics discovered yet.'}
          </p>
        ) : (
          rows.map((row) => {
            const selected = row.name === selectedTopic;
            return (
              <button
                key={row.name}
                type="button"
                data-testid={`topic-row-${row.name}`}
                onClick={() => onSelect(row.name)}
                className={cn(
                  'grid w-full items-center gap-2 border-b border-gray-50 px-[18px] py-2 text-left transition-colors hover:bg-gray-50',
                  GRID_COLS,
                  selected && 'bg-teal-50 hover:bg-teal-50',
                )}
              >
                <span className="truncate font-mono text-[12.5px] text-gray-900">{row.name}</span>
                <span className="font-mono text-[12.5px] text-gray-700">
                  {row.hz != null ? row.hz.toFixed(1) : '—'}
                </span>
                <span className="font-mono text-[12.5px] text-gray-400">
                  {row.expected_hz != null ? row.expected_hz : (formatBaseline(row) ?? '—')}
                </span>
                <span className="font-mono text-[12.5px] text-gray-700">
                  {formatBandwidth(row.bandwidth_bps)}
                </span>
                <span className="font-mono text-[12.5px] text-gray-700">{formatGap(row)}</span>
                <Badge tone={rowTone(row)}>{statusLabel(row)}</Badge>
              </button>
            );
          })
        )}
      </div>
    </Card>
  );
}
