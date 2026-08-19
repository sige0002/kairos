// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Validation screen (v2 IA). The pipeline list, the schema-driven params form,
// job submission/poll, the generic result renderer, the bespoke fast_validation
// checklist and the one-click presets are all real, reusing
// features/validation/PipelineForm + SummaryResult over GET /pipelines ·
// GET /captures · GET /config/options · GET /validation/presets · POST /jobs ·
// GET /jobs/{id}/status|result (see docs/specs/ja/dora_plugins.md §"UI 非依存の契約").
// Pipeline lifecycle is intentionally not rendered: the orchestrator does not
// report that state yet, so an index-derived badge or promotion receipt would
// be fabricated.
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
import { ApiError, apiGet } from '../../api/client';
import { getConfigOptions } from '../../api/config';
import { createCaptureSelection, getCapture, searchCaptures } from '../../api/captures';
import {
  cancelValidationRun,
  createValidationRun,
  getValidationRun,
  listValidationRuns,
  retryValidationRun,
} from '../../api/validationRuns';
import { queryKeys } from '../../api/queryKeys';
import { VALIDATION_PRESETS_POLL_MS } from '../pollingPolicy';
import { fetchRuntimeConfig } from '../../config';
import type { JSONSchema } from '../../schema/jsonSchema';
import { initialValueFor } from '../../schema/jsonSchema';
import type {
  PipelineInfo,
  ValidationRun,
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
import { lookupBatches } from '../../api/batches';
import { ResultsPanel, type ActiveOutcome, type RunJobRow } from './ResultsPanel';
import type { RequiredTopic } from './resultsMapping';
import { Toast } from '../shared/Toast';
import { type ActiveRun, type JobProbeUpdate, type SubmitFailure } from './runStore';
import { useToast } from '../shared/useToast';
import { ScreenTitle } from '../shared/ScreenTitle';

const EMPTY_SCHEMA: JSONSchema = { type: 'object', properties: {} };
const FALLBACK_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['template'],
  properties: { template: { type: 'string' } },
};
const FAST_VALIDATION = 'fast_validation';

function routeValidationRunId(): string | null {
  return new URLSearchParams(window.location.search).get('vrun');
}

function writeValidationRunId(runId: string | null): void {
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set('vrun', runId);
  else url.searchParams.delete('vrun');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function makeRequestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
        const value = Math.floor(Math.random() * 16);
        return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
      });
}

const PENDING_VALIDATION_STORAGE_KEY = 'kairos:pending-validation-run:v1';

interface PendingValidationRequest {
  fingerprint: string;
  requestId: string;
  pipeline: string;
  params: Record<string, unknown>;
  captureIds?: string[];
  selectionId?: string;
  needsSelectionRefresh?: boolean;
}

function readPendingValidationRequest(): PendingValidationRequest | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_VALIDATION_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as PendingValidationRequest).fingerprint !== 'string' ||
      typeof (value as PendingValidationRequest).requestId !== 'string' ||
      typeof (value as PendingValidationRequest).pipeline !== 'string' ||
      !(value as PendingValidationRequest).params
    ) {
      return null;
    }
    return value as PendingValidationRequest;
  } catch {
    return null;
  }
}

function writePendingValidationRequest(request: PendingValidationRequest | null): void {
  try {
    if (request) {
      window.sessionStorage.setItem(
        PENDING_VALIDATION_STORAGE_KEY,
        JSON.stringify(request),
      );
    } else {
      window.sessionStorage.removeItem(PENDING_VALIDATION_STORAGE_KEY);
    }
  } catch {
    // An unavailable session store must not make validation submission fail.
  }
}

function clientRunState(job: ValidationRun['jobs'][number]): JobProbeUpdate {
  const state =
    job.job?.state ??
    (job.dispatch_state === 'submission_failed'
      ? 'failed'
      : job.dispatch_state === 'canceled_before_submit'
        ? 'canceled'
        : 'queued');
  return {
    jobId: job.job?.job_id ?? job.run_job_id,
    captureId: job.capture_id,
    state,
    progress: job.job?.progress ?? 0,
    terminal: state === 'succeeded' || state === 'failed' || state === 'canceled',
    cancelRequested: job.job?.cancel_requested === true,
    summary: job.result?.summary,
    artifacts: job.result?.artifacts,
    resultErrored: false,
  };
}

