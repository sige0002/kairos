// Validation screen (v2 IA): a re-layout of the existing ValidationTab, not a
// rewrite. The pipeline list, schema-driven params form, job submission/poll,
// the generic result renderer, the bespoke fast_validation checklist and the
// one-click presets are all real, reusing features/validation/PipelineForm +
// SummaryResult and the same GET /pipelines · GET /runs · GET /config/options ·
// GET /validation/presets · POST /jobs · GET /jobs/{id}/status|result wiring as
// ValidationTab (see docs/specs/ja/dora_plugins.md §"UI 非依存の契約"). Only the
// pipeline lifecycle chip is a client-side placeholder — the orchestrator
// doesn't report a lifecycle yet (see lifecycle.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { fetchRuntimeConfig } from '../../config';
import type { JSONSchema } from '../../schema/jsonSchema';
import { initialValueFor } from '../../schema/jsonSchema';
import type {
  ConfigOptions,
  DatasetEntry,
  DatasetsResponse,
  JobState,
  JobStatus,
  Page,
  PipelineInfo,
  RunSummary,
  ValidationOption,
  ValidationPreset,
} from '../../api/types';
import type { Summary } from '../../features/validation/SummaryResult';
import { Card } from '../../components/ui';
import { PipelineRail } from './PipelineRail';
import { DetailHeader } from './DetailHeader';
import {
  ParamsPanel,
  ALL_RUNS,
  DATASET_VALUE_PREFIX,
  BATCH_VALUE_PREFIX,
} from './ParamsPanel';
import { listBatches } from '../episodeBridge';
import { ResultsPanel, type ActiveOutcome } from './ResultsPanel';
import type { RequiredTopic } from './resultsMapping';
import { Toast } from './Toast';
import { useJobResult } from './useJobResult';

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };
const FALLBACK_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['template'],
  properties: { template: { type: 'string' } },
};
const FAST_VALIDATION = 'fast_validation';
// Pipelines that can read an exported dataset dir (params.dataset_dir), even if
// the served form schema doesn't spell out the field. Any pipeline whose schema
// DOES declare `dataset_dir` is treated as dataset-capable too (see below).
const DATASET_PIPELINES = new Set(['loss_report', 'video_check']);

/** True if a pipeline can validate an exported dataset (by id or schema). */
function isDatasetCapable(id: string, schema: JSONSchema | undefined): boolean {
  return DATASET_PIPELINES.has(id) || schema?.properties?.dataset_dir !== undefined;
}

interface JobRef {
  run_id: string;
  job_id: string;
}

interface ActiveRun {
  pipeline: string;
  jobs: JobRef[];
  // fast_validation only: the template's required topics, so the checklist card
  // can show found (✓) rows, not just the summary's `missing` entries.
  requiredTopics?: RequiredTopic[];
}

interface JobProbeUpdate {
  jobId: string;
  runId: string;
  state: JobState;
  progress: number;
  terminal: boolean;
  summary?: Summary;
  artifacts?: string[];
  resultErrored: boolean;
}

/** Invisible per-job poller: reports status/result changes to the parent. */
function JobProbe({
  job,
  onUpdate,
}: {
  job: JobRef;
  onUpdate: (u: JobProbeUpdate) => void;
}) {
  const { statusQuery, terminal, resultQuery } = useJobResult(job.job_id);
  useEffect(() => {
    if (!statusQuery.data) return;
    onUpdate({
      jobId: job.job_id,
      runId: job.run_id,
      state: statusQuery.data.state,
      progress: statusQuery.data.progress ?? 0,
      terminal,
      summary: terminal ? resultQuery.data?.summary : undefined,
      artifacts: terminal ? resultQuery.data?.artifacts : undefined,
      resultErrored: terminal && resultQuery.isError,
    });
  }, [
    statusQuery.data,
    terminal,
    resultQuery.data,
    resultQuery.isError,
    job.job_id,
    job.run_id,
  ]);
  return null;
}

