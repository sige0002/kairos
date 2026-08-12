// "Convert to LeRobot" (§6.2): the selected dataset converted to a LeRobot v3
// tree under `exports/`.
//
// Its own hook rather than more lines in useDatasetsState, which is already the
// screen's biggest file — the same rule that split Collect's machine apart
// (AGENTS.md). Nothing here touches the dataset's own state: a conversion READS
// the members and writes somewhere else, so there is no row to invalidate and
// no membership to freeze. The dataset simply stays as it is.
//
// Three reads and two writes, and each read exists because the operator must
// know something BEFORE committing:
//
//   config    — can this installation convert at all? A `false` here means the
//               control is never drawn (the archive-config gate's rule).
//   preflight — what would this exact profile + memo do? Which members come
//               along, which are dropped and why, whose task labels are
//               missing, which captures lack the profile's topics, and whether
//               the destination is already taken. Recomputed as the operator
//               types, so the answer on screen is about the name they are
//               actually about to use.
//   status    — the conversion once it is running, polled at 1 s while live.
//
// The status poll is deliberately NOT permanent. It reads once when a dataset
// is selected (so an export started elsewhere — another tab, a curl — is
// picked up rather than hidden) and only then settles into the 1 s cadence if
// what came back is actually live. A terminal export costs one read per
// selection, not one per second forever.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelDatasetExport,
  getDatasetExport,
  getExportPreflight,
  getExportsConfig,
  startDatasetExport,
} from '../../api/exports';
import { queryKeys } from '../../api/queryKeys';
import { DATASET_EXPORT_POLL_MS } from '../pollingPolicy';
import type {
  Dataset,
  ExportPreflight,
  ExportProfile,
  ExportStatus,
} from '../../api/types';

/** How long the memo may keep changing before the preflight is recomputed.
 *  Every keystroke is a new output name and therefore a new server answer;
 *  this is what keeps a typed word from becoming a burst of requests, while
 *  still settling well inside the pause between words. */
const MEMO_DEBOUNCE_MS = 300;

// Test seams (the shape useDatasetsState's archive poll established): the memo
// debounce and the status poll are both real wall-clock waits a unit test must
// not sit through.
let memoDebounceMs: number | null = null;
export function __setMemoDebounceMs(ms: number): void {
  memoDebounceMs = ms;
}
export function __resetMemoDebounceMs(): void {
  memoDebounceMs = null;
}

let exportPollMs: number | null = null;
export function __setExportPollMs(ms: number): void {
  exportPollMs = ms;
}
export function __resetExportPollMs(): void {
  exportPollMs = null;
}
function getExportPollMs(): number {
  return exportPollMs ?? DATASET_EXPORT_POLL_MS;
}

/** An export that has not finished one way or another. */
export function isLiveExport(status: ExportStatus | null | undefined): boolean {
  return status != null && (status.state === 'queued' || status.state === 'running');
}

/**
 * Overall completion, 0–1, composing the two numbers the exporter reports.
 *
 * `done` alone stands still through a long episode — the bar then looks stuck
 * exactly when the operator is most likely to think something broke — so the
 * episode being worked on contributes its own fraction. Guarded on both sides:
 * no total means no claim (null, and the caller shows an indeterminate state
 * rather than 0 %), and the result never exceeds 1 whatever the exporter says.
 */
export function exportFraction(status: ExportStatus | null): number | null {
  if (status == null || !status.total) return null;
  const pct = status.current_episode_pct;
  const partial = typeof pct === 'number' && pct > 0 && pct < 100 ? pct / 100 : 0;
  return Math.min(1, (status.done + partial) / status.total);
}

/**
 * Why Convert cannot be pressed, in words — or null when it can.
 *
 * Pure and exported so the rule is testable on its own, and so the button's
 * `disabled` and the sentence under it can never disagree: they are the same
 * value read twice.
 */
export function convertBlockedReason({
  profile,
  preflight,
  preflightLoading,
  preflightFailed,
  taskFallback,
}: {
  profile: ExportProfile | null;
  preflight: ExportPreflight | null;
  preflightLoading: boolean;
  preflightFailed: boolean;
  taskFallback: string;
}): string | null {
  if (!profile) return 'Pick a profile to convert with.';
  // `valid: false` is the converter's own loader refusing the file. `null` is
  // NOT that — it means this image has no converter to ask, which is reported
  // as unchecked and left to the operator rather than blocking them.
  if (profile.valid === false) {
    return 'This profile does not validate, so the conversion would be refused.';
  }
  if (preflightFailed) {
    return 'The pre-conversion check could not be read, so what this would ' +
      'convert is unknown.';
  }
  if (preflightLoading || !preflight) return 'Checking what would be converted…';
  if (preflight.included === 0) {
    return 'Nothing here can be converted: every member is excluded, still ' +
      'recording, or not on this machine.';
  }
  if (preflight.output_exists) {
    return `${preflight.output} already exists — change the memo to give this ` +
      'conversion its own folder.';
  }
  if (preflight.tasks.unlabeled > 0 && taskFallback.trim() === '') {
    const n = preflight.tasks.unlabeled;
    return n === 1
      ? 'One capture carries no task label, so the conversion needs a ' +
          'fallback task to write for it.'
      : `${n} captures carry no task label, so the conversion needs a ` +
          'fallback task to write for them.';
  }
  return null;
}

