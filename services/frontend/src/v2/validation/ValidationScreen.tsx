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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { getConfigOptions } from '../../api/config';
import { getCapture, listAllCaptures } from '../../api/captures';
import { queryKeys } from '../../api/queryKeys';
import { VALIDATION_PRESETS_POLL_MS } from '../pollingPolicy';
import { fetchRuntimeConfig } from '../../config';
import type { JSONSchema } from '../../schema/jsonSchema';
import { initialValueFor } from '../../schema/jsonSchema';
import type {
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
import { ResultsPanel, type ActiveOutcome, type RunJobRow } from './ResultsPanel';
import type { RequiredTopic } from './resultsMapping';
import { Toast } from '../shared/Toast';
import { useJobResult } from './useJobResult';
import { isCancellable, useJobCancel } from './useJobCancel';
import {
  recordJobUpdate,
  selectRunCapture,
  startRun,
  useValidationRun,
  type ActiveRun,
  type JobProbeUpdate,
  type JobRef,
  type SubmitFailure,
} from './runStore';
import { useToast } from '../shared/useToast';

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };
const FALLBACK_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['template'],
  properties: { template: { type: 'string' } },
};
const FAST_VALIDATION = 'fast_validation';

/** Invisible per-job poller: reports status/result changes to the run store. */
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
  // Null until the operator picks one, so a screen that has not been chosen
  // for can defer to the run in progress (see selectedIndex below).
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [targetId, setTargetId] = useState('');
  // The run lives in a module store, so leaving the tab no longer erases a run
  // that is still going on the server (see runStore.ts).
  const { active, jobStates, selectedCaptureId } = useValidationRun();
  const jobCancel = useJobCancel();
  const { toast, showToast } = useToast();

  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: ({ signal }) =>
      apiGet<{ items: PipelineInfo[] }>('/pipelines', { signal }),
  });
  const pipelines = useMemo(
    () => (pipelinesQuery.data?.items ?? []).filter((p) => p.enabled),
    [pipelinesQuery.data],
  );
  // Coming back to the tab should land on the work in progress. The rail's
  // selection is component state, so it resets on the unmount — and defaulting
  // to the first pipeline meant a restored run was hidden behind the results
  // gate (a run is only shown under its OWN pipeline, audit P1), leaving a
  // "Cancel run" button with nothing on screen explaining it. An explicit pick
  // always wins; this only fills the gap where there has not been one.
  const runIndex = active ? pipelines.findIndex((p) => p.id === active.pipeline) : -1;
  const selectedIndex = chosenIndex ?? (runIndex >= 0 ? runIndex : 0);
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
  // `listAllCaptures` follows the cursor for at most MAX_PAGES and then stops,
  // returning what it has WITH the unfinished cursor — so a non-null cursor
  // means the sweep did not reach the end of the catalog, and every count on
  // this screen ("all captures on this host", a batch's members) is a count of
  // what was fetched. The signal was already in the response and thrown away
  // (E-27).
  const catalogTruncated = capturesQuery.data?.next_cursor != null;
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
  // `episode_count` is the server's own count of the batch's live captures; the
  // list carries no row per capture (E-27) and this screen needs none — it is
  // already holding the catalog those rows would have summarised.
  const batches = useMemo(
    () => (batchesQuery.data?.items ?? []).filter((b) => b.episode_count > 0),
    [batchesQuery.data],
  );
  // Members, grouped once rather than scanned per batch: a batch's members ARE
  // the captures carrying its batch_id (§4.1), and only the ones whose bytes are
  // here can be validated.
  const presentIdsByBatch = useMemo(() => {
    const byBatch = new Map<string, string[]>();
    for (const c of presentCaptures) {
      if (!c.batch_id) continue;
      const ids = byBatch.get(c.batch_id);
      if (ids) ids.push(c.capture_id);
      else byBatch.set(c.batch_id, [c.capture_id]);
    }
    return byBatch;
  }, [presentCaptures]);
  const batchCaptureIds = useCallback(
    (b: (typeof batches)[number]) => presentIdsByBatch.get(b.batch_id) ?? [],
    [presentIdsByBatch],
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
    queryFn: ({ signal }) => getConfigOptions({ signal }),
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
    refetchInterval: active && !allSettled ? VALIDATION_PRESETS_POLL_MS : false,
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
      startRun(run, queryClient);
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
    setChosenIndex(i);
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

  // Every job of this run that has not reached an end — what "Cancel run"
  // stops. A job that already finished is not asked about: there is nothing
  // left to stop, and asking would invite a pointless refusal.
  const cancellableJobIds = useMemo(
    () =>
      (active?.jobs ?? [])
        .filter((j) => isCancellable(jobStates[j.job_id]?.state ?? 'queued'))
        .map((j) => j.job_id),
    [active, jobStates],
  );

  // The per-job rows the results panel shows while the run is in flight. A job
  // with no reading yet is `queued`, which is what the server just created.
  const runJobRows: RunJobRow[] = useMemo(
    () =>
      (active?.jobs ?? []).map((j) => ({
        jobId: j.job_id,
        captureId: j.capture_id,
        label: labelFor(j.capture_id),
        state: jobStates[j.job_id]?.state ?? 'queued',
      })),
    [active, jobStates, labelFor],
  );

  const cancelRun = useCallback(() => {
    void jobCancel.cancel(cancellableJobIds);
  }, [jobCancel, cancellableJobIds]);
  const cancelOneJob = useCallback(
    (jobId: string) => {
      void jobCancel.cancel([jobId]);
    },
    [jobCancel],
  );

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
          // A cancelled job also errors when its result is fetched, so this has
          // to be carried separately or the cancellation reads as a fault.
          canceled: jobStates[j.job_id]?.state === 'canceled',
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
        <JobProbe key={job.job_id} job={job} onUpdate={recordJobUpdate} />
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
            catalogTruncated={catalogTruncated}
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
            onCancelRun={cancellableJobIds.length > 0 ? cancelRun : undefined}
            cancelBusy={jobCancel.busy}
            cancelError={jobCancel.error}
            onDismissCancelError={jobCancel.dismissError}
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
            onSelectCapture={selectRunCapture}
            runJobs={runJobRows}
            onCancelJob={cancelOneJob}
            cancelPending={jobCancel.pending}
          />
        </div>
      </Card>

      <Toast message={toast} />
    </div>
  );
}
