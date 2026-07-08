// Validation tab (handoff "Validation"): runs a dora_runner pipeline against
// recordings. Everything is backend-driven so a new plugin needs no UI edit
// (see docs/specs/ja/dora_plugins.md §2.5):
//
//   - Pipeline select   <- GET /pipelines            (enabled pipelines)
//   - Params form        <- schemas.pipeline_forms    (per-pipeline JSON Schema)
//   - Result card        <- the job's summary.json     (generic SummaryResult)
//   - One-click presets  <- GET /validation/presets    (config-defined bundles)
//
// It runs against ONE run or a BATCH: the target select has "All completed runs",
// and each pre-defined validation preset runs over exactly the completed runs its
// pipeline has not validated yet (`pending_run_ids`). The bundled `fast_validation`
// keeps its bespoke required-topics card; everything else lands in SummaryResult.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import type {
  ConfigOptions,
  JobResult,
  JobStatus,
  Page,
  PipelineInfo,
  RunSummary,
  ValidationOption,
  ValidationPreset,
} from '../../api/types';
import { fetchRuntimeConfig } from '../../config';
import type { JSONSchema } from '../../schema/jsonSchema';
import { initialValueFor } from '../../schema/jsonSchema';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, SectionLabel, StatusDot } from '../../components/ui';
import type { Tone } from '../../components/ui';
import { PipelineForm } from './PipelineForm';
import { SummaryResult } from './SummaryResult';

const FAST_VALIDATION = 'fast_validation';
const ALL_RUNS = '__all__';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };

// Fallback schema used when the backend's pipeline_forms is unavailable (e.g.
// dora_runner down): the fast_validation form must still render its template
// select. Mirrors the orchestrator's static fallback.
const FALLBACK_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['template'],
  properties: { template: { type: 'string' } },
};

interface RequiredTopic {
  name: string;
  type?: string | null;
}

interface JobRef {
  run_id: string;
  job_id: string;
}

// A launched submission: one job (single run) or many (a batch / preset run).
interface ActiveRun {
  pipeline: string;
  jobs: JobRef[];
  // Present only for a single manual fast_validation run: its template's topics
  // drive the bespoke checklist. Absent -> the generic renderer is used.
  requiredTopics?: RequiredTopic[];
}

/** Poll a job to terminal, then fetch its result. Shared by the result cards. */
function useJobResult(jobId: string) {
  const statusQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, { signal }),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.state) ? false : 1500),
  });
  const terminal = !!statusQuery.data && TERMINAL.has(statusQuery.data.state);
  const resultQuery = useQuery({
    queryKey: queryKeys.jobResult(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobResult>(`/jobs/${encodeURIComponent(jobId)}/result`, { signal }),
    enabled: terminal,
  });
  return { statusQuery, terminal, resultQuery };
}

/** Invisible probe: reports a job's terminal state up (shares the status cache). */
function SettleProbe({ jobId, onSettled }: { jobId: string; onSettled: (id: string) => void }) {
  const { statusQuery, terminal } = useJobResult(jobId);
  useEffect(() => {
    if (terminal) onSettled(jobId);
  }, [terminal, jobId, onSettled]);
  void statusQuery;
  return null;
}

function RunningCard({ label }: { label: string }) {
  return (
    <Card className="p-[18px]">
      <p className="text-sm text-gray-500">{label}</p>
    </Card>
  );
}

