// Pre-arm engine (two-phase start), extracted from useBatchMachine.ts.
// While the operator sits ready-to-record, keep the recorder ARMED — a
// standing /record/prepare, kept alive by matching re-prepares shortly before
// its disarm deadline — so Start is a near-instant resume instead of a
// multi-second spawn + DDS-discovery wait. Bounded and honest:
//  - config-gated (recording.pre_arm): an armed recorder carries
//    recording-level DDS receive load, so a tight-budget robot turns it off;
//  - only while this tab is visible and the phase is ready/result (the
//    recorder's own prepare_disarm_timeout_s cleans up an abandoned arm);
//  - best-effort: a failed prepare is never surfaced — Start simply falls
//    back to the full synchronous path.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../../api/client';
import { RECORDING_CONFIG_KEY, queryKeys } from '../../../api/queryKeys';
import type {
  RecordPrepareResponse,
  RecordStartRequest,
  RecordState,
  RecordingConfigPayload,
} from '../../../api/types';
import {
  PREARM_KEEPALIVE_LEAD_MS,
  PREARM_RETRY_MS,
  type Phase,
} from '../machine/types';

export function usePreArm({
  phase,
  recorderState,
  noSelection,
  takeoverCaptureId,
  operator,
  task,
  selectionTopics,
  armingDisarmAt,
}: {
  phase: Phase;
  recorderState: RecordState | null;
  noSelection: boolean;
  takeoverCaptureId: string | null;
  operator: string;
  /** The machine's current task label (rides along on prepare; not matched). */
  task: string | null;
  selectionTopics: string[] | 'all';
  /** `arming.disarm_at` from /record/status, or null. */
  armingDisarmAt: string | null;
}): { preArmed: boolean } {
  const queryClient = useQueryClient();
  const recordingConfigQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) =>
      apiGet<RecordingConfigPayload>('/config/recording', { signal }),
    staleTime: 60_000,
  });
  const preArmEnabled = useMemo(() => {
    const cfg = recordingConfigQuery.data?.config;
    if (!cfg || typeof cfg !== 'object') return false; // unknown yet -> don't arm
    const tuning = (cfg as { recording?: { pre_arm?: unknown } }).recording;
    return tuning?.pre_arm !== false; // present-but-unset defaults on (model default)
  }, [recordingConfigQuery.data]);

  // Pause the engine while the tab is hidden (the recorder's TTL disarms an
  // abandoned session on its own); resume re-arms on the next visibility.
  const pageVisible = useSyncExternalStore(
    (notify) => {
      document.addEventListener('visibilitychange', notify);
      return () => document.removeEventListener('visibilitychange', notify);
    },
    () => document.visibilityState === 'visible',
    () => true,
  );

  // Arm while the operator is between recordings on this screen: 'ready' (about
  // to start) and 'result' (labeling — the next start follows right after).
  // recorderState gates out recording/stopping (incl. takeover) AND the
  // pre-first-poll null, so we never prepare blind.
  const preArmed = recorderState === 'armed';
  const preArmEligible =
    preArmEnabled &&
    !noSelection &&
    takeoverCaptureId == null &&
    (phase === 'ready' || phase === 'result') &&
    // A fresh recorder reports `created`; there is no `idle` on the wire (§10).
    (preArmed ||
      recorderState === 'created' ||
      recorderState === 'completed' ||
      recorderState === 'failed' ||
      recorderState === 'interrupted');

  // operator/task ride along on prepare for completeness but are NOT part of
  // the armed-session match (metadata comes from the eventual start request),
  // so they are read via refs — typing in the operator field must not re-fire
  // prepares.
  const operatorRef = useRef(operator);
  operatorRef.current = operator;
  const taskRef = useRef(task);
  taskRef.current = task;

  const preArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preArmInFlightRef = useRef(false);
  // JSON key of the last selection we prepared with: a selection change while
  // armed must re-prepare now (the recorder swaps the mismatched session).
  const lastPreparedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!preArmEligible || !pageVisible) {
      if (preArmTimerRef.current) {
        clearTimeout(preArmTimerRef.current);
        preArmTimerRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const topicsKey = JSON.stringify(selectionTopics);

    const schedule = (ms: number) => {
      if (preArmTimerRef.current) clearTimeout(preArmTimerRef.current);
      preArmTimerRef.current = setTimeout(fire, Math.max(ms, 1_000));
    };
    const fire = () => {
      if (cancelled || preArmInFlightRef.current) return;
      preArmInFlightRef.current = true;
      const body: RecordStartRequest = { topics: selectionTopics };
      if (operatorRef.current.trim()) body.operator = operatorRef.current.trim();
      if (taskRef.current?.trim()) body.task = taskRef.current.trim();
      apiPost<RecordPrepareResponse>('/record/prepare', body)
        .then(() => {
          lastPreparedKeyRef.current = topicsKey;
          // Reflect armed + the new disarm_at on the shared status query; the
          // effect re-runs off that data and schedules the next keep-alive.
          void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
        })
        .catch(() => {
          // Best-effort by design (e.g. 409 lost a race with a start, older
          // backend without /record/prepare): retry later, never surface.
          if (!cancelled) schedule(PREARM_RETRY_MS);
        })
        .finally(() => {
          preArmInFlightRef.current = false;
        });
    };

    if (!preArmed || lastPreparedKeyRef.current !== topicsKey) {
      fire();
    } else {
      // Armed and matching — extend shortly before the recorder's deadline.
      const deadlineMs = armingDisarmAt ? Date.parse(armingDisarmAt) : NaN;
      schedule(
        Number.isFinite(deadlineMs)
          ? deadlineMs - Date.now() - PREARM_KEEPALIVE_LEAD_MS
          : PREARM_RETRY_MS,
      );
    }
    return () => {
      cancelled = true;
      if (preArmTimerRef.current) {
        clearTimeout(preArmTimerRef.current);
        preArmTimerRef.current = null;
      }
    };
  }, [
    preArmEligible,
    pageVisible,
    preArmed,
    armingDisarmAt,
    selectionTopics,
    queryClient,
  ]);

  return { preArmed };
}
