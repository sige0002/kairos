// Left column: dataset catalog. Selecting a card switches the center/right
// columns' content (useDatasetsState owns the selection).

import { Badge, cn } from '../../components/ui';
import type { DatasetsState } from './useDatasetsState';

export function DatasetList({ state }: { state: DatasetsState }) {
  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-4 py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Datasets
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="new-dataset-btn"
          onClick={state.toastNewDataset}
          className="rounded-chip bg-teal-600 px-[11px] py-[5px] text-xs font-bold text-white hover:bg-teal-700"
        >
          + New
        </button>
      </div>
      <div className="flex flex-col gap-[7px] p-3">
        {state.datasets.map((d, i) => {
          const selected = i === state.selectedIndex;
          return (
            <div
              key={d.name}
              data-testid={`dataset-card-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => state.select(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') state.select(i);
              }}
              className={cn(
                'flex cursor-pointer flex-col gap-[5px] rounded-[11px] border px-[13px] py-[11px]',
                selected ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
              )}
            >
              <span className="text-[13px] font-semibold text-gray-900">{d.name}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11.5px] text-gray-500">{d.eps} episodes</span>
                <div className="flex-1" />
                <Badge tone={selected ? 'teal' : 'gray'}>{d.ver}</Badge>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
