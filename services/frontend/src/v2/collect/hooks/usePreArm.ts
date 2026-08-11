// Pre-arm engine (two-phase start), extracted from useBatchMachine.ts.
// While the operator sits ready-to-record, keep the recorder ARMED — a
// standing /record/prepare, kept alive by matching re-prepares shortly before
// its disarm deadline — so Start is a near-instant resume instead of a
// multi-second spawn + DDS-discovery wait. Bounded and honest:
//  - config-gated (recording.pre_arm): an armed recorder carries
//    recording-level DDS receive load, so a tight-budget robot turns it off;
//  - only while this tab is visible and the phase is ready/result (the
//    recorder's own prepare_disarm_timeout_s cleans up an abandoned arm);
//  - best-effort for STARTING: a failed prepare never blocks Start, which
//    simply falls back to the full synchronous path. But a pre-arm that KEEPS
//    failing is surfaced (`preArmDegraded`) and retried with backoff: silently
//    retrying every 30 s hid a persistent arm blocker (topic mismatch, disk
//    full) from the operator while — before the S2-7 recorder fix — minting a
//    failed capture per attempt.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../../api/client';
import { prepareRecord } from '../../../api/record';
import { RECORDING_CONFIG_KEY, queryKeys } from '../../../api/queryKeys';
import type {
  RecordStartRequest,
  RecordState,
  RecordingConfigPayload,
} from '../../../api/types';
import {
  PREARM_DEGRADED_AFTER_FAILURES,
  PREARM_KEEPALIVE_LEAD_MS,
  PREARM_RETRY_MAX_MS,
  PREARM_RETRY_MS,
  type Phase,
} from '../machine/types';
import { ApiError } from '../../../api/client';

/** Test seam (the stop-confirm one's shape): the real retry cadence lives in
 *  machine/types.ts; overriding lets a test walk failure → backoff → degraded
 *  in milliseconds instead of sitting through 30 s retries. */
let retryBaseMsOverride: number | null = null;
export function __setPreArmRetryBaseMs(ms: number | null): void {
  retryBaseMsOverride = ms;
}

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
}): { preArmed: boolean; preArmDegraded: string | null } {
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
  // Consecutive prepare failures. Drives both the retry backoff (30 s doubling
  // to a 5 min cap — a persistent blocker does not need probing every 30 s)
  // and the degraded surface below. A single failure is usually a lost race
  // with a start and stays silent; only a STREAK is worth the operator's eyes.
  const failStreakRef = useRef(0);
  const [preArmDegraded, setPreArmDegraded] = useState<string | null>(null);

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
      prepareRecord(body)
        .then(() => {
          lastPreparedKeyRef.current = topicsKey;
          failStreakRef.current = 0;
          setPreArmDegraded(null);
          // Reflect armed + the new disarm_at on the shared status query; the
          // effect re-runs off that data and schedules the next keep-alive.
          void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
        })
        .catch((err: unknown) => {
          // Start never blocks on this (it falls back to the full synchronous
          // path), but a STREAK of failures is a real condition the operator
          // can fix (topic mismatch, disk full) — surface it and back off
          // instead of silently reprobing every 30 s forever.
          failStreakRef.current += 1;
          if (failStreakRef.current >= PREARM_DEGRADED_AFTER_FAILURES) {
            setPreArmDegraded(
              err instanceof ApiError
                ? err.message
                : 'The recorder is not answering pre-arm requests.',
            );
          }
          if (!cancelled) {
            const base = retryBaseMsOverride ?? PREARM_RETRY_MS;
            schedule(
              Math.min(base * 2 ** (failStreakRef.current - 1), PREARM_RETRY_MAX_MS),
            );
          }
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

  return { preArmed, preArmDegraded };
}
