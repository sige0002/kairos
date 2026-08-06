// Validation screen (v2 IA). The pipeline list, the schema-driven params form,
// job submission/poll, the generic result renderer, the bespoke fast_validation
// checklist and the one-click presets are all real, reusing
// features/validation/PipelineForm + SummaryResult over GET /pipelines ·
// GET /captures · GET /config/options · GET /validation/presets · POST /jobs ·
// GET /jobs/{id}/status|result (see docs/specs/ja/dora_plugins.md §"UI 非依存の契約").
// Only the pipeline lifecycle chip is a client-side placeholder — the
// orchestrator doesn't report a lifecycle yet (see lifecycle.ts).
//
// Every target here is a capture (contract §10.5): a job resolves its source as
// `objects/<capture_id>` and writes to `report/<pipeline>/<capture_id>/`. A
// dataset has no directory to aim a job at (§6), so there is no second kind of
// target — a dataset's captures are validated as the captures they are.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { getCapture, listAllCaptures } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { fetchRuntimeConfig } from '../../config';
import type { JSONSchema } from '../../schema/jsonSchema';
import { initialValueFor } from '../../schema/jsonSchema';
import type {
  ConfigOptions,
  JobState,
  JobStatus,
  JobSubmitRequest,
  PipelineInfo,
  ValidationOption,
  ValidationPreset,
} from '../../api/types';
import { TERMINAL_CAPTURE_STATES } from '../../api/types';
import { availabilityOf, isCapturePresent } from '../captures/availability';
import { cameraTopics } from '../captures/inspect';
import { captureErrorText } from '../captures/errors';
import type { Summary } from '../../features/validation/SummaryResult';
import { Card } from '../../components/ui';
import { PipelineRail } from './PipelineRail';
import { DetailHeader } from './DetailHeader';
import {
  ParamsPanel,
  ALL_CAPTURES,
  BATCH_VALUE_PREFIX,
  captureLabel,
} from './ParamsPanel';
import { listBatches } from '../../api/batches';
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

interface JobRef {
  capture_id: string;
  job_id: string;
}

/** A capture the run could not start a job for, and why in the operator's
 *  terms. Kept per capture rather than collapsed into one error: a preset runs
 *  over many captures, and "which ones did not run" is the whole question. */
interface SubmitFailure {
  captureId: string;
  reason: string;
}

interface ActiveRun {
  pipeline: string;
  jobs: JobRef[];
  /** Captures skipped because their job could not be created — most often a
   *  capture discarded or deleted since the preset's pending list was built. */
  failures: SubmitFailure[];
  // fast_validation only: the template's required topics, so the checklist card
  // can show found (✓) rows, not just the summary's `missing` entries.
  requiredTopics?: RequiredTopic[];
}

interface JobProbeUpdate {
  jobId: string;
  captureId: string;
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
      captureId: job.capture_id,
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
    job.capture_id,
  ]);
  return null;
}

