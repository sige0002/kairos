// Params column (inner-left, 300px): the REAL schema-driven PipelineForm and
// target-run picker, submitting an actual /jobs POST, plus the real one-click
// presets (GET /validation/presets) — each runs its pipeline over exactly the
// completed runs it hasn't validated yet (`pending_run_ids`).
import type { JSONSchema } from '../../schema/jsonSchema';
import type {
  BatchSummary,
  DatasetEntry,
  RunSummary,
  ValidationOption,
  ValidationPreset,
} from '../../api/types';
import { formatBatchLabel } from '../episodeChips';
import { PipelineForm } from '../../features/validation/PipelineForm';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge } from '../../components/ui';

export const ALL_RUNS = '__all__';
// A dataset target value: `dataset:<dataset_dir>`. Runs use the bare run_id.
export const DATASET_VALUE_PREFIX = 'dataset:';
// A batch target value: `batch:<batch_id>` — runs the pipeline over every
// still-present (unexported) run in that batch (the blast-radius check: verify
// a whole suspect batch in one click).
export const BATCH_VALUE_PREFIX = 'batch:';

const SELECT_CLASS =
  'rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none';

/** A dataset option label: `MM/DD · #seq · task` when labeled, else its path. */
function datasetOptionLabel(d: DatasetEntry): string {
  if (d.batch_seq != null) {
    const when = d.exported_at ? new Date(d.exported_at) : null;
    const md =
      when && !Number.isNaN(when.getTime())
        ? `${String(when.getMonth() + 1).padStart(2, '0')}/${String(when.getDate()).padStart(2, '0')}`
        : null;
    return `${md ? `${md} · ` : ''}#${d.batch_seq} · ${d.task}`;
  }
  return `${d.operator}/${d.task}/${d.index}`;
}

export function ParamsPanel({
  schema,
  params,
  onParamsChange,
  templateOptions,
  runs,
  runsLoading,
  datasets,
  datasetsLoading,
  batches,
  batchRunCount,
  targetRunId,
  onTargetRunChange,
  applicabilityNote,
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
  datasets: DatasetEntry[];
  datasetsLoading: boolean;
  /** Batches with at least one episode (newest first). */
  batches: BatchSummary[];
  /** How many of a batch's runs are still present (validatable) — 0 disables. */
  batchRunCount: (b: BatchSummary) => number;
  targetRunId: string;
  onTargetRunChange: (id: string) => void;
  /** Set when the selected pipeline can't run on the selected target type. */
  applicabilityNote?: string;
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
        <span className="text-[11px] font-medium text-gray-500">Target</span>
        <select
          aria-label="target"
          value={targetRunId}
          onChange={(e) => onTargetRunChange(e.target.value)}
          disabled={running}
          className={SELECT_CLASS}
        >
          <option value="">
            {runsLoading || datasetsLoading ? 'Loading…' : '— Select —'}
          </option>
          <optgroup label="Runs (before export)">
            {runs.length === 0 ? (
              <option value="" disabled>
                No completed runs
              </option>
            ) : (
              <>
                <option value={ALL_RUNS}>— All completed runs ({runs.length}) —</option>
                {runs.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {r.run_id}
                  </option>
                ))}
              </>
            )}
          </optgroup>
          <optgroup label="Batches (validate every run of a batch)">
            {batches.length === 0 ? (
              <option value="" disabled>
                No batches with unexported runs
              </option>
            ) : (
              batches.map((b) => {
                const n = batchRunCount(b);
                return (
                  <option
                    key={b.batch_id}
                    value={`${BATCH_VALUE_PREFIX}${b.batch_id}`}
                    disabled={n === 0}
                  >
                    {formatBatchLabel(b.batch_seq, b.created_at)} · {b.task}
                    {n === 0 ? ' (all exported)' : ` (${n} runs)`}
                  </option>
                );
              })
            )}
          </optgroup>
          <optgroup label="Datasets (exported)">
            {datasets.length === 0 ? (
              <option value="" disabled>
                No exported datasets
              </option>
            ) : (
              datasets.map((d) => (
                <option
                  key={d.dataset_dir}
                  value={`${DATASET_VALUE_PREFIX}${d.dataset_dir}`}
                >
                  {datasetOptionLabel(d)}
                </option>
              ))
            )}
          </optgroup>
        </select>
        {applicabilityNote && (
          <span className="text-[11px] text-amber-700">{applicabilityNote}</span>
        )}
        <span className="text-[11px] text-gray-400">
          Validation only — export stays in Review.
        </span>
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
            <span className="font-mono">
              config/&lt;robot&gt;/validation_presets.yaml
            </span>
            .
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
