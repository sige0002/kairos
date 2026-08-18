// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The server-batch lifecycle, extracted from useBatchMachine.ts: lazy batch
// creation (ensureBatch) and the once-per-page-load reconcile of the durable
// local batch context against the server's active batch (Phase 2 restore,
// phantom pruning). Everything here reads and writes the module store, so the
// hook takes no arguments.

import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../../api/client';
import { createBatch, getBatch, listBatches, patchBatch } from '../../../api/batches';
import { getCapture, listCaptures } from '../../../api/captures';
import { getConfigOptions } from '../../../api/config';
import { queryKeys } from '../../../api/queryKeys';
import type {
  Batch,
  BatchDetail,
  BatchPatchRequest,
  Capture,
  CaptureListItem,
  CollectionContextSnapshot,
} from '../../../api/types';
import { useUiStore } from '../../../store/uiStore';
import { resolvePlanIds, usePlans } from '../../plans';
import { type Phase } from '../machine/types';
import {
  TOMBSTONE_STATES,
  applyServerRestore,
  clearLocalBatch,
  dispatch,
  getStoreSnapshot,
  hasLocalBatchContext,
  isServerHydrated,
  localBatchIsPhantom,
  markServerHydrated,
  predictNextSeq,
  pruneDeadEpisodes,
  setPredictedSeq,
} from '../machine/store';