/** Bespoke fast_validation card: required-topic checklist against the template. */
function ValidationResultCard({ jobId, required }: { jobId: string; required: RequiredTopic[] }) {
  const { statusQuery, terminal, resultQuery } = useJobResult(jobId);

  if (!terminal || resultQuery.isPending) {
    return (
      <RunningCard
        label={
          statusQuery.data?.state === 'running' || !terminal
            ? 'Running validation…'
            : 'Fetching result…'
        }
      />
    );
  }
  if (resultQuery.isError) return <ErrorMessage error={resultQuery.error} />;

  const summary = resultQuery.data.summary;
  const missing = summary.missing ?? [];
  const missingNames = new Set(missing.map((m) => m.name));
  const pass = summary.result === 'pass';
  // Prefer the template's full required list (so OK rows show too); fall back to
  // just the missing entries if the template wasn't resolvable.
  const rows: RequiredTopic[] = required.length > 0 ? required : missing;
  const found = Math.max(0, rows.length - missing.length);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Validation result</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {found}/{rows.length} required
        </span>
        <div className="flex-1" />
        <Badge tone={pass ? 'green' : 'red'} dot>
          {pass ? 'PASS' : 'FAIL'}
        </Badge>
      </div>
      <div className="px-[18px] py-1.5">
        <div className="grid grid-cols-[1fr_64px_44px] gap-3 border-b border-gray-100 py-2 text-[10px] uppercase tracking-[0.05em] text-gray-400">
          <span>Required topics</span>
          <span className="text-right">Expected</span>
          <span className="text-right">Result</span>
        </div>
        {rows.map((t) => {
          const ng = missingNames.has(t.name);
          return (
            <div
              key={t.name}
              className="grid grid-cols-[1fr_64px_44px] items-center gap-3 border-b border-gray-50 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StatusDot tone={ng ? 'red' : 'green'} />
                <span className="truncate font-mono text-[12.5px] text-gray-700" title={t.name}>
                  {t.name}
                </span>
              </span>
              <span className="truncate text-right font-mono text-[10.5px] text-gray-400">
                {t.type ?? 'any'}
              </span>
              <span
                className={`text-right font-mono text-[13px] font-semibold ${
                  ng ? 'text-red-600' : 'text-green-600'
                }`}
              >
                {ng ? '✕' : '✓'}
              </span>
            </div>
          );
        })}
      </div>
      {summary.extra && summary.extra.length > 0 && (
        <p className="px-[18px] py-2.5 font-mono text-[11px] text-gray-400">
          +{summary.extra.length} extra topics not required
        </p>
      )}
    </Card>
  );
}

/** Generic card for every non-fast_validation pipeline: renders summary.json. */
function GenericResultCard({ jobId, pipeline }: { jobId: string; pipeline: string }) {
  const { statusQuery, terminal, resultQuery } = useJobResult(jobId);

  if (!terminal || resultQuery.isPending) {
    return (
      <RunningCard
        label={
          statusQuery.data?.state === 'running' || !terminal ? 'Running…' : 'Fetching result…'
        }
      />
    );
  }
  if (resultQuery.isError) return <ErrorMessage error={resultQuery.error} />;

  return (
    <SummaryResult
      pipeline={pipeline}
      summary={resultQuery.data.summary}
      artifacts={resultQuery.data.artifacts}
    />
  );
}

/** Dispatch one job's detail card: fast_validation is bespoke, the rest generic. */
function JobDetail({ job, pipeline, requiredTopics }: { job: JobRef; pipeline: string; requiredTopics?: RequiredTopic[] }) {
  if (pipeline === FAST_VALIDATION && requiredTopics) {
    return <ValidationResultCard jobId={job.job_id} required={requiredTopics} />;
  }
  return <GenericResultCard jobId={job.job_id} pipeline={pipeline} />;
}