export function ValidationScreen() {
  const queryClient = useQueryClient();
  // Null until the operator picks one, so a screen that has not been chosen
  // for can defer to the run in progress (see selectedIndex below).
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [targetId, setTargetId] = useState('');
  // The picker uses the API's one-way cursor. Retaining boundaries, not rows,
  // makes Previous available without a browser-side catalog sweep.
  const [captureCursorHistory, setCaptureCursorHistory] = useState<
    Array<string | null>
  >([null]);
  const [selectedRunId, setSelectedRunId] = useState(routeValidationRunId);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingValidationRequest | null>(
    readPendingValidationRequest,
  );
  const submittedRequestIds = useRef(new Set<string>());
  const { toast } = useToast();

  const setPersistedPendingRequest = useCallback(
    (request: PendingValidationRequest | null) => {
      // Persist before dispatching the request: a navigation or response-loss
      // immediately after the click must still have the original request id.
      writePendingValidationRequest(request);
      setPendingRequest(request);
    },
    [],
  );

  useEffect(() => {
    writePendingValidationRequest(pendingRequest);
  }, [pendingRequest]);

  // The browser stores only the selected durable run id. Lifecycle and every
  // child outcome are always re-read from the server, including after reload.
  const activeRunsQuery = useQuery({
    queryKey: [...queryKeys.validationRuns, 'active'],
    queryFn: ({ signal }) => listValidationRuns(true, { signal }),
    refetchInterval: 1_000,
  });
  useEffect(() => {
    if (selectedRunId || activeRunsQuery.isPending) return;
    const restored = activeRunsQuery.data?.items?.[0];
    if (!restored) return;
    setSelectedRunId(restored.run_id);
    writeValidationRunId(restored.run_id);
  }, [selectedRunId, activeRunsQuery.isPending, activeRunsQuery.data]);
  const validationRunQuery = useQuery({
    queryKey: queryKeys.validationRun(selectedRunId ?? ''),
    queryFn: ({ signal }) => getValidationRun(selectedRunId!, { signal }),
    enabled: selectedRunId !== null,
    refetchInterval: (query) =>
      query.state.data?.state === 'finished' ? false : 1_000,
  });
  const validationRun = validationRunQuery.data ?? null;
  // Retry appends attempt history. The current outcome is the latest attempt
  // per capture; an old failure must not turn a later success back into red.
  const currentRunJobs = useMemo(() => {
    const latest = new Map<string, ValidationRun['jobs'][number]>();
    for (const job of validationRun?.jobs ?? []) {
      const prior = latest.get(job.capture_id);
      if (!prior || job.attempt >= prior.attempt) latest.set(job.capture_id, job);
    }
    return [...latest.values()];
  }, [validationRun]);
  const jobStates = useMemo(
    () =>
      Object.fromEntries(
        currentRunJobs.map((job) => {
          const current = clientRunState(job);
          return [current.jobId, current];
        }),
      ),
    [currentRunJobs],
  );
  const active = useMemo<ActiveRun | null>(() => {
    if (!validationRun) return null;
    const failures: SubmitFailure[] = currentRunJobs
      .filter((job) => job.dispatch_state === 'submission_failed')
      .map((job) => ({
        captureId: job.capture_id,
        reason: job.failure_message ?? 'The server could not submit this capture.',
      }));
    return {
      pipeline: validationRun.pipeline,
      jobs: currentRunJobs.map((job) => ({
        capture_id: job.capture_id,
        job_id: job.job?.job_id ?? job.run_job_id,
      })),
      failures,
    };
  }, [validationRun, currentRunJobs]);

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

  // The picker holds one server page. All and Batch targets are materialized on
  // the server at submit time; they never mean merely the rows on this page.
  const captureCursor = captureCursorHistory.at(-1) ?? null;
  const captureQuery = useMemo(
    () => ({ query: {}, cursor: captureCursor, limit: 100 }),
    [captureCursor],
  );
  const capturesQuery = useQuery({
    queryKey: queryKeys.captureSearch('validation', captureQuery),
    queryFn: ({ signal }) => searchCaptures(captureQuery, signal),
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
  // A non-null cursor names the picker boundary only, not an All/Batch run.
  const catalogTruncated = capturesQuery.data?.next_cursor != null;
  const changeCapturePage = useCallback(
    (direction: 'previous' | 'next') => {
      if (direction === 'previous') {
        setCaptureCursorHistory((history) =>
          history.length > 1 ? history.slice(0, -1) : history,
        );
      } else {
        const next = capturesQuery.data?.next_cursor;
        if (!next) return;
        setCaptureCursorHistory((history) =>
          history.at(-1) === next ? history : [...history, next],
        );
      }
      // A single capture or Batch option belongs to the page it was chosen
      // from. Clear it when browsing another page instead of submitting an
      // invisible, stale target.
      setTargetId('');
      setSelectionMessage(null);
    },
    [capturesQuery.data?.next_cursor],
  );
  // Default target = the newest capture whose bytes are readable HERE (the list
  // is newest-first). Defaulting to one that is merely catalogued would put a
  // job that can only fail one click away.
  useEffect(() => {
    if (!targetId && presentCaptures.length > 0) {
      setTargetId(presentCaptures[0]!.capture_id);
    }
  }, [presentCaptures, targetId]);

  // Batch choices are discovered from this page for now. Execution materializes
  // by batch_id on the server, so the page cannot narrow a Batch run.
  const pageBatchIds = useMemo(
    () => [
      ...new Set(
        captures.flatMap((capture) => (capture.batch_id ? [capture.batch_id] : [])),
      ),
    ],
    [captures],
  );
  const batchesQuery = useQuery({
    queryKey: ['batches', 'lookup', pageBatchIds],
    queryFn: ({ signal }) => lookupBatches(pageBatchIds, signal),
    enabled: pageBatchIds.length > 0,
    staleTime: 15_000,
  });
  // Each id came from a capture on this page, so a resolved Batch is non-empty;
  // lookup intentionally omits the list-only episode_count field.
  const batches = useMemo(() => batchesQuery.data?.items ?? [], [batchesQuery.data]);
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
    if (
      targetKind === 'capture' &&
      selectedCapture &&
      isCapturePresent(selectedCapture)
    ) {
      return [selectedCapture.capture_id];
    }
    return [];
  }, [targetKind, selectedCapture]);

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
      typeof current === 'string' &&
      current !== '' &&
      options.length > 0 &&
      !options.includes(current);
    if (params[key] && !stale) continue;
    const first = options[0];
    if (first) params[key] = first;
  }

  const allSettled = validationRun?.state === 'finished';
  // On batch settle, refresh the capture catalog and the presets' pending counts
  // (a preset run just validated some of its pending recordings).
  useEffect(() => {
    if (validationRun && allSettled) {
      queryClient.invalidateQueries({ queryKey: queryKeys.captures });
      queryClient.invalidateQueries({ queryKey: queryKeys.validationPresets });
    }
  }, [validationRun, allSettled, queryClient]);

  // Real one-click presets (GET /validation/presets): config-defined bundles,
  // each with the captures its pipeline hasn't validated yet. Poll their pending
  // counts while a batch is in flight, then stop.
  const presetsQuery = useQuery({
    queryKey: queryKeys.validationPresets,
    queryFn: ({ signal }) =>
      apiGet<{ items: ValidationPreset[] }>('/validation/presets', { signal }),
    refetchInterval: validationRun && !allSettled ? VALIDATION_PRESETS_POLL_MS : false,
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
    mutationFn: (arg: {
      pipeline: string;
      params: Record<string, unknown>;
      captureIds?: string[];
      selectionId?: string;
      requestId: string;
    }) => {
      const body = {
        pipeline: arg.pipeline,
        params: arg.params,
        request_id: arg.requestId,
        ...(arg.selectionId
          ? { selection_id: arg.selectionId }
          : { capture_ids: arg.captureIds ?? [] }),
      };
      return createValidationRun(body);
    },
    onSuccess: (run, arg) => {
      submittedRequestIds.current.delete(arg.requestId);
      setPersistedPendingRequest(null);
      setSelectedRunId(run.run_id);
      setSelectedCaptureId(run.jobs[0]?.capture_id ?? null);
      writeValidationRunId(run.run_id);
      queryClient.setQueryData(queryKeys.validationRun(run.run_id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.validationRuns });
    },
    onError: (error, arg) => {
      if (
        error instanceof ApiError &&
        error.code === 'capture_selection_expired' &&
        arg.selectionId
      ) {
        setPendingRequest((current) => {
          const next =
            current?.requestId === arg.requestId
              ? {
                  ...current,
                  captureIds: undefined,
                  selectionId: undefined,
                  needsSelectionRefresh: true,
                }
              : current;
          writePendingValidationRequest(next);
          return next;
        });
      }
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: (runId: string) => cancelValidationRun(runId),
    onSuccess: (run) => {
      queryClient.setQueryData(queryKeys.validationRun(run.run_id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.validationRuns });
    },
  });
  const retryRunMutation = useMutation({
    mutationFn: (runId: string) => retryValidationRun(runId),
    onSuccess: (run) => {
      queryClient.setQueryData(queryKeys.validationRun(run.run_id), run);
      void queryClient.invalidateQueries({ queryKey: queryKeys.validationRuns });
    },
  });
  const selectionMutation = useMutation({
    mutationFn: (query: Parameters<typeof createCaptureSelection>[0]['query']) =>
      createCaptureSelection({ query }),
    onError: (error) => {
      setSelectionMessage(
        `Could not freeze the server selection: ${captureErrorText(error)}. Check the connection and try Run again.`,
      );
    },
  });

  const submitPendingRequest = useCallback(
    (request: PendingValidationRequest) => {
      submittedRequestIds.current.add(request.requestId);
      setPersistedPendingRequest(request);
      submitMutation.mutate(request);
    },
    [setPersistedPendingRequest, submitMutation],
  );

  useEffect(() => {
    if (
      !pendingRequest ||
      pendingRequest.needsSelectionRefresh ||
      submitMutation.isPending ||
      submittedRequestIds.current.has(pendingRequest.requestId)
    ) {
      return;
    }
    submittedRequestIds.current.add(pendingRequest.requestId);
    submitMutation.mutate(pendingRequest);
  }, [pendingRequest, submitMutation]);

  const selectPipeline = (i: number) => {
    setChosenIndex(i);
    setOverrides({});
  };

  const runOnSelection = () => {
    if (!selectedPipeline || targetKind === 'none') return;
    const fingerprint = JSON.stringify({
      pipeline: selectedPipeline.id,
      params,
      targetKind,
      targetId,
    });
    const requestId =
      pendingRequest?.fingerprint === fingerprint
        ? pendingRequest.requestId
        : makeRequestId();
    const submit = (selectionId?: string) =>
      submitPendingRequest({
        pipeline: selectedPipeline.id,
        params,
        captureIds: targetCaptureIds,
        selectionId,
        requestId,
        fingerprint,
      });
    if (targetKind === 'capture') {
      submit();
      return;
    }
    if (pendingRequest?.fingerprint === fingerprint && pendingRequest.selectionId) {
      submit(pendingRequest.selectionId);
      return;
    }
    selectionMutation.reset();
    selectionMutation.mutate(
      {
        join: 'and',
        predicates:
          targetKind === 'batch' && selectedBatch
            ? [{ field: 'batch_id', operator: 'equals', value: selectedBatch.batch_id }]
            : [],
        states: ['completed', 'failed', 'interrupted'],
        present_on_instance: true,
      },
      {
        onSuccess: (selection) => {
          if (selection.matched_count === 0) {
            setSelectionMessage(
              'Nothing matched this server selection; no validation run was started.',
            );
            return;
          }
          if (selection.matched_count > 1000) {
            setSelectionMessage(
              `${selection.matched_count} matched; narrow filters before validation (maximum 1000).`,
            );
            return;
          }
          setSelectionMessage(null);
          submit(selection.selection_id);
        },
      },
    );
  };

  // One-click preset: run its pipeline over exactly the captures it hasn't
  // validated yet. A preset with nothing pending is disabled in the UI.
  const runPreset = (preset: ValidationPreset) => {
    if (preset.pending_capture_ids.length === 0) return;
    if (preset.pending_capture_ids.length > 1000) {
      setSelectionMessage(
        `${preset.pending_capture_ids.length} preset targets are pending; narrow the preset before validation (maximum 1000).`,
      );
      return;
    }
    const params = preset.params ?? {};
    const fingerprint = JSON.stringify({
      pipeline: preset.pipeline,
      params,
      captureIds: preset.pending_capture_ids,
    });
    const requestId =
      pendingRequest?.fingerprint === fingerprint
        ? pendingRequest.requestId
        : makeRequestId();
    submitPendingRequest({
      pipeline: preset.pipeline,
      params,
      captureIds: preset.pending_capture_ids,
      requestId,
      fingerprint,
    });
  };

  const canRun =
    !!selectedPipeline &&
    targetKind !== 'none' &&
    (targetKind !== 'capture' || targetCaptureIds.length > 0) &&
    !submitMutation.isPending &&
    !selectionMutation.isPending;
  const running =
    (!!validationRun && !allSettled) ||
    submitMutation.isPending ||
    selectionMutation.isPending;

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
  const progressLabel =
    selectionMutation.isPending || submitMutation.isPending
      ? 'Starting…'
      : validationRun?.cancel_requested
        ? 'Cancel requested…'
        : active && active.jobs.length > 1
          ? `Running on ${active.jobs.length} captures…`
          : `Running on ${active?.jobs[0] ? labelFor(active.jobs[0].capture_id) : ''}…`;

  // The per-job rows the results panel shows while the run is in flight. A job
  // with no reading yet is `queued`, which is what the server just created.
  const runJobRows: RunJobRow[] = useMemo(
    () =>
      (active?.jobs ?? []).map((j) => ({
        jobId: j.job_id,
        captureId: j.capture_id,
        label: labelFor(j.capture_id),
        state: jobStates[j.job_id]?.state ?? 'queued',
        cancelRequested: jobStates[j.job_id]?.cancelRequested === true,
      })),
    [active, jobStates, labelFor],
  );

  const cancelRun = useCallback(() => {
    if (validationRun && !validationRun.cancel_requested && !allSettled) {
      cancelRunMutation.mutate(validationRun.run_id);
    }
  }, [validationRun, allSettled, cancelRunMutation]);
  const canRetryValidationRun = Boolean(
    currentRunJobs.some(
      (job) =>
        job.dispatch_state === 'submission_failed' || job.job?.state === 'failed',
    ),
  );

  // Only surface the last run when it belongs to the pipeline being viewed —
  // rendering fast_validation's PASS under loss_report's heading read as a
  // verdict for the wrong pipeline (audit P1). Switching back re-shows it.
  const activeOutcome: ActiveOutcome | null =
    active && active.pipeline === selectedPipeline?.id
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
          requiredTopics:
            active.pipeline === FAST_VALIDATION
              ? requiredTopicsFor(String(validationRun?.params.template ?? ''))
              : undefined,
        }
      : null;

  if (!selectedPipeline) {
    return (
      <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[290px_1fr]">
        <ScreenTitle>Validation</ScreenTitle>
        <PipelineRail
          pipelines={pipelines}
          selectedIndex={0}
          onSelect={selectPipeline}
        />
        <Card className="flex items-center justify-center p-8 text-sm text-gray-500">
          {pipelinesQuery.isPending ? 'Loading pipelines…' : 'No enabled pipelines.'}
        </Card>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[290px_1fr]">
      <ScreenTitle>Validation</ScreenTitle>
      <PipelineRail
        pipelines={pipelines}
        selectedIndex={selectedIndex}
        onSelect={selectPipeline}
      />

      <Card className="flex min-h-0 flex-col overflow-auto">
        <DetailHeader pipeline={selectedPipeline} />
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
            capturePage={captureCursorHistory.length}
            canPreviousCapturePage={captureCursorHistory.length > 1}
            canNextCapturePage={catalogTruncated}
            onCapturePageChange={changeCapturePage}
            batches={batches}
            targetId={targetId}
            onTargetChange={setTargetId}
            selectedCapture={selectedCapture}
            targetNote={targetNote}
            selectionMessage={selectionMessage}
            onRun={runOnSelection}
            canRun={canRun}
            running={running}
            progressPct={progressPct}
            progressLabel={progressLabel}
            onCancelRun={
              validationRun && !allSettled && !validationRun.cancel_requested
                ? cancelRun
                : undefined
            }
            cancelBusy={cancelRunMutation.isPending}
            cancelError={
              cancelRunMutation.isError
                ? captureErrorText(cancelRunMutation.error, 'job')
                : null
            }
            onDismissCancelError={cancelRunMutation.reset}
            presets={presets}
            presetsLoading={presetsQuery.isPending}
            onRunPreset={runPreset}
            submitError={submitMutation.isError ? submitMutation.error : undefined}
            submitFailures={active?.failures ?? []}
            captureLabel={labelFor}
            onRetryFailures={
              validationRun && allSettled && canRetryValidationRun
                ? () => retryRunMutation.mutate(validationRun.run_id)
                : undefined
            }
            retryBusy={retryRunMutation.isPending}
          />
          {validationRunQuery.isError ? (
            <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[18px]">
              <Card
                role="alert"
                data-testid="validation-run-unavailable"
                className="flex flex-col gap-2 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
              >
                <span className="font-semibold">Run not available</span>
                <span>
                  Jobs were not assumed. Select an active run or start a new one.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRunId(null);
                    setSelectedCaptureId(null);
                    writeValidationRunId(null);
                    void queryClient.invalidateQueries({
                      queryKey: queryKeys.validationRuns,
                    });
                  }}
                  className="self-start text-xs font-semibold underline"
                >
                  Clear unavailable run
                </button>
              </Card>
            </div>
          ) : (
            <ResultsPanel
              active={activeOutcome}
              selectedCaptureId={selectedCaptureId}
              onSelectCapture={setSelectedCaptureId}
              runJobs={runJobRows}
            />
          )}
        </div>
      </Card>

      <Toast message={toast} />
    </div>
  );
}