export function useBatchLifecycle(): {
  ensureBatch: (verifyIdentity?: boolean) => Promise<string | null>;
  prepareRecordStartContext: () => Promise<CollectionContextSnapshot>;
} {
  const activeRobot = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const plans = usePlans();
  const operator = useUiStore((s) => s.recordOperator).trim();
  const operatorHydrated = useUiStore((s) => s.operatorHydrated);
  const setBatchRestoreIssue = useUiStore((s) => s.setBatchRestoreIssue);
  const activeRobotRef = useRef<string | null>(null);
  activeRobotRef.current = activeRobot.data?.active_robot?.trim() || null;

  const currentContext = useCallback((): Omit<
    CollectionContextSnapshot,
    'batch_id' | 'batch_seq'
  > => {
    const state = getStoreSnapshot();
    const textOrNull = (value: string | null | undefined) => {
      const text = value?.trim();
      return text && text !== '—' ? text : null;
    };
    const project = textOrNull(state.project);
    const task = textOrNull(state.task);
    const condition = textOrNull(state.condition);
    return {
      ...resolvePlanIds(plans, project, task, condition),
      project,
      task,
      condition,
      robot: activeRobotRef.current,
      operator: textOrNull(useUiStore.getState().recordOperator),
    };
  }, [plans]);

  // ---- batch lifecycle (server API) ----------------------------------------
  // A server batch is created lazily on the first recording of a batch (and
  // after "start next batch"), not eagerly, so merely opening Collect never
  // spawns empty batches. Both recording and review await it: the recording
  // snapshot must name exactly the batch the recorder started under.
  const batchCreateRef = useRef<Promise<string | null> | null>(null);
  const ensureBatch = useCallback(
    async (verifyIdentity = true): Promise<string | null> => {
      const normalise = (value: string | null | undefined) => value?.trim() || null;
      const matches = (
        desired: Omit<CollectionContextSnapshot, 'batch_id' | 'batch_seq'>,
        existing: Batch,
      ) =>
        // An unresolved active robot is not evidence that this batch belongs to
        // another robot. Leave the robot untouched until config answers.
        (desired.robot === null || desired.robot === normalise(existing.robot)) &&
        desired.project_id === (existing.project_id ?? null) &&
        desired.task_id === (existing.task_id ?? null) &&
        desired.condition_id === (existing.condition_id ?? null) &&
        desired.operator === normalise(existing.operator) &&
        desired.project === normalise(existing.project) &&
        desired.task === normalise(existing.task) &&
        desired.condition === normalise(existing.condition);
      const hasContent = (localRecorded: number, existing: BatchDetail) =>
        localRecorded > 0 ||
        existing.episode_count > 0 ||
        (existing.episodes_recorded ?? 0) > 0 ||
        existing.captures.length > 0;

      // A rollover changes the module state, then the next pass creates the new
      // lazy batch. A bounded loop avoids callback self-recursion and still
      // leaves an API failure as a null snapshot rather than a stale association.
      for (let pass = 0; pass < 3; pass += 1) {
        const desired = currentContext();
        const local = getStoreSnapshot();
        if (local.batchId) {
          // Review-saving only needs the known batch id. The Start boundary calls
          // the default identity-verifying path, where a stale association must
          // never be reused for a new recorder capture.
          if (!verifyIdentity) return local.batchId;
          let existing: BatchDetail;
          try {
            existing = await getBatch(local.batchId);
          } catch {
            // A batch whose identity cannot be confirmed is not safe to attach
            // to this capture. The recording may still proceed with null context.
            return null;
          }
          if (existing.status === 'active' && matches(desired, existing)) {
            dispatch({
              type: 'SET_BATCH',
              batchId: existing.batch_id,
              batchSeq:
                typeof existing.batch_seq === 'number' ? existing.batch_seq : null,
            });
            return local.batchId;
          }
          if (existing.status !== 'active') {
            dispatch({
              type: 'ROLLOVER_SET',
              project: local.project,
              task: local.task,
              condition: local.condition,
            });
            continue;
          }
          if (hasContent(local.recordedCount, existing)) {
            try {
              const ended = await patchBatch(local.batchId, {
                status: 'ended_early',
                ended_reason: 'identity change',
              });
              if (ended.status !== 'ended_early') return null;
            } catch {
              return null;
            }
            dispatch({
              type: 'ROLLOVER_SET',
              project: local.project,
              task: local.task,
              condition: local.condition,
            });
            continue;
          }
          const patch: BatchPatchRequest = {
            project_id: desired.project_id,
            task_id: desired.task_id,
            condition_id: desired.condition_id,
            project: desired.project,
            task: desired.task,
            condition: desired.condition,
            operator: desired.operator,
          };
          if (desired.robot !== null) patch.robot = desired.robot;
          try {
            const reused = await patchBatch(local.batchId, patch);
            if (reused.status !== 'active') return null;
            dispatch({
              type: 'SET_BATCH',
              batchId: reused.batch_id,
              batchSeq: typeof reused.batch_seq === 'number' ? reused.batch_seq : null,
            });
            return reused.batch_id;
          } catch {
            return null;
          }
        }

        if (batchCreateRef.current) {
          const pendingId = await batchCreateRef.current;
          if (!pendingId) return null;
          continue;
        }
        const pending = createBatch({
          // Omitted when there is no plan to name (2026-08-06: both are optional
          // server-side and stored as null). Sending the header's placeholder wrote
          // a label nobody chose into the shared catalog for good.
          project: desired.project ?? undefined,
          project_id: desired.project_id,
          task: desired.task ?? undefined,
          task_id: desired.task_id,
          condition: desired.condition ?? undefined,
          condition_id: desired.condition_id,
          robot: desired.robot ?? undefined,
          operator: desired.operator ?? undefined,
          target_episodes: local.targetEpisodes,
        })
          .then((batch) => {
            dispatch({
              type: 'SET_BATCH',
              batchId: batch.batch_id,
              batchSeq: typeof batch.batch_seq === 'number' ? batch.batch_seq : null,
            });
            return batch.batch_id;
          })
          .catch(() => null)
          .finally(() => {
            batchCreateRef.current = null;
          });
        batchCreateRef.current = pending;
        return pending;
      }
      return null;
    },
    [currentContext],
  );

  const prepareRecordStartContext =
    useCallback(async (): Promise<CollectionContextSnapshot> => {
      const before = currentContext();
      let batchId = await ensureBatch();
      // A robot picker is disabled during arming, but the shared operator can
      // still change from another window. Reconcile once more if the identity
      // changed while the first batch request was in flight.
      const after = currentContext();
      if (after.robot !== before.robot || after.operator !== before.operator) {
        batchId = await ensureBatch();
      }
      const state = getStoreSnapshot();
      const final = currentContext();
      return {
        batch_id: batchId,
        batch_seq: state.batchId === batchId ? state.batchSeq : null,
        ...final,
      };
    }, [currentContext, ensureBatch]);

  // Once-per-page-load reconcile with the server's active batch. Never on later
  // tab-switch remounts (module flag), and only while the machine is at rest, so
  // it can't disturb an in-progress recording. On failure the localStorage
  // restore already applied at store init stands.
  useEffect(() => {
    if (isServerHydrated()) return;
    const robot = activeRobot.data?.active_robot?.trim();
    // Do not let the cold in-memory store race the persisted identity: an
    // unfiltered active-batch query can attach this terminal to someone else's
    // work. No selected operator also has no safe ownership filter, so leave
    // local context untouched until they name themselves.
    if (!operatorHydrated || !robot || !operator) return;
    markServerHydrated();
    // The active restore is deliberately constrained by every ownership axis.
    // A second robot-only listing keeps the pre-start batch-number prediction
    // accurate (batch_seq is per robot, not per operator) without weakening
    // that restore boundary.
    const atRestPhase = (p: Phase) =>
      p === 'ready' || p === 'completed' || p === 'ended' || p === 'paused';
    Promise.all([
      listBatches({ status: 'active', robot, operator }),
      listBatches({ robot }),
    ])
      .then(async ([activeResponse, predictionResponse]) => {
        const items = activeResponse.items ?? [];
        // The predicted pre-state is always safe to refresh from this robot's
        // batches. It remains server-assigned when the first recording starts.
        setPredictedSeq(predictNextSeq(predictionResponse.items ?? []));
        if (!atRestPhase(getStoreSnapshot().phase)) return;
        if (items.length > 1) {
          // Newest-first is not a user decision. Refusing to guess keeps the
          // local context intact and makes the ambiguity visible in the shell.
          setBatchRestoreIssue('ambiguous');
          return;
        }
        const active = items[0] ?? null;
        if (active) {
          setBatchRestoreIssue(null);
          // The list is a count per batch, not a row per capture (E-27), so the
          // batch's episodes come from its detail. A detail that cannot be read
          // leaves the localStorage restore standing: adopting the list item
          // alone would put an empty strip beside a non-zero recorded count,
          // which the operator cannot tell from "nothing was recorded".
          let batchCaptures: Capture[];
          try {
            batchCaptures = (await getBatch(active.batch_id)).captures;
          } catch {
            return;
          }
          applyServerRestore(active, batchCaptures);
          // The merge may have kept local-only records for captures the server
          // has since deleted — indistinguishable, from the batch alone, from a
          // review save that hasn't landed (no batch_id yet). Ask about each
          // suspect and prune the proven-dead; a fetch failure keeps the record
          // (offline resilience beats a false removal).
          const serverIds = new Set(batchCaptures.map((c) => c.capture_id));
          const suspects = getStoreSnapshot()
            .episodes.map((e) => e.captureId)
            .filter((id): id is string => !!id && !serverIds.has(id));
          if (suspects.length > 0) {
            const dead = new Set<string>();
            await Promise.all(
              suspects.map(async (id) => {
                try {
                  const capture = await getCapture(id);
                  if (TOMBSTONE_STATES.has(capture.state)) dead.add(id);
                } catch (e) {
                  if (e instanceof ApiError && e.status === 404) dead.add(id);
                  // Other failures: keep the record.
                }
              }),
            );
            pruneDeadEpisodes(dead);
          }
          return;
        }
        setBatchRestoreIssue(null);
        // A zero-result restore does not replace or adopt anything. The only
        // cleanup kept here is the pre-existing P0 phantom guard, and it acts
        // only after positive evidence that this LOCAL batch and all of its
        // captures are gone; a just-finished or another operator's batch stays.
        const local = getStoreSnapshot();
        if (!hasLocalBatchContext(local) || !local.batchId) return;
        try {
          const localBatch = await getBatch(local.batchId);
          // The local batch still exists. Its status/owner may differ from this
          // filtered query, which is precisely why it must not be cleared.
          if (localBatch) return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) return;
        }
        let captures: CaptureListItem[];
        try {
          captures = (await listCaptures({ limit: 100 })).items;
        } catch {
          return;
        }
        const after = getStoreSnapshot();
        if (
          atRestPhase(after.phase) &&
          after.batchId === local.batchId &&
          localBatchIsPhantom(after, captures)
        ) {
          clearLocalBatch();
        }
      })
      .catch(() => {
        /* API unreachable — keep the localStorage fallback; the pre-state falls
         *  back to "next #1" (predictedSeq stays null). */
      });
  }, [
    activeRobot.data?.active_robot,
    operator,
    operatorHydrated,
    setBatchRestoreIssue,
  ]);

  return { ensureBatch, prepareRecordStartContext };
}
