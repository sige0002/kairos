// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The server-batch lifecycle, extracted from useBatchMachine.ts: lazy batch
// creation (ensureBatch) and the once-per-page-load reconcile of the durable
// local batch context against the server's active batch (Phase 2 restore,
// phantom pruning). Everything here reads and writes the module store, so the
// hook takes no arguments.

import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../../../api/client';
import { createBatch, getBatch, listBatches } from '../../../api/batches';
import { getCapture, listCaptures } from '../../../api/captures';
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
    markServerHydrated();
    // One GET /batches serves both jobs: find the newest *active* batch (server
    // truth over the localStorage fallback) AND predict the next batch number from
    // today's batches (the honest pre-state before any batch exists). Restoring
    // that active batch then costs one more request — its detail, the only place
    // its captures are served.
    const atRestPhase = (p: Phase) =>
      p === 'ready' || p === 'completed' || p === 'ended' || p === 'paused';
    listBatches()
      .then(async (resp) => {
        const items = resp.items ?? [];
        // The predicted pre-state is always safe to refresh from today's batches.
        setPredictedSeq(predictNextSeq(items));
        if (!atRestPhase(getStoreSnapshot().phase)) return;
        const active = items.find((b) => b.status === 'active') ?? null;
        if (active) {
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
        // Server reports NO active batch. A local batch context here may be a
        // phantom left behind after the captures/batches were deleted
        // server-side (Apple P0). Confirm by checking the batch's captures still
        // exist, then discard the stale context so the hero counters never
        // report recordings that don't exist. We keep it on any /captures
        // failure (offline resilience) or when a capture still backs it.
        if (!hasLocalBatchContext(getStoreSnapshot())) return;
        let captures: CaptureListItem[];
        try {
          captures = (await listCaptures({ limit: 100 })).items;
        } catch {
          return; // /captures unreachable — keep the local context.
        }
        const after = getStoreSnapshot();
        if (
          atRestPhase(after.phase) &&
          hasLocalBatchContext(after) &&
          localBatchIsPhantom(after, captures)
        ) {
          clearLocalBatch();
        }
      })
      .catch(() => {
        /* API unreachable — keep the localStorage fallback; the pre-state falls
         *  back to "next #1" (predictedSeq stays null). */
      });
  }, []);

  return { ensureBatch };
}
