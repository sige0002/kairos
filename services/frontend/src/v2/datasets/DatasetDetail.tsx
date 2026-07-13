// Center column: the selected dataset's real export metadata
// (GET /api/v1/datasets/{operator}/{task}/{index}) — messages/size/topics/
// files counts straight from the backend. The ①RECIPE/②BUILD/③ARTIFACT cards
// stay as explanatory copy for the Phase 2 recipe model (not data-bound);
// sections that model doesn't exist for yet (operator mix, condition
// coverage) render an honest note instead of a chart. See data.ts for the
// 2026-07-13 user directive that dropped the fabricated PickPlace_* catalog.

import { Badge } from '../../components/ui';
import { DatasetInspection } from './DatasetInspection';
import { formatBytes, formatCount, formatWhen } from './data';
import type { DatasetsState } from './useDatasetsState';

const INFO_CARDS = [
  { title: '① RECIPE', body: 'Define a query over Review: task, operators, conditions, adopted only…' },
  { title: '② BUILD', body: 'Matching episodes are converted from MCAP to LeRobot v3 format.' },
  { title: '③ ARTIFACT', body: 'A versioned, reproducible output — ready for training, traceable to source.' },
];

export function DatasetDetail({ state }: { state: DatasetsState }) {
  const { selected, detail, detailLoading, detailError } = state;

  return (
    <div className="flex min-w-0 flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
        {selected ? (
          <>
            <span data-testid="dataset-detail-name" className="text-[15px] font-bold text-gray-900">
              {selected.operator} / {selected.task}
            </span>
            <span data-testid="dataset-detail-index">
              <Badge tone="teal" mono>
                #{selected.index}
              </Badge>
            </span>
            <div className="flex-1" />
            <span className="text-xs text-gray-400">exported {formatWhen(selected.exported_at)}</span>
          </>
        ) : (
          <span data-testid="dataset-detail-name" className="text-[15px] font-semibold text-gray-400">
            No dataset selected
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4 px-[18px] py-4">
        <div className="grid grid-cols-3 gap-2">
          {INFO_CARDS.map((c) => (
            <div
              key={c.title}
              className="flex flex-col gap-[3px] rounded-[11px] border border-gray-100 bg-gray-50 px-[13px] py-[10px]"
            >
              <span className="text-[11px] font-bold text-teal-700">{c.title}</span>
              <span className="text-[11.5px] leading-[1.45] text-gray-500">{c.body}</span>
            </div>
          ))}
        </div>

        {!selected ? (
          <span className="text-[13px] text-gray-400">
            Select a dataset from the list to see its export details.
          </span>
        ) : detailLoading ? (
          <span className="text-sm text-gray-400">Loading dataset detail…</span>
        ) : detailError ? (
          <span className="text-sm text-amber-600">Couldn&apos;t load this dataset&apos;s detail.</span>
        ) : detail ? (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="dataset-grouped-by">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Grouped by
              </span>
              <Badge tone="teal">Operator: {detail.operator}</Badge>
              <Badge tone="teal">Task: {detail.task}</Badge>
            </div>

            <div className="grid grid-cols-4 gap-2" data-testid="dataset-stats">
              <Stat value={formatCount(detail.message_count)} label="messages" />
              <Stat value={formatBytes(detail.bytes)} label="size" />
              <Stat value={String(detail.topics.length)} label="topics" />
              <Stat value={String(detail.files.length)} label="files" />
            </div>

            <div
              data-testid="dataset-breakdown-note"
              className="rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-[10px] text-xs leading-relaxed text-gray-500"
            >
              Episode-level breakdowns (operator mix, condition coverage) aren&apos;t available yet
              — they require the Phase 2 recipe/episode model.
            </div>

            <div className="border-t border-gray-100 pt-4">
              <DatasetInspection detail={detail} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[11px] border border-gray-100 px-[14px] py-[11px]">
      <span className="font-mono text-[21px] font-semibold text-gray-900">{value}</span>
      <span className="text-[11.5px] text-gray-400">{label}</span>
    </div>
  );
}