export function ValidationScreen() {
  const queryClient = useQueryClient();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [targetRunId, setTargetRunId] = useState('');
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [jobStates, setJobStates] = useState<Record<string, JobProbeUpdate>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: ({ signal }) =>
      apiGet<{ items: PipelineInfo[] }>('/pipelines', { signal }),
  });
  const pipelines = useMemo(
    () => (pipelinesQuery.data?.items ?? []).filter((p) => p.enabled),
    [pipelinesQuery.data],
  );
  const selectedPipeline = pipelines[selectedIndex] ?? pipelines[0];

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
  // Default target = the latest completed run (GET /runs is newest-first).
  useEffect(() => {
    if (!targetRunId && runs.length > 0) setTargetRunId(runs[0]!.run_id);
  }, [runs, targetRunId]);

  // Exported datasets are also validation targets (D-6): re-validate a built
  // dataset (loss/video checks) without going through Review.
  const datasetsQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
  });
  const datasets = datasetsQuery.data?.datasets ?? [];
  const datasetByValue = useMemo(() => {
    const m = new Map<string, DatasetEntry>();
    for (const d of datasets) m.set(`${DATASET_VALUE_PREFIX}${d.dataset_dir}`, d);
    return m;
  }, [datasets]);
  const selectedDataset = datasetByValue.get(targetRunId) ?? null;

  // Batches as bulk targets (blast-radius check, 2026-07-14): validate every
  // still-present run of one batch in one click. Only a run that hasn't been
  // exported can be validated (export MOVES the recording), so each batch's
  // candidate set is its episode run_ids ∩ the completed runs list.
  const batchesQuery = useQuery({
    queryKey: ['batches', 'validation'],
    queryFn: () => listBatches(),
    staleTime: 15_000,
  });
  const batches = useMemo(
    () => (batchesQuery.data?.items ?? []).filter((b) => (b.episodes ?? []).length > 0),
    [batchesQuery.data],
  );
  const completedRunIds = useMemo(() => new Set(runs.map((r) => r.run_id)), [runs]);
  const batchRunIds = useCallback(
    (b: (typeof batches)[number]) =>
      (b.episodes ?? []).map((e) => e.run_id).filter((id) => completedRunIds.has(id)),
    [completedRunIds],
  );
  const selectedBatch = targetRunId.startsWith(BATCH_VALUE_PREFIX)
    ? (batches.find((b) => `${BATCH_VALUE_PREFIX}${b.batch_id}` === targetRunId) ??
      null)
    : null;
  const targetKind: 'none' | 'all' | 'run' | 'dataset' | 'batch' =
    targetRunId === ''
      ? 'none'
      : targetRunId === ALL_RUNS
        ? 'all'
        : selectedBatch
          ? 'batch'
          : selectedDataset
            ? 'dataset'
            : 'run';

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const templates: ValidationOption[] = (
    optionsQuery.data?.aspects?.validation?.options ?? []
  ).map((o) => ({
    id: o.id,
    name: o.meta.name ?? o.id,
    version: o.meta.version ?? 1,
    required_topics: o.meta.required_topics ?? [],
  }));

  const configQuery = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });
  const isFastValidation = selectedPipeline?.id === FAST_VALIDATION;
  const pipelineForms = configQuery.data?.schemas?.pipeline_forms;
  const schema: JSONSchema =
    (selectedPipeline && pipelineForms?.[selectedPipeline.id]) ??
    (isFastValidation ? FALLBACK_SCHEMA : EMPTY_SCHEMA);

  // Per-pipeline applicability to the chosen target (D-6): a dataset target only
  // accepts dataset-capable pipelines; the rest are disabled with a note. Run
  // targets accept every pipeline (nothing here is dataset-only).
  const applicability = useMemo(
    () =>
      pipelines.map((p) =>
        targetKind === 'dataset' && !isDatasetCapable(p.id, pipelineForms?.[p.id])
          ? { ok: false, note: 'applies to runs' }
          : { ok: true, note: null as string | null },
      ),
    [pipelines, targetKind, pipelineForms],
  );
  const selectedApplicable =
    targetKind !== 'dataset' ||
    (!!selectedPipeline && isDatasetCapable(selectedPipeline.id, schema));
  const applicabilityNote = selectedApplicable
    ? undefined
    : 'This pipeline applies to runs, not datasets — pick a run above.';

  const seeded = useMemo(
    () => (initialValueFor(schema) as Record<string, unknown>) ?? {},
    [schema],
  );
  const params: Record<string, unknown> = { ...seeded, ...overrides };
  if (schema.properties?.template && !params.template) {
    params.template =
      optionsQuery.data?.aspects?.validation?.active || templates[0]?.id || '';
  }

  const onJobUpdate = useCallback((u: JobProbeUpdate) => {
    setJobStates((prev) => {
      const cur = prev[u.jobId];
      if (
        cur &&
        cur.state === u.state &&
        cur.progress === u.progress &&
        cur.terminal === u.terminal &&
        cur.summary === u.summary
      )
        return prev;
      return { ...prev, [u.jobId]: u };
    });
  }, []);

  const allSettled = !active || active.jobs.every((j) => jobStates[j.job_id]?.terminal);
  // On batch settle, refresh both the runs list and the presets' pending counts
  // (a preset run just validated some of its pending recordings).
  useEffect(() => {
    if (active && allSettled) {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs(undefined) });
      queryClient.invalidateQueries({ queryKey: queryKeys.validationPresets });
    }
  }, [active, allSettled, queryClient]);

  // Real one-click presets (GET /validation/presets): config-defined bundles,
  // each with the recordings its pipeline hasn't validated yet. Poll their
  // pending counts while a batch is in flight, then stop.
  const presetsQuery = useQuery({
    queryKey: queryKeys.validationPresets,
    queryFn: ({ signal }) =>
      apiGet<{ items: ValidationPreset[] }>('/validation/presets', { signal }),
    refetchInterval: active && !allSettled ? 3000 : false,
  });
  const presets = presetsQuery.data?.items ?? [];

  // Resolve a fast_validation template's required topics (matched by option id
  // or its meta name, since a preset targets the template by name).
  const requiredTopicsFor = useCallback(
    (templateKey: string): RequiredTopic[] =>
      templates.find((t) => t.id === templateKey || t.name === templateKey)
        ?.required_topics ?? [],
    [templates],
  );

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
      setJobStates({});
      setActive(run);
      setSelectedRunId(run.jobs[0]?.run_id ?? null);
    },
  });

  const selectPipeline = (i: number) => {
    setSelectedIndex(i);
    setOverrides({});
  };

  const runOnSelection = () => {
    if (!selectedPipeline || !selectedApplicable) return;
    if (targetKind === 'dataset') {
      const d = selectedDataset;
      if (!d?.run_id) return;
      submitMutation.mutate({
        pipeline: selectedPipeline.id,
        // The exported dataset dir (relative <operator>/<task>/<index>) — the
        // recording was MOVED there by dataset_export, so the run dir is gone.
        params: { ...params, dataset_dir: `${d.operator}/${d.task}/${d.index}` },
        runIds: [d.run_id],
      });
      return;
    }
    const runIds =
      targetRunId === ALL_RUNS
        ? runs.map((r) => r.run_id)
        : selectedBatch
          ? batchRunIds(selectedBatch)
          : [targetRunId];
    if (runIds.length === 0) return;
    submitMutation.mutate({
      pipeline: selectedPipeline.id,
      params,
      runIds,
      requiredTopics: isFastValidation
        ? requiredTopicsFor(String(params.template ?? ''))
        : undefined,
    });
  };

  // One-click preset: run its pipeline over exactly the recordings it hasn't
  // validated yet. A preset with nothing pending is disabled in the UI.
  const runPreset = (preset: ValidationPreset) => {
    if (preset.pending_run_ids.length === 0) return;
    submitMutation.mutate({
      pipeline: preset.pipeline,
      params: preset.params ?? {},
      runIds: preset.pending_run_ids,
      requiredTopics:
        preset.pipeline === FAST_VALIDATION
          ? requiredTopicsFor(String(preset.params?.template ?? ''))
          : undefined,
    });
  };

  const targetCount =
    targetKind === 'all'
      ? runs.length
      : targetKind === 'batch'
        ? selectedBatch
          ? batchRunIds(selectedBatch).length
          : 0
        : targetKind === 'dataset'
          ? selectedDataset?.run_id
            ? 1
            : 0
          : targetRunId
            ? 1
            : 0;
  const canRun =
    !!selectedPipeline &&
    targetCount > 0 &&
    selectedApplicable &&
    !submitMutation.isPending;
  const running = (!!active && !allSettled) || submitMutation.isPending;

  const progressPct = active
    ? Math.round(
        (active.jobs.reduce((sum, j) => sum + (jobStates[j.job_id]?.progress ?? 0), 0) /
          active.jobs.length) *
          100,
      )
    : 0;
  const progressLabel = submitMutation.isPending
    ? 'Starting…'
    : active && active.jobs.length > 1
      ? `Running on ${active.jobs.length} runs…`
      : `Running on ${active?.jobs[0]?.run_id ?? ''}…`;

  const activeOutcome: ActiveOutcome | null = active
    ? {
        pipeline: active.pipeline,
        allSettled,
        outcomes: active.jobs.map((j) => ({
          runId: j.run_id,
          orchestrationFailed:
            jobStates[j.job_id]?.state === 'failed' ||
            jobStates[j.job_id]?.resultErrored,
          summary: jobStates[j.job_id]?.summary,
        })),
        artifacts:
          active.jobs.length === 1
            ? (jobStates[active.jobs[0]!.job_id]?.artifacts ?? [])
            : [],
        requiredTopics: active.requiredTopics,
      }
    : null;

  if (!selectedPipeline) {
    return (
      <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[290px_1fr]">
        <PipelineRail
          pipelines={pipelines}
          selectedIndex={0}
          onSelect={selectPipeline}
          applicability={applicability}
          onNewRun={() => showToast('New run — pick pipeline, targets, parameters')}
        />
        <Card className="flex items-center justify-center p-8 text-sm text-gray-500">
          {pipelinesQuery.isPending ? 'Loading pipelines…' : 'No enabled pipelines.'}
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[290px_1fr]">
      {active?.jobs.map((job) => (
        <JobProbe key={job.job_id} job={job} onUpdate={onJobUpdate} />
      ))}

      <PipelineRail
        pipelines={pipelines}
        selectedIndex={selectedIndex}
        onSelect={selectPipeline}
        applicability={applicability}
        onNewRun={() => showToast('New run — pick pipeline, targets, parameters')}
      />

      <Card className="flex min-h-0 flex-col overflow-auto">
        <DetailHeader
          pipeline={selectedPipeline}
          index={selectedIndex}
          onPromote={() =>
            showToast(
              `${selectedPipeline.id} promoted to Standard — applies to new episodes`,
            )
          }
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr]">
          <ParamsPanel
            schema={schema}
            params={params}
            onParamsChange={setOverrides}
            templateOptions={templates}
            runs={runs}
            runsLoading={runsQuery.isPending}
            datasets={datasets}
            datasetsLoading={datasetsQuery.isPending}
            batches={batches}
            batchRunCount={(b) => batchRunIds(b).length}
            targetRunId={targetRunId}
            onTargetRunChange={setTargetRunId}
            applicabilityNote={applicabilityNote}
            onRun={runOnSelection}
            canRun={canRun}
            running={running}
            progressPct={progressPct}
            progressLabel={progressLabel}
            onCompareRuns={() => showToast('Run comparison isn’t available yet')}
            presets={presets}
            presetsLoading={presetsQuery.isPending}
            onRunPreset={runPreset}
            submitError={submitMutation.isError ? submitMutation.error : undefined}
          />
          <ResultsPanel
            active={activeOutcome}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        </div>
      </Card>

      <Toast message={toast} />
    </div>
  );
}