export interface LeRobotExportState {
  /** This installation can convert (exporter present + a profile library).
   *  False = the control is not rendered at all. */
  enabled: boolean;
  /** The selected dataset may be offered the control right now. */
  canConvert: boolean;
  profiles: ExportProfile[];
  /** The exporter has no converter to validate its library with, which is why
   *  every profile's `valid` is null. Only a literal `true` from the server
   *  sets this — an exporter that does not report it leaves it false, and the
   *  dialog then says only what it knows. */
  validatorUnavailable: boolean;

  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;

  profileName: string;
  setProfileName: (name: string) => void;
  /** The selected profile object, or null while none is chosen. */
  profile: ExportProfile | null;
  memo: string;
  setMemo: (memo: string) => void;
  taskFallback: string;
  setTaskFallback: (task: string) => void;
  /** The dialog shows the fallback-task field only when the preflight says
   *  some capture has no label of its own. */
  taskRequired: boolean;

  preflight: ExportPreflight | null;
  /** True while no preflight answer for the CURRENT profile+memo is in hand. */
  preflightLoading: boolean;
  preflightError: unknown;

  /** Why Convert is disabled, or null when it is not. */
  blockedReason: string | null;
  submit: () => void;
  submitting: boolean;
  submitError: unknown;

  /** The dataset's export as the server last reported it; null = none. */
  status: ExportStatus | null;
  /** Queued or running. */
  live: boolean;
  /** Overall completion 0–1, or null when the total is not known yet. */
  fraction: number | null;
  /** A terminal export this session watched and the operator has not yet
   *  dismissed — what keeps the outcome (and the output path) on screen. */
  showResult: boolean;
  /** Dismiss that outcome and go back to the form. */
  acknowledge: () => void;
  cancel: () => void;
  canceling: boolean;
  cancelError: unknown;
}

