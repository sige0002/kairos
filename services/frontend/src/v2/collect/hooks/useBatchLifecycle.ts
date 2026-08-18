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
import { createBatch, getBatch, listBatches } from '../../../api/batches';
import { getCapture, listCaptures } from '../../../api/captures';
import { getConfigOptions } from '../../../api/config';
import { queryKeys } from '../../../api/queryKeys';
import type { Capture, CaptureListItem } from '../../../api/types';
import { useUiStore } from '../../../store/uiStore';
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
  ensureBatch: () => Promise<string | null>;
} {
  const activeRobot = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const operator = useUiStore((s) => s.recordOperator).trim();
  const operatorHydrated = useUiStore((s) => s.operatorHydrated);
  const setBatchRestoreIssue = useUiStore((s) => s.setBatchRestoreIssue);

  // ---- batch lifecycle (server API) ----------------------------------------
  // A server batch is created lazily on the first recording of a batch (and
  // after "start next batch"), not eagerly, so merely opening Collect never
  // spawns empty batches. Recording never waits on it; the review save does
  // await it, because a batch_id that arrives after the save would leave the
  // capture ungrouped for good.
  const batchCreateRef = useRef<Promise<string | null> | null>(null);
  const ensureBatch = useCallback((): Promise<string | null> => {
    const s = getStoreSnapshot();
    if (s.batchId) return Promise.resolve(s.batchId);
    if (batchCreateRef.current) return batchCreateRef.current;
    const op = useUiStore.getState().recordOperator.trim();
    const pending = createBatch({
      // Omitted when there is no plan to name (2026-08-06: both are optional
      // server-side and stored as null). Sending the header's placeholder wrote
      // a label nobody chose into the shared catalog, on a row every terminal
      // reads and with nothing downstream able to tell it from a project
      // deliberately named "—". `condition` was already guarded this way.
      project: s.project ?? undefined,
      task: s.task ?? undefined,
      condition: s.condition && s.condition !== '—' ? s.condition : undefined,
      operator: op || undefined,
      target_episodes: s.targetEpisodes,
    })
      .then((batch) => {
        dispatch({
          type: 'SET_BATCH',
          batchId: batch.batch_id,
          batchSeq: typeof batch.batch_seq === 'number' ? batch.batch_seq : null,
        });
        return batch.batch_id;
      })
      .catch(() => {
        // API unreachable. The review still saves — a capture carries its own
        // review (§8) — it just belongs to no batch, which the receipt says.
        return null;
      })
      .finally(() => {
        batchCreateRef.current = null;
      });
    batchCreateRef.current = pending;
    return pending;
  }, []);

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

  return { ensureBatch };
}
