// The selected episode's detail — rendered BELOW the group's episode table
// inside the center column (2026-07-21 IA overhaul). Real export metadata
// (GET /api/v1/datasets/{operator}/{task}/{index}): messages/size/topics/files
// counts straight from the backend, the episode label chips when attributed, and
// the reused inspection (loss report / video check / JSON sidecars). Sections
// the Phase 2 recipe/episode model doesn't exist for yet (operator mix, condition
// coverage) render an honest note instead of a fabricated chart. The parent only
// mounts this when an episode is selected, so it assumes `selected` is present.

import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Modal, TrashIcon } from '../../components/ui';
import { EpisodeLabelChips } from '../episodeChips';
import { DatasetInspection } from './DatasetInspection';
import { formatBytes, formatCount, formatWhen } from './data';
import type { DatasetsState } from './useDatasetsState';

export function DatasetDetail({ state }: { state: DatasetsState }) {
  const { selected, detail, detailLoading, detailError } = state;

  return (
    <div className="flex min-w-0 flex-col gap-4 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span data-testid="dataset-detail-name" className="text-[15px] font-bold text-gray-900">
          {selected ? `${selected.operator} / ${selected.task}` : 'No dataset selected'}
        </span>
        {selected && (
          <>
            <span data-testid="dataset-detail-index">
              <Badge tone="teal" mono>
                #{selected.index}
              </Badge>
            </span>
            <div className="flex-1" />
            <span className="text-xs text-gray-400">
              exported {formatWhen(selected.exported_at)}
            </span>
            <button
              type="button"
              onClick={state.requestDelete}
              className="inline-flex shrink-0 items-center gap-1 rounded-control border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
            >
              <TrashIcon />
              Delete
            </button>
          </>
        )}
      </div>

      {detailLoading ? (
        <span className="text-sm text-gray-400">Loading dataset detail…</span>
      ) : detailError ? (
        <span className="text-sm text-amber-600">
          Couldn&apos;t load this dataset&apos;s detail.
        </span>
      ) : detail ? (
        <>
          <div className="flex flex-wrap items-center gap-2" data-testid="dataset-grouped-by">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Grouped by
            </span>
            <Badge tone="teal">Task: {detail.task}</Badge>
            <Badge tone="teal">Operator: {detail.operator}</Badge>
          </div>

          {/* Episode labels only when the backend attributes them (Phase 2
              join); nothing fabricated when absent. */}
          {detail.episode && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Episode
              </span>
              <EpisodeLabelChips
                episode={detail.episode}
                isoFallback={detail.exported_at}
                testId="dataset-detail-labels"
              />
            </div>
          )}

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
            Episode-level breakdowns (operator mix, condition coverage) aren&apos;t available
            yet — they require the Phase 2 recipe/episode model.
          </div>

          <div className="border-t border-gray-100 pt-4">
            <DatasetInspection detail={detail} />
          </div>
        </>
      ) : null}

      <Modal
        open={state.confirmingDelete}
        onClose={state.cancelDelete}
        title="Delete dataset"
        footer={
          <>
            <Button variant="ghost" onClick={state.cancelDelete} disabled={state.deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={state.confirmDelete} disabled={state.deleting}>
              {state.deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      >
        Permanently delete{' '}
        <span className="font-mono text-gray-800">
          {selected ? `${selected.operator}/${selected.task}/${selected.index}` : ''}
        </span>
        ? The exported files are removed from disk. This cannot be undone.
        {state.deleteError && (
          <div className="mt-2">
            <ErrorMessage error={state.deleteError} />
          </div>
        )}
      </Modal>
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