/** One row of a batch: run_id + live state, and PASS/FAIL once terminal. */
function BatchRow({
  job,
  selected,
  onSelect,
}: {
  job: JobRef;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { statusQuery, terminal, resultQuery } = useJobResult(job.job_id);
  const state = statusQuery.data?.state ?? 'queued';
  const result = terminal && !resultQuery.isError ? resultQuery.data?.summary.result : undefined;

  let tone: Tone = 'gray';
  let label: string = state;
  if (result === 'pass') {
    tone = 'green';
    label = 'PASS';
  } else if (result === 'fail' || state === 'failed') {
    tone = 'red';
    label = result === 'fail' ? 'FAIL' : 'FAILED';
  } else if (state === 'running') {
    tone = 'amber';
    label = 'RUNNING';
  } else if (state === 'succeeded') {
    tone = 'green';
    label = 'DONE';
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(job.job_id)}
      className={`flex w-full items-center gap-2.5 border-b border-gray-50 px-[18px] py-2.5 text-left last:border-b-0 hover:bg-gray-50 ${
        selected ? 'bg-teal-50/60' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-gray-700">
        {job.run_id}
      </span>
      <Badge tone={tone} dot={tone !== 'gray'}>
        {label}
      </Badge>
    </button>
  );
}

/** Batch list: one row per run, click a row to open its detail below. */
function BatchResults({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: JobRef[];
  selectedJobId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Batch</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">{jobs.length} runs</span>
      </div>
      {jobs.map((job) => (
        <BatchRow
          key={job.job_id}
          job={job}
          selected={job.job_id === selectedJobId}
          onSelect={onSelect}
        />
      ))}
    </Card>
  );
}

export function ValidationTab() {
  const queryClient = useQueryClient();
  const [pipeline, setPipeline] = useState(FAST_VALIDATION);
  const [runId, setRunId] = useState('');
  // User edits to the auto-rendered params form (merged over schema defaults).
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const isFastValidation = pipeline === FAST_VALIDATION;

  // Preselect a run parked by a Recordings-tab "Validate" deep-link, then clear
  // the marker so a later manual selection isn't overridden.
  const pendingRun = useUiStore((s) => s.pendingRun);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  useEffect(() => {
    if (pendingRun) {
      setRunId(pendingRun);
      setPendingRun(null);
    }
  }, [pendingRun, setPendingRun]);

  const runsQuery = useQuery({
    queryKey: queryKeys.runs(undefined),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 50 } }),
    placeholderData: keepPreviousData,
  });
  const runs = useMemo(
    () => (runsQuery.data?.items ?? []).filter((r) => r.state === 'completed'),
    [runsQuery.data],
  );

  // Available pipelines are backend-driven (GET /pipelines): every runnable
  // pipeline — bundled or a drop-in plugin — is selectable with no UI edit.
  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: ({ signal }) => apiGet<{ items: PipelineInfo[] }>('/pipelines', { signal }),
  });
  const pipelines = useMemo(
    () => (pipelinesQuery.data?.items ?? []).filter((p) => p.enabled),
    [pipelinesQuery.data],
  );

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  // Adapt the active robot's `validation` aspect options into the template shape
  // the fast_validation form consumes (id + name/version/required_topics).
  const templates: ValidationOption[] = (
    optionsQuery.data?.aspects?.validation?.options ?? []
  ).map((o) => ({
    id: o.id,
    name: o.meta.name ?? o.id,
    version: o.meta.version ?? 1,
    required_topics: o.meta.required_topics ?? [],
  }));

  // Track which launched jobs have reached a terminal state, so we can stop
  // polling presets and refresh their pending counts once a batch settles.
  const onSettled = useCallback((id: string) => {
    setSettled((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const allSettled = !active || active.jobs.every((j) => settled.has(j.job_id));
  useEffect(() => {
    if (active && allSettled) {
      queryClient.invalidateQueries({ queryKey: queryKeys.validationPresets });
      queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
    }
  }, [active, allSettled, queryClient]);

  // Pre-defined one-click validations (config-driven). Refresh their pending
  // counts while a batch is in flight, then stop.
  const presetsQuery = useQuery({
    queryKey: queryKeys.validationPresets,
    queryFn: ({ signal }) => apiGet<{ items: ValidationPreset[] }>('/validation/presets', { signal }),
    refetchInterval: active && !allSettled ? 3000 : false,
  });
  const presets = presetsQuery.data?.items ?? [];

  // Each pipeline's params form is backend-driven (GET /api/v1/config ->
  // schemas.pipeline_forms[<pipeline>]); fall back for fast_validation only.
  const configQuery = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });
  const schema: JSONSchema =
    configQuery.data?.schemas?.pipeline_forms?.[pipeline] ??
    (isFastValidation ? FALLBACK_SCHEMA : EMPTY_SCHEMA);

  // Effective form value = schema defaults, overlaid with user edits. A field
  // named `template` defaults to the active catalog selection when untouched.
  const seeded = useMemo(
    () => (initialValueFor(schema) as Record<string, unknown>) ?? {},
    [schema],
  );
  const params: Record<string, unknown> = { ...seeded, ...overrides };
  if (schema.properties?.template && !params.template) {
    params.template = optionsQuery.data?.aspects?.validation?.active || templates[0]?.id || '';
  }

  const activeTemplate = String(params.template ?? '');
  const requiredTopics =
    templates.find((t) => t.id === activeTemplate)?.required_topics ?? [];

  // Submit one or many jobs (a batch is just several /jobs calls; dora_runner
  // bounds real concurrency). Returns the ActiveRun so the left column renders.
  const submitMutation = useMutation({
    mutationFn: async (arg: {
      pipeline: string;
      params: Record<string, unknown>;
      runIds: string[];
      requiredTopics?: RequiredTopic[];
    }): Promise<ActiveRun> => {
      const jobs: JobRef[] = [];
      for (const rid of arg.runIds) {
        const job = await apiPost<JobStatus>('/jobs', {
          pipeline: arg.pipeline,
          run_id: rid,
          params: arg.params,
        });
        queryClient.setQueryData(queryKeys.job(job.job_id), job);
        jobs.push({ run_id: rid, job_id: job.job_id });
      }
      return { pipeline: arg.pipeline, jobs, requiredTopics: arg.requiredTopics };
    },
    onSuccess: (run) => {
      setSettled(new Set());
      setActive(run);
      setSelectedJobId(run.jobs[0]?.job_id ?? null);
    },
  });

  const runManual = () => {
    const runIds = runId === ALL_RUNS ? runs.map((r) => r.run_id) : [runId];
    submitMutation.mutate({
      pipeline,
      params,
      runIds,
      requiredTopics: isFastValidation ? requiredTopics : undefined,
    });
  };

  const runPreset = (preset: ValidationPreset) => {
    submitMutation.mutate({
      pipeline: preset.pipeline,
      params: preset.params ?? {},
      runIds: preset.pending_run_ids,
    });
  };

  const changePipeline = (next: string) => {
    setPipeline(next);
    setOverrides({});
  };

  const targetCount = runId === ALL_RUNS ? runs.length : runId ? 1 : 0;
  const canRun = targetCount > 0 && !submitMutation.isPending;
  const runLabel = submitMutation.isPending
    ? 'Starting…'
    : runId === ALL_RUNS
      ? `Run on all (${runs.length})`
      : isFastValidation
        ? 'Run validation'
        : 'Run pipeline';

  return (
    <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1.5fr_1fr]">
      {active && active.jobs.map((job) => (
        <SettleProbe key={`probe-${job.job_id}`} jobId={job.job_id} onSettled={onSettled} />
      ))}

      <section aria-label="validation result" className="flex flex-col gap-3">
        <SectionLabel>Validation</SectionLabel>
        {!active ? (
          <Card className="p-8 text-center text-sm text-gray-500">
            Run a pre-defined validation on the right, or pick a pipeline and target run.
          </Card>
        ) : active.jobs.length === 0 ? (
          <Card className="p-8 text-center text-sm text-gray-500">
            Nothing to run — every target is already validated.
          </Card>
        ) : active.jobs.length === 1 ? (
          <JobDetail job={active.jobs[0]!} pipeline={active.pipeline} requiredTopics={active.requiredTopics} />
        ) : (
          <>
            <BatchResults
              jobs={active.jobs}
              selectedJobId={selectedJobId}
              onSelect={setSelectedJobId}
            />
            {selectedJobId && (
              <JobDetail
                job={active.jobs.find((j) => j.job_id === selectedJobId) ?? active.jobs[0]!}
                pipeline={active.pipeline}
              />
            )}
          </>
        )}
      </section>

      <section aria-label="run validation" className="flex flex-col gap-3">
        <Card className="flex flex-col gap-3 p-[18px]">
          <SectionLabel>Pre-defined validations</SectionLabel>
          {presets.length === 0 ? (
            <p className="text-[11px] text-gray-400">
              No presets configured. Add <span className="font-mono">config/&lt;robot&gt;/validation_presets.yaml</span>.
            </p>
          ) : (
            presets.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={p.pending === 0 || submitMutation.isPending}
                onClick={() => runPreset(p)}
                title={p.description || undefined}
                className="flex items-center gap-2.5 rounded-control border border-gray-200 px-3 py-2 text-left hover:border-teal-400 hover:bg-teal-50/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-gray-700">{p.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-gray-400">{p.pipeline}</span>
                </span>
                <Badge tone={p.pending > 0 ? 'teal' : 'gray'} dot={p.pending > 0}>
                  {p.pending > 0 ? `${p.pending} pending` : 'up to date'}
                </Badge>
              </button>
            ))
          )}
        </Card>

        <Card className="flex flex-col gap-3 p-[18px]">
          <SectionLabel>Run pipeline</SectionLabel>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] font-medium text-gray-500">Pipeline</span>
            <select
              aria-label="pipeline"
              value={pipeline}
              onChange={(e) => changePipeline(e.target.value)}
              className="rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none"
            >
              {/* Keep fast_validation selectable even before /pipelines loads. */}
              {pipelines.length === 0 && <option value={FAST_VALIDATION}>{FAST_VALIDATION}</option>}
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                  {p.name && p.name !== p.id ? ` — ${p.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] font-medium text-gray-500">Target run</span>
            <select
              aria-label="run"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              className="rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none"
            >
              <option value="">
                {runsQuery.isPending ? 'Loading…' : runs.length ? '— Select —' : 'No completed runs'}
              </option>
              {runs.length > 0 && <option value={ALL_RUNS}>— All completed runs ({runs.length}) —</option>}
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
            onChange={setOverrides}
            templateOptions={templates}
          />
          {submitMutation.isError && <ErrorMessage error={submitMutation.error} />}
          <Button type="button" disabled={!canRun} onClick={runManual}>
            {runLabel}
          </Button>
        </Card>

        {active && active.jobs.length > 0 && (
          <Card className="p-[18px]">
            <SectionLabel>Output</SectionLabel>
            <p className="mt-2 font-mono text-[11.5px] text-gray-500">
              /data/report/{active.pipeline}/&lt;run_id&gt;/summary.json
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
