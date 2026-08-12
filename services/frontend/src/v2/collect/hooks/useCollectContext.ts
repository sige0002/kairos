// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collect's context pickers (project / task / condition) and the set-rollover
// rule, extracted from useBatchMachine.ts: a context change once the current
// set already holds a recording closes that set and opens a fresh one; a set
// with nothing recorded is relabeled in place. Plus the advice pager.

import { useCallback, useState } from 'react';
import { patchBatch } from '../../../api/batches';
import { findProject, findTask, getPlans } from '../../plans';
import { ADVICE_ITEMS } from '../machine/types';
import { dispatch, getStoreSnapshot } from '../machine/store';

export function useCollectContext({
  ctxEditable,
  project,
  task,
  batchId,
  showToast,
  setProjPickerOpen,
  setTaskPickerOpen,
  setCondModalOpen,
}: {
  ctxEditable: boolean;
  project: string | null;
  task: string | null;
  batchId: string | null;
  showToast: (msg: string) => void;
  setProjPickerOpen: (open: boolean) => void;
  setTaskPickerOpen: (open: boolean) => void;
  setCondModalOpen: (open: boolean) => void;
}) {
  const [adviceIdx, setAdviceIdx] = useState(0);

  // A context change (project/task/condition) once the current set already holds
  // a recording rolls the set over: close the current one (server-side too, if
  // it's still active) and open a fresh set carrying the new context. Earlier
  // episodes keep their original context — condition lives per-batch server-side,
  // so relabeling in place would retroactively mislabel them. A set with nothing
  // recorded yet is updated in place instead (no empty set is ever minted).
  const rolloverSet = useCallback(
    (
      endedReason: string,
      changeLabel: string,
      next: { project: string | null; task: string | null; condition: string },
    ) => {
      // Only close a set that's still active server-side. A 'completed'/'ended'
      // set was already closed with its true terminal status (by confirmEpisode /
      // confirmEndBatch) — re-PATCHing would overwrite that; skip it. 'ready' and
      // 'paused' are the still-active at-rest phases.
      const stillActive =
        getStoreSnapshot().phase === 'ready' || getStoreSnapshot().phase === 'paused';
      const s = getStoreSnapshot();
      if (s.batchId && stillActive) {
        void patchBatch(s.batchId, {
          status: 'ended_early',
          ended_reason: endedReason,
        }).catch(() => {});
      }
      const oldSeq = s.batchSeq;
      dispatch({
        type: 'ROLLOVER_SET',
        project: next.project,
        task: next.task,
        condition: next.condition,
      });
      showToast(
        oldSeq != null
          ? `Set #${oldSeq} closed (${changeLabel}) — next recording starts a new set`
          : `Set closed (${changeLabel}) — next recording starts a new set`,
      );
    },
    [showToast],
  );

  const pickProject = useCallback(
    (name: string) => {
      // Never re-label a take in flight, whatever left this handler reachable.
      if (!ctxEditable) return;
      const plan = findProject(getPlans(), name);
      const t0 = plan.tasks[0];
      const next = {
        project: plan.name,
        task: t0?.name ?? '—',
        condition: t0?.conditions[0] ?? '—',
      };
      setProjPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Plan change', 'project changed', next);
        return;
      }
      dispatch({ type: 'SET_PROJECT', ...next });
      // An empty batch may already exist (e.g. after Start next set → ensureBatch).
      // Sync the relabel so later episodes don't drift from the operator's choice
      // in index.jsonl. A '—' (no) condition is omitted, matching the create path.
      if (batchId)
        void patchBatch(batchId, {
          project: next.project,
          task: next.task,
          condition: next.condition !== '—' ? next.condition : undefined,
        }).catch(() => {});
      showToast('Project switched — plan reloaded');
    },
    [batchId, ctxEditable, rolloverSet, showToast],
  );
  const pickTask = useCallback(
    (name: string) => {
      if (!ctxEditable) return;
      const t = findTask(getPlans(), project ?? '', name);
      const next = {
        project: project,
        task: t?.name ?? '—',
        condition: t?.conditions[0] ?? '—',
      };
      setTaskPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Task change', 'task changed', next);
        return;
      }
      dispatch({ type: 'SET_TASK', task: next.task, condition: next.condition });
      // Sync the relabel onto an already-created empty batch (see pickProject).
      if (batchId)
        void patchBatch(batchId, {
          task: next.task,
          condition: next.condition !== '—' ? next.condition : undefined,
        }).catch(() => {});
      showToast('Task switched');
    },
    [project, batchId, ctxEditable, rolloverSet, showToast],
  );
  const pickCustomTask = useCallback(
    (name: string) => {
      if (!ctxEditable) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      // A free-text task has no plan-defined conditions; clear the condition to
      // '—' so a stale plan condition can't ride along with an unrelated task.
      setTaskPickerOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Task change', 'task changed', {
          project: project,
          task: trimmed,
          condition: '—',
        });
        return;
      }
      dispatch({ type: 'SET_TASK', task: trimmed, condition: '—' });
      // Sync the task onto an already-created empty batch. A free-text task has
      // no plan condition ('—'), so only the task is sent — the batch keeps any
      // prior condition (PATCH can't clear it to null; a minor residual).
      if (batchId)
        void patchBatch(batchId, { task: trimmed }).catch(() => {});
      showToast('Custom task set');
    },
    [project, batchId, ctxEditable, rolloverSet, showToast],
  );
  const pickCondition = useCallback(
    (condition: string) => {
      setCondModalOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Condition change', 'condition changed', {
          project: project,
          task: task,
          condition,
        });
        return;
      }
      dispatch({ type: 'SET_CONDITION', condition });
      // Persist the condition change on the current server batch (best-effort).
      if (batchId) void patchBatch(batchId, { condition }).catch(() => {});
      showToast('Condition updated');
    },
    [project, task, batchId, rolloverSet, showToast],
  );
  const pickCustomCondition = useCallback(
    (condition: string) => {
      const trimmed = condition.trim();
      if (!trimmed) return;
      setCondModalOpen(false);
      if (getStoreSnapshot().recordedCount >= 1) {
        rolloverSet('Condition change', 'condition changed', {
          project: project,
          task: task,
          condition: trimmed,
        });
        return;
      }
      dispatch({ type: 'SET_CONDITION', condition: trimmed });
      // A free-text condition is just a string on the batch — persist it in place
      // the same way a catalog pick does (best-effort); never added to the plan.
      if (batchId)
        void patchBatch(batchId, { condition: trimmed }).catch(() => {});
      showToast('Condition updated');
    },
    [project, task, batchId, rolloverSet, showToast],
  );

  const advicePrev = useCallback(
    () => setAdviceIdx((i) => (i - 1 + ADVICE_ITEMS.length) % ADVICE_ITEMS.length),
    [],
  );
  const adviceNext = useCallback(
    () => setAdviceIdx((i) => (i + 1) % ADVICE_ITEMS.length),
    [],
  );

  return {
    pickProject,
    pickTask,
    pickCustomTask,
    pickCondition,
    pickCustomCondition,
    adviceIdx,
    advicePrev,
    adviceNext,
  };
}
