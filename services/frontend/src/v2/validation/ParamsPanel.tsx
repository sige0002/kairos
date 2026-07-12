// Params column (inner-left, 300px): the REAL schema-driven PipelineForm and
// target-run picker, submitting an actual /jobs POST. The Preset row and Diff
// card are static mock decoration — named parameter *bundles* and version
// diffing are a Phase 2 concept (dora_plugins.md has no such endpoint yet);
// they render the design mock's illustrative content and do nothing.
import type { JSONSchema } from '../../schema/jsonSchema';
import type { RunSummary } from '../../api/types';
import type { ValidationOption } from '../../api/types';
import { PipelineForm } from '../../features/validation/PipelineForm';
import { ErrorMessage } from '../../components/ErrorMessage';

export const ALL_RUNS = '__all__';

const SELECT_CLASS =
  'rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none';

export function ParamsPanel({
  schema,
  params,
  onParamsChange,
  templateOptions,
  runs,
  runsLoading,
  targetRunId,
  onTargetRunChange,
  onRun,
  canRun,
  running,
  progressPct,
  progressLabel,
  onCompareRuns,
  submitError,
}: {
  schema: JSONSchema;
  params: Record<string, unknown>;
  onParamsChange: (next: Record<string, unknown>) => void;
  templateOptions: ValidationOption[];
  runs: RunSummary[];
  runsLoading: boolean;
  targetRunId: string;
  onTargetRunChange: (id: string) => void;
  onRun: () => void;
  canRun: boolean;
  running: boolean;
  progressPct: number;
  progressLabel: string;
  onCompareRuns: () => void;
  submitError?: unknown;
}) {
  return (
    <div className="flex flex-col gap-3 overflow-auto border-r border-gray-100 px-[18px] py-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        Parameters
      </span>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[11px] font-medium text-gray-500">Target run</span>
        <select
          aria-label="target run"
          value={targetRunId}
          onChange={(e) => onTargetRunChange(e.target.value)}
          disabled={running}
          className={SELECT_CLASS}
        >
          <option value="">
            {runsLoading ? 'Loading…' : runs.length ? '— Select —' : 'No completed runs'}
          </option>
          {runs.length > 0 && (
            <option value={ALL_RUNS}>— All completed runs ({runs.length}) —</option>
          )}
          {runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.run_id}
            </option>
          ))}
        </select>
      </label>

      <PipelineForm
        schema={schema}
        value={params}
        onChange={onParamsChange}
        templateOptions={templateOptions}
      />

      {/* Static mock: named parameter bundles aren't a backend concept yet. */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-gray-700">Preset</span>
        <div className="flex items-center rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-sm text-gray-700">
          tabletop-default
          <div className="flex-1" />
          <span className="text-[10px] text-gray-400">▾</span>
        </div>
      </div>
      {/* Static mock: parameter-diff-vs-previous-version isn't tracked yet. */}
      <div className="rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-[9px] text-[11.5px] leading-relaxed text-gray-500">
        Diff vs v1.2.0: <span className="font-mono text-teal-700">min_coverage 75 → 80</span>
      </div>

      <div className="flex-1" />

      {submitError != null && <ErrorMessage error={submitError} />}

      {running ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex text-xs text-gray-500">
            <span>{progressLabel}</span>
            <div className="flex-1" />
            <span className="font-mono font-semibold">{progressPct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <span
              className="block h-full rounded-full bg-teal-600 transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={!canRun}
          onClick={onRun}
          className="h-[42px] rounded-[10px] bg-teal-600 text-[13.5px] font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run on selection
        </button>
      )}

      <button
        type="button"
        onClick={onCompareRuns}
        className="h-9 rounded-[10px] border border-gray-200 bg-white text-[12.5px] font-semibold text-gray-500 hover:bg-gray-50"
      >
        Compare runs…
      </button>
    </div>
  );
}
