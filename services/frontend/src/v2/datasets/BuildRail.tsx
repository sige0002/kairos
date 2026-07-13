// Right column, three blocks:
//   1. Export recordings (ExportRecordings) — the REAL working path: move a
//      completed recording into the dataset tree (POST /datasets/export[-all]).
//   2. Selected dataset — its real export provenance (run/state/exported-at,
//      from the same GET /api/v1/datasets/{operator}/{task}/{index} the center
//      column reads).
//   3. Build (Phase 2 mock) — there is no backend endpoint yet for building a
//      LeRobot v3 artifact from a recipe, so "Build dataset" only explains that
//      (no fake progress animation — see the 2026-07-13 user directive that
//      dropped it along with the fabricated PickPlace_* recipe rows).

import { ExportRecordings } from './ExportRecordings';
import { formatWhen } from './data';
import type { DatasetsState } from './useDatasetsState';

export function BuildRail({ state }: { state: DatasetsState }) {
  const { selected, detail, detailLoading, detailError } = state;

  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="border-b border-gray-100 px-[18px] py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Export &amp; build
        </span>
      </div>

      {/* Real working path: move completed recordings into the dataset tree. */}
      <div className="border-b border-gray-100 px-[18px] py-[14px]">
        <ExportRecordings />
      </div>

      <div className="flex flex-col gap-[11px] px-[18px] py-[14px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Selected dataset
        </span>
        {!selected ? (
          <span className="text-[12.5px] text-gray-400">
            Select a dataset to see its export details.
          </span>
        ) : detailLoading ? (
          <span className="text-[12.5px] text-gray-400">Loading…</span>
        ) : detailError ? (
          <span className="text-[12.5px] text-amber-600">Couldn&apos;t load export details.</span>
        ) : detail ? (
          <div data-testid="export-details" className="flex flex-col gap-[11px]">
            <Row label="Run" value={detail.run_id ?? '—'} />
            <Row label="State" value={detail.state ?? '—'} />
            <Row label="Exported" value={formatWhen(detail.exported_at)} />
          </div>
        ) : null}

        <div className="mt-1 flex items-center gap-2 border-t border-gray-100 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Build
          </span>
          <span className="rounded-chip bg-amber-100 px-2 py-[2px] text-[10px] font-bold text-amber-700">
            Phase 2 · pending
          </span>
        </div>
        <button
          type="button"
          data-testid="build-dataset-btn"
          onClick={state.toastBuild}
          className="h-11 rounded-[11px] bg-teal-600 text-sm font-bold text-white shadow-btn hover:bg-teal-700"
        >
          Build dataset (LeRobot v3)
        </button>
        <span className="text-center text-[11.5px] leading-relaxed text-gray-400">
          Recipe-based builds convert matching episodes into a versioned LeRobot v3 artifact — this
          arrives with the Phase 2 recipe/episode model. Not wired to a backend yet.
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12.5px] text-gray-500">{label}</span>
      <div className="flex-1 border-b border-dotted border-gray-200" />
      <span className="font-mono text-[12.5px] font-medium text-gray-900">{value}</span>
    </div>
  );
}