export function useLeRobotExport({
  dataset,
  onToast,
}: {
  dataset: Dataset | null;
  onToast: (message: string) => void;
}): LeRobotExportState {
  const queryClient = useQueryClient();
  const datasetId = dataset?.dataset_id ?? null;

  const [open, setOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [memo, setMemo] = useState('');
  const [taskFallback, setTaskFallback] = useState('');
  const [debouncedMemo, setDebouncedMemo] = useState('');
  const [acknowledged, setAcknowledged] = useState<string | null>(null);

  useEffect(() => {
    const ms = memoDebounceMs ?? MEMO_DEBOUNCE_MS;
    const timer = setTimeout(() => setDebouncedMemo(memo), ms);
    return () => clearTimeout(timer);
  }, [memo]);

  // ---- capability --------------------------------------------------------

  const configQuery = useQuery({
    queryKey: queryKeys.exportsConfig,
    queryFn: ({ signal }) => getExportsConfig(signal),
  });
  const profiles = useMemo(
    () => configQuery.data?.profiles ?? [],
    [configQuery.data],
  );
  const enabled = (configQuery.data?.enabled ?? false) && profiles.length > 0;
  const validatorUnavailable = configQuery.data?.validator_unavailable === true;
  const profile = useMemo(
    () => profiles.find((p) => p.name === profileName) ?? null,
    [profiles, profileName],
  );

  // A dataset whose bytes have gone (an archived-move) is NOT gated out here.
  // It preflights to `included: 0` and the dialog says so in the operator's own
  // terms — which is more useful than a control that quietly is not there.
  const canConvert = enabled && dataset !== null && dataset.member_count > 0;

  // ---- the running export ------------------------------------------------

  const statusQuery = useQuery({
    queryKey: queryKeys.datasetExport(datasetId ?? ''),
    queryFn: ({ signal }) => getDatasetExport(datasetId ?? '', signal),
    enabled: datasetId !== null,
    // One read per selection, then 1 s only while something is actually live.
    refetchInterval: (query) =>
      isLiveExport(query.state.data) ? getExportPollMs() : false,
  });
  const status = statusQuery.data ?? null;
  const live = isLiveExport(status);

  // Which exports THIS session saw running. A terminal export that was already
  // over when the screen loaded is history, not an outcome to announce; one we
  // watched finish is the answer to something the operator started.
  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (live && status) watchedRef.current.add(status.export_id);
  }, [live, status]);
  const watched = status != null && watchedRef.current.has(status.export_id);
  const showResult = watched && !live && status.export_id !== acknowledged;

  // The completion toast fires on the observed edge, whether or not the dialog
  // is still open — the conversion kept running either way.
  const toastedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!status || live || !watchedRef.current.has(status.export_id)) return;
    if (status.state !== 'complete') return;
    if (toastedRef.current === status.export_id) return;
    toastedRef.current = status.export_id;
    onToast(
      `Converted ${status.done} episode${status.done === 1 ? '' : 's'} to ` +
        `${status.output}`,
    );
  }, [status, live, onToast]);

  // ---- preflight ---------------------------------------------------------

  const preflightQuery = useQuery({
    queryKey: queryKeys.exportPreflight(datasetId ?? '', profileName, debouncedMemo),
    queryFn: ({ signal }) =>
      getExportPreflight(datasetId ?? '', profileName, debouncedMemo, signal),
    enabled: open && !live && datasetId !== null && profileName !== '',
    // The destination check (`output_exists`) is about the filesystem as it is
    // right now, so a cached answer from before another export landed there
    // would be exactly the wrong thing to trust.
    staleTime: 0,
  });
  const preflight = preflightQuery.data ?? null;
  // "Loading" means: no answer for THIS profile+memo yet — including while the
  // debounce is still holding a newer memo back. Anything else would let the
  // dialog present the previous name's verdict as this name's.
  const preflightLoading =
    preflightQuery.isFetching || memo !== debouncedMemo || preflightQuery.isPending;
  const taskRequired = (preflight?.tasks.unlabeled ?? 0) > 0;

  // ---- the two writes ----------------------------------------------------

  const submitMutation = useMutation({
    mutationFn: () =>
      startDatasetExport(datasetId ?? '', {
        profile: profileName,
        memo: memo.trim() || null,
        task_fallback: taskRequired ? taskFallback.trim() || null : null,
      }),
    onSuccess: async (accepted) => {
      // No status is invented from the 202 — it says the job was ACCEPTED, not
      // what the exporter is doing with it. The first real status is one read
      // away, and until it lands the dialog says exactly that.
      watchedRef.current.add(accepted.export_id);
      setAcknowledged(null);
      await queryClient.refetchQueries({
        queryKey: queryKeys.datasetExport(accepted.dataset_id),
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelDatasetExport(datasetId ?? ''),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.datasetExport(next.dataset_id), next);
    },
  });

  // A plain function, like the archive dialog's opener: it resets the two
  // mutations, whose objects are new on every render, so memoising it would
  // only invite a stale closure over them.
  const openDialog = () => {
    setOpen(true);
    setMemo('');
    setDebouncedMemo('');
    // The dataset's own task is the natural fallback for a member that carries
    // none — it is what the operator already said this set is.
    setTaskFallback(dataset?.task ?? '');
    // Auto-select: the only profile if there is one, else the first that
    // validates, else simply the first — a library where nothing validates
    // still has to be readable, errors and all.
    setProfileName((current) => {
      if (current && profiles.some((p) => p.name === current)) return current;
      const valid = profiles.find((p) => p.valid !== false);
      return (valid ?? profiles[0])?.name ?? '';
    });
    submitMutation.reset();
    cancelMutation.reset();
  };

  const closeDialog = useCallback(() => setOpen(false), []);

  // A dataset switch takes the dialog down with it: it is addressed to one
  // dataset, and leaving it up over a different selection is how an operator
  // converts the wrong set.
  useEffect(() => {
    setOpen(false);
    setAcknowledged(null);
  }, [datasetId]);

  const blockedReason = convertBlockedReason({
    profile,
    preflight,
    preflightLoading,
    preflightFailed: preflightQuery.isError,
    taskFallback,
  });

  return {
    enabled,
    canConvert,
    profiles,
    validatorUnavailable,
    open,
    openDialog,
    closeDialog,
    profileName,
    setProfileName,
    profile,
    memo,
    setMemo,
    taskFallback,
    setTaskFallback,
    taskRequired,
    preflight,
    preflightLoading,
    preflightError: preflightQuery.isError ? preflightQuery.error : null,
    blockedReason,
    submit: () => {
      if (blockedReason !== null || submitMutation.isPending) return;
      submitMutation.mutate();
    },
    submitting: submitMutation.isPending,
    submitError: submitMutation.isError ? submitMutation.error : null,
    status,
    live,
    fraction: exportFraction(status),
    showResult,
    acknowledge: () => {
      if (status) setAcknowledged(status.export_id);
      submitMutation.reset();
    },
    cancel: () => {
      if (!cancelMutation.isPending) cancelMutation.mutate();
    },
    canceling: cancelMutation.isPending,
    cancelError: cancelMutation.isError ? cancelMutation.error : null,
  };
}
