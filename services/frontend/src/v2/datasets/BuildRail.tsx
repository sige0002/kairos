// Right column, three blocks:
//   1. Review pointer — recordings are reviewed AND exported in the Review tab
//      (the exception-review model bulk-exports the READY set in one click).
//      Datasets is a catalog only, so this rail just points there; there is no
//      per-run export path here anymore (it lived in the removed ExportRecordings
//      panel — Review is the single export surface).
//   2. Selected dataset — its real export provenance (run/state/exported-at,
//      from the same GET /api/v1/datasets/{operator}/{task}/{index} the center
//      column reads).
//   3. Build (Phase 2 mock) — there is no backend endpoint yet for building a
//      LeRobot v3 artifact from a recipe, so "Build dataset" only explains that
//      (quiet, de-emphasized styling — it is not a working control yet).

import { useUiStore } from '../../store/uiStore';
import { formatWhen } from './data';
import type { DatasetsState } from './useDatasetsState';

export function BuildRail({ state }: { state: DatasetsState }) {
  const { selected, detail, detailLoading, detailError } = state;
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="border-b border-gray-100 px-[18px] py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Export &amp; build
        </span>
      </div>

      {/* Review is the single export surface — point there, don't duplicate it. */}
      <div className="border-b border-gray-100 px-[18px] py-[14px]">
        <div
          data-testid="review-pointer"
          className="flex flex-col gap-2 rounded-[11px] border border-teal-100 bg-teal-50/60 px-[14px] py-[13px]"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-teal-700">
            Export recordings
          </span>
          <p className="text-[12.5px] leading-relaxed text-gray-600">
            Recordings are reviewed and exported in{' '}
            <span className="font-semibold text-teal-700">Review</span>: resolve the exceptions, then
            export the whole READY set in one click. Datasets is the catalog of what came out.
          </p>
          <button
            type="button"
            data-testid="go-to-review"
            onClick={() => setActiveTab('review')}
            className="h-9 self-start rounded-[10px] bg-teal-600 px-4 text-[13px] font-bold text-white shadow-btn hover:bg-teal-700"
          >
            Go to Review →
          </button>
        </div>
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

        {/* Phase 2 mock — quiet, clearly not a working control yet. */}
        <div className="mt-1 flex items-center gap-2 border-t border-gray-100 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-400">
            Build
          </span>
          <span className="rounded-chip bg-gray-100 px-2 py-[2px] text-[10px] font-semibold text-gray-500">
            Phase 2 · pending
          </span>
        </div>
        <button
          type="button"
          data-testid="build-dataset-btn"
          onClick={state.toastBuild}
          className="h-10 rounded-[10px] border border-dashed border-gray-300 bg-gray-50 text-[13px] font-semibold text-gray-500 hover:bg-gray-100"
        >
          Build dataset (LeRobot v3)
        </button>
        <span className="text-center text-[11px] leading-relaxed text-gray-400">
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
