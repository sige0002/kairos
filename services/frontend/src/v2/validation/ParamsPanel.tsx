// Params column (inner-left, 300px): the REAL schema-driven PipelineForm and
// target-run picker, submitting an actual /jobs POST, plus the real one-click
// presets (GET /validation/presets) — each runs its pipeline over exactly the
// completed runs it hasn't validated yet (`pending_run_ids`).
import type { JSONSchema } from '../../schema/jsonSchema';
import type { RunSummary, ValidationOption, ValidationPreset } from '../../api/types';
import { PipelineForm } from '../../features/validation/PipelineForm';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge } from '../../components/ui';

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
  presets,
  presetsLoading,
  onRunPreset,
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
  presets: ValidationPreset[];
  presetsLoading: boolean;
  onRunPreset: (preset: ValidationPreset) => void;
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

      {/* Real one-click presets (GET /validation/presets): each runs its own
          pipeline over exactly the completed runs it hasn't validated yet. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-gray-700">One-click presets</span>
        {presetsLoading ? (
          <p className="text-[11px] text-gray-400">Loading presets…</p>
        ) : presets.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-gray-400">
            No presets configured. Add{' '}
            <span className="font-mono">config/&lt;robot&gt;/validation_presets.yaml</span>.
          </p>
        ) : (
          presets.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`preset-${p.id}`}
              disabled={p.pending === 0 || running}
              onClick={() => onRunPreset(p)}
              title={p.description || undefined}
              className="flex items-center gap-2 rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-left hover:border-teal-400 hover:bg-teal-50/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-gray-700">
                  {p.name}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-gray-400">
                  {p.pipeline}
                </span>
              </span>
              <Badge tone={p.pending > 0 ? 'teal' : 'gray'} dot={p.pending > 0}>
                {p.pending > 0 ? `${p.pending} pending` : 'up to date'}
              </Badge>
            </button>
          ))
        )}
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
