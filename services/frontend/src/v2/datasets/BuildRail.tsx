// Right column: recipe & output summary plus the build/rebuild actions.
// "Build" is a mock progress animation (see useDatasetsState) — the actual
// LeRobot v3 conversion has no backend yet.

import { recipeRows } from './data';
import type { DatasetsState } from './useDatasetsState';

export function BuildRail({ state }: { state: DatasetsState }) {
  const rows = recipeRows(state.ds);
  return (
    <div className="flex flex-col overflow-auto rounded-card border border-gray-200 bg-white shadow-card">
      <div className="border-b border-gray-100 px-[18px] py-[13px]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Recipe &amp; output
        </span>
      </div>
      <div className="flex flex-col gap-[11px] px-[18px] py-[14px]">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="text-[12.5px] text-gray-500">{r.label}</span>
            <div className="flex-1 border-b border-dotted border-gray-200" />
            <span className="font-mono text-[12.5px] font-medium text-gray-900">{r.value}</span>
          </div>
        ))}

        <div className="rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-[10px] text-xs leading-relaxed text-gray-500">
          Source episodes stay in Review — building a dataset never removes originals. Every episode
          links back to its MCAP.
        </div>

        {state.building ? (
          <div className="flex flex-col gap-1.5" data-testid="build-progress">
            <div className="flex text-xs text-gray-500">
              <span>Building…</span>
              <div className="flex-1" />
              <span className="font-mono font-semibold" data-testid="build-pct">
                {state.buildPct}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-sm bg-gray-100">
              <span
                className="block h-full rounded-sm bg-teal-600"
                style={{ width: `${state.buildPct}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              data-testid="build-dataset-btn"
              onClick={state.build}
              className="h-11 rounded-[11px] bg-teal-600 text-sm font-bold text-white shadow-btn hover:bg-teal-700"
            >
              Build dataset (LeRobot v3)
            </button>
            <span className="text-center text-[11.5px] leading-relaxed text-gray-400">
              Runs the external LeRobot v3 converter on all matching episodes and writes a new
              versioned artifact. Sources are never modified.
            </span>
          </>
        )}

        <button
          type="button"
          data-testid="rebuild-btn"
          onClick={state.toastRebuild}
          className="h-[38px] rounded-[10px] border border-gray-200 bg-white text-[13px] font-semibold text-gray-700 hover:bg-gray-50"
        >
          Rebuild as v2…
        </button>
      </div>
    </div>
  );
}