export function ValidationScreen() {
  const queryClient = useQueryClient();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [targetId, setTargetId] = useState('');
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [jobStates, setJobStates] = useState<Record<string, JobProbeUpdate>>({});
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
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

  // The whole catalog, cursor followed to exhaustion. A single page would both
  // hide older recordings from the picker and make "all captures on this host"
  // count something narrower than the presets' own server-side total — two
  // numbers on one screen disagreeing about the same set.
  const capturesQuery = useQuery({
    queryKey: queryKeys.captureList('validation'),
    queryFn: ({ signal }) => listAllCaptures({}, signal),
    placeholderData: keepPreviousData,
  });
  // A pipeline reads a finished bag, so only a capture that reached an end is a
  // target; an unfinalized one is still being written (§3).
  const captures = useMemo(
    () =>
      (capturesQuery.data?.items ?? []).filter((c) =>
        TERMINAL_CAPTURE_STATES.has(c.state),
      ),
    [capturesQuery.data],
  );
  const presentCaptures = useMemo(() => captures.filter(isCapturePresent), [captures]);
  // Default target = the newest capture whose bytes are readable HERE (the list
  // is newest-first). Defaulting to one that is merely catalogued would put a
  // job that can only fail one click away.
  useEffect(() => {
    if (!targetId && presentCaptures.length > 0) {
      setTargetId(presentCaptures[0]!.capture_id);
    }
  }, [presentCaptures, targetId]);

  // Batches as bulk targets (blast-radius check): validate every capture of one
  // batch in one click. A batch's members are simply the captures carrying its
  // batch_id, and only the ones whose bytes are on this host can be validated.
  const batchesQuery = useQuery({
    queryKey: ['batches', 'validation'],
    queryFn: () => listBatches(),
    staleTime: 15_000,
  });
  const batches = useMemo(
    () => (batchesQuery.data?.items ?? []).filter((b) => (b.episodes ?? []).length > 0),
    [batchesQuery.data],
  );
  const presentCaptureIds = useMemo(
    () => new Set(presentCaptures.map((c) => c.capture_id)),
    [presentCaptures],
  );
  const batchCaptureIds = useCallback(
    (b: (typeof batches)[number]) =>
      (b.episodes ?? [])
        .map((e) => e.capture_id)
        .filter((id) => presentCaptureIds.has(id)),
    [presentCaptureIds],
  );
  const selectedBatch = targetId.startsWith(BATCH_VALUE_PREFIX)
    ? (batches.find((b) => `${BATCH_VALUE_PREFIX}${b.batch_id}` === targetId) ?? null)
    : null;
  const selectedCapture = useMemo(
    () => captures.find((c) => c.capture_id === targetId) ?? null,
    [captures, targetId],
  );
  const targetKind: 'none' | 'all' | 'capture' | 'batch' =
    targetId === ''
      ? 'none'
      : targetId === ALL_CAPTURES
        ? 'all'
        : selectedBatch
          ? 'batch'
          : 'capture';

  const targetCaptureIds = useMemo(() => {
    if (targetKind === 'all') return presentCaptures.map((c) => c.capture_id);
    if (targetKind === 'batch') return selectedBatch ? batchCaptureIds(selectedBatch) : [];
    if (targetKind === 'capture' && selectedCapture && isCapturePresent(selectedCapture)) {
      return [selectedCapture.capture_id];
    }
    return [];
  }, [targetKind, presentCaptures, selectedBatch, batchCaptureIds, selectedCapture]);

  // A job resolves its source as objects/<capture_id> on THIS host (§10.5), so
  // with the bytes absent it can only fail server-side. Refuse it here instead,
  // and say which of the §8 states is in the way rather than "cannot run".
  const targetAvailability = selectedCapture ? availabilityOf(selectedCapture) : null;
  const targetNote =
    targetAvailability && !targetAvailability.usable
      ? `${targetAvailability.detail} A pipeline reads the recording's files, so it cannot run until they are on this machine.`
      : undefined;

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

  const seeded = useMemo(
    () => (initialValueFor(schema) as Record<string, unknown>) ?? {},
    [schema],
  );

  // The selected capture's topics feed `x-suggest` string params (e.g.
  // video_check's `topic` becomes a picker of that recording's camera topics
  // instead of a hand-typed path). Only a single-capture target has one topic
  // list; a batch target keeps the honest free-text fallback.
  const targetCaptureQuery = useQuery({
    queryKey: queryKeys.capture(targetId),
    queryFn: ({ signal }) => getCapture(targetId, signal),
    enabled: targetKind === 'capture' && !!targetId,
    staleTime: 30_000,
  });
  const targetTopics = useMemo(
    () => (targetKind === 'capture' ? (targetCaptureQuery.data?.topics ?? []) : []),
    [targetKind, targetCaptureQuery.data],
  );
  const suggestions = useMemo(
    () => ({
      camera_topics: cameraTopics(targetTopics).map((t) => t.name),
      topics: targetTopics.map((t) => t.name),
    }),
    [targetTopics],
  );

  const params: Record<string, unknown> = { ...seeded, ...overrides };
  if (schema.properties?.template && !params.template) {
    params.template =
      optionsQuery.data?.aspects?.validation?.active || templates[0]?.id || '';
  }
  // Seed each empty x-suggest param with the first suggestion (same pattern as
  // `template` above): pick a capture with a camera and video_check is one click.
  //
  // An x-suggest value is DERIVED FROM THE TARGET (the camera topics of the
  // selected recording), so a value the operator chose for a previous capture is
  // not merely stale here — it can name a topic this capture does not contain,
  // and it used to be submitted that way because `overrides` is only cleared on
  // a pipeline change. Drop such a value when the new target does not offer it,
  // which re-seeds from this capture. Params NOT derived from the target
  // (`template`, a typed threshold) are deliberately left alone: they have
  // nothing to do with which recording is selected, and wiping them would trade
  // one silent surprise for another.
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const kind = child['x-suggest'];
    if (!kind) continue;
    const options = suggestions[kind as keyof typeof suggestions] ?? [];
    const current = params[key];
    const stale =
      typeof current === 'string' && current !== '' && options.length > 0 &&
      !options.includes(current);
    if (params[key] && !stale) continue;
    const first = options[0];
    if (first) params[key] = first;
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
  // On batch settle, refresh the capture catalog and the presets' pending counts
  // (a preset run just validated some of its pending recordings).
  useEffect(() => {
    if (active && allSettled) {
      queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      queryClient.invalidateQueries({ queryKey: queryKeys.validationPresets });
    }
  }, [active, allSettled, queryClient]);

  // Real one-click presets (GET /validation/presets): config-defined bundles,
  // each with the captures its pipeline hasn't validated yet. Poll their pending
  // counts while a batch is in flight, then stop.
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

  const captureById = useMemo(
    () => new Map(captures.map((c) => [c.capture_id, c])),
    [captures],
  );
  // A preset can name a capture that is not in the loaded page; showing its
  // capture_id is honest, inventing a run-style name would not be.
  const labelFor = useCallback(
    (captureId: string) => {
      const capture = captureById.get(captureId);
      return capture ? captureLabel(capture) : captureId;
    },
    [captureById],
  );

  const submitMutation = useMutation({
    mutationFn: async (arg: {
      pipeline: string;
      params: Record<string, unknown>;
      captureIds: string[];
      requiredTopics?: RequiredTopic[];
    }): Promise<ActiveRun> => {
      const jobs: JobRef[] = [];
      const failures: SubmitFailure[] = [];
      for (const captureId of arg.captureIds) {
        const body: JobSubmitRequest = {
          pipeline: arg.pipeline,
          capture_id: captureId,
          params: arg.params,
        };
        try {
          const job = await apiPost<JobStatus>('/jobs', body);
          queryClient.setQueryData(queryKeys.job(job.job_id), job);
          jobs.push({ capture_id: captureId, job_id: job.job_id });
        } catch (e) {
          // One refused capture must not abandon the whole run. Rejecting here
          // threw away the jobs already created — they kept running on the
          // server with nothing watching them — and left the operator with a
          // single error that never said which capture it was about. The most
          // common cause is a capture discarded since the preset's pending list
          // was computed, which the server answers with capture_deleting /
          // capture_deleted.
          failures.push({ captureId, reason: captureErrorText(e, 'job') });
        }
      }
      return { pipeline: arg.pipeline, jobs, failures, requiredTopics: arg.requiredTopics };
    },
    onSuccess: (run) => {
      setJobStates({});
      setActive(run);
      setSelectedCaptureId(run.jobs[0]?.capture_id ?? null);
      if (run.failures.length > 0) {
        const names = run.failures.map((f) => labelFor(f.captureId)).join(', ');
        showToast(
          run.jobs.length === 0
            ? `Nothing ran — ${run.failures[0]!.reason}`
            : `Started ${run.jobs.length}; skipped ${names}`,
        );
      }
    },
  });

  const selectPipeline = (i: number) => {
    setSelectedIndex(i);
    setOverrides({});
  };

  const runOnSelection = () => {
    if (!selectedPipeline || targetCaptureIds.length === 0) return;
    submitMutation.mutate({
      pipeline: selectedPipeline.id,
      params,
      captureIds: targetCaptureIds,
      requiredTopics: isFastValidation
        ? requiredTopicsFor(String(params.template ?? ''))
        : undefined,
    });
  };

  // One-click preset: run its pipeline over exactly the captures it hasn't
  // validated yet. A preset with nothing pending is disabled in the UI.
  const runPreset = (preset: ValidationPreset) => {
    if (preset.pending_capture_ids.length === 0) return;
    submitMutation.mutate({
      pipeline: preset.pipeline,
      params: preset.params ?? {},
      captureIds: preset.pending_capture_ids,
      requiredTopics:
        preset.pipeline === FAST_VALIDATION
          ? requiredTopicsFor(String(preset.params?.template ?? ''))
          : undefined,
    });
  };

  const canRun =
    !!selectedPipeline && targetCaptureIds.length > 0 && !submitMutation.isPending;
  const running = (!!active && !allSettled) || submitMutation.isPending;

  // A run can legitimately have NO jobs: every capture it targeted was refused
  // (all discarded, say), and `active` still exists to carry the per-capture
  // reasons. Dividing by that zero yielded NaN, which nothing renders today
  // only because an empty job list also counts as settled.
  const progressPct =
    active && active.jobs.length > 0
      ? Math.round(
          (active.jobs.reduce(
            (sum, j) => sum + (jobStates[j.job_id]?.progress ?? 0),
            0,
          ) /
            active.jobs.length) *
            100,
        )
      : 0;
  const progressLabel = submitMutation.isPending
    ? 'Starting…'
    : active && active.jobs.length > 1
      ? `Running on ${active.jobs.length} captures…`
      : `Running on ${active?.jobs[0] ? labelFor(active.jobs[0].capture_id) : ''}…`;

  // Only surface the last run when it belongs to the pipeline being viewed —
  // rendering fast_validation's PASS under loss_report's heading read as a
  // verdict for the wrong pipeline (audit P1). Switching back re-shows it.
  const activeOutcome: ActiveOutcome | null = active &&
    active.pipeline === selectedPipeline?.id
    ? {
        pipeline: active.pipeline,
        allSettled,
        outcomes: active.jobs.map((j) => ({
          captureId: j.capture_id,
          label: labelFor(j.capture_id),
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
        onNewRun={() => showToast('New run — pick pipeline, targets, parameters')}
      />

      <Card className="flex min-h-0 flex-col overflow-auto">
        <DetailHeader
          pipeline={selectedPipeline}
          index={selectedIndex}
          onPromote={() =>
            showToast(
              `${selectedPipeline.id} promoted to Standard — applies to new captures`,
            )
          }
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr]">
          <ParamsPanel
            schema={schema}
            params={params}
            onParamsChange={setOverrides}
            templateOptions={templates}
            suggestions={suggestions}
            captures={captures}
            capturesLoading={capturesQuery.isPending}
            batches={batches}
            batchCaptureCount={(b) => batchCaptureIds(b).length}
            targetId={targetId}
            onTargetChange={setTargetId}
            selectedCapture={selectedCapture}
            targetNote={targetNote}
            onRun={runOnSelection}
            canRun={canRun}
            running={running}
            progressPct={progressPct}
            progressLabel={progressLabel}
            presets={presets}
            presetsLoading={presetsQuery.isPending}
            onRunPreset={runPreset}
            submitError={submitMutation.isError ? submitMutation.error : undefined}
            submitFailures={active?.failures ?? []}
            captureLabel={labelFor}
          />
          <ResultsPanel
            active={activeOutcome}
            selectedCaptureId={selectedCaptureId}
            onSelectCapture={setSelectedCaptureId}
          />
        </div>
      </Card>

      <Toast message={toast} />
    </div>
  );
}
