// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Left column: the real, enabled pipeline list (GET /pipelines). Each card shows
// only facts the server reports: the pipeline id and description. Lifecycle is
// deliberately absent until the backend owns that state.
import { Card, cn } from '../../components/ui';
import type { PipelineInfo } from '../../api/types';

export function PipelineRail({
  pipelines,
  selectedIndex,
  onSelect,
}: {
  pipelines: PipelineInfo[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <Card className="flex min-h-0 flex-col overflow-auto">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Pipelines
        </h2>
      </div>
      <div className="flex flex-col gap-[7px] p-3">
        {pipelines.length === 0 && (
          <p className="px-1 py-2 text-[11.5px] text-text-muted">
            No pipelines available.
          </p>
        )}
        {pipelines.map((p, i) => {
          const selected = i === selectedIndex;
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              data-testid={`pipeline-card-${p.id}`}
              onClick={() => onSelect(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(i);
              }}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-[11px] border p-[10px_13px] text-left',
                selected ? 'border-accent bg-interaction-selected' : 'border-border',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-semibold text-text-primary">
                  {p.id}
                </span>
              </div>
              {p.description && (
                <span
                  className="truncate text-[11.5px] text-text-muted"
                  title={p.description}
                >
                  {p.description}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-border px-4 py-[11px] text-[11.5px] leading-relaxed text-text-muted">
        This list shows pipelines enabled by the server. Lifecycle and promotion are not
        configured in this console.
      </div>
    </Card>
  );
}
