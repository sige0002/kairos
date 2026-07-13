// Left column: the real, enabled pipeline list (GET /pipelines). Each card shows
// the pipeline's real id + description, plus a client-side lifecycle chip (see
// lifecycle.ts — the orchestrator doesn't report a lifecycle yet).
import { Badge, Card, cn } from '../../components/ui';
import type { PipelineInfo } from '../../api/types';
import { lifecycleForIndex, lifecycleTone } from './lifecycle';

/** Whether each pipeline applies to the chosen target (index-aligned to `pipelines`). */
export interface PipelineApplicability {
  ok: boolean;
  note: string | null;
}

export function PipelineRail({
  pipelines,
  selectedIndex,
  onSelect,
  applicability,
  onNewRun,
}: {
  pipelines: PipelineInfo[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  /** Per-pipeline applicability to the current target; absent = all applicable. */
  applicability?: PipelineApplicability[];
  onNewRun: () => void;
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-auto">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Pipelines
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onNewRun}
          className="rounded-lg bg-teal-600 px-[11px] py-[5px] text-xs font-bold text-white hover:bg-teal-700"
        >
          + New run
        </button>
      </div>
      <div className="flex flex-col gap-[7px] p-3">
        {pipelines.length === 0 && (
          <p className="px-1 py-2 text-[11.5px] text-gray-400">No pipelines available.</p>
        )}
        {pipelines.map((p, i) => {
          const lifecycle = lifecycleForIndex(i);
          const selected = i === selectedIndex;
          const applies = applicability?.[i]?.ok ?? true;
          const note = applicability?.[i]?.note ?? null;
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={applies ? 0 : -1}
              aria-disabled={!applies}
              data-testid={`pipeline-card-${p.id}`}
              onClick={() => applies && onSelect(i)}
              onKeyDown={(e) => {
                if (applies && (e.key === 'Enter' || e.key === ' ')) onSelect(i);
              }}
              className={cn(
                'flex flex-col gap-1 rounded-[11px] border p-[10px_13px] text-left',
                selected ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
                applies ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold text-gray-900">
                  {p.id}
                </span>
                <div className="flex-1" />
                {note ? (
                  <Badge tone="gray">{note}</Badge>
                ) : (
                  <Badge tone={lifecycleTone(lifecycle)}>{lifecycle.toUpperCase()}</Badge>
                )}
              </div>
              {p.description && (
                <span className="truncate text-[11.5px] text-gray-400" title={p.description}>
                  {p.description}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-gray-100 px-4 py-[11px] text-[11.5px] leading-relaxed text-gray-400">
        Experimental results never feed Review automatically. Promote a Candidate to make it
        Standard.
      </div>
    </Card>
  );
}
