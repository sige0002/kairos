// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collect's context pickers (project / task / condition) and the set-rollover
// rule, extracted from useBatchMachine.ts: a context change once the current
// set already holds a recording closes that set and opens a fresh one; a set
// with nothing recorded is relabeled in place. Plus the advice pager.

import { useCallback, useRef, useState } from 'react';
import { patchBatch } from '../../../api/batches';
import { findProject, findTask, getPlans } from '../../plans';
import { ADVICE_ITEMS } from '../machine/types';
import { dispatch, getStoreSnapshot } from '../machine/store';

export function useCollectContext({
  ctxEditable,
  project,
  task,
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
  // Context is a server-backed fact once a batch exists. Serialising picker
  // actions prevents a slow first PATCH from landing after a fast second one
  // and making the local context claim the wrong server state.
  const contextChangeInFlightRef = useRef(false);

  const applyContextChange = useCallback(
    async ({
      changeLabel,
      rolloverReason,
      rolloverSuccessLabel,
      emptyPatch,
      next,
      closePicker,
      applyEmpty,
      emptySuccessToast,
    }: {
      changeLabel: string;
      rolloverReason: string;
      rolloverSuccessLabel: string;
      emptyPatch: Parameters<typeof patchBatch>[1];
      next: { project: string | null; task: string | null; condition: string };
      closePicker: () => void;
      applyEmpty: () => void;
      emptySuccessToast: string;
    }) => {
      if (contextChangeInFlightRef.current) return;
      contextChangeInFlightRef.current = true;
      const snapshot = getStoreSnapshot();
      const hasRecordedEpisodes = snapshot.recordedCount >= 1;
      const stillActive = snapshot.phase === 'ready' || snapshot.phase === 'paused';
      try {
        if (hasRecordedEpisodes) {
          if (snapshot.batchId && stillActive) {
            await patchBatch(snapshot.batchId, {
              status: 'ended_early',
              ended_reason: rolloverReason,
            });
          }
          const oldSeq = snapshot.batchSeq;
          dispatch({
            type: 'ROLLOVER_SET',
            project: next.project,
            task: next.task,
            condition: next.condition,
          });
          closePicker();
          showToast(
            oldSeq != null
              ? `Set #${oldSeq} closed (${rolloverSuccessLabel}) — next recording starts a new set`
              : `Set closed (${rolloverSuccessLabel}) — next recording starts a new set`,
          );
          return;
        }

        if (snapshot.batchId) await patchBatch(snapshot.batchId, emptyPatch);
        applyEmpty();
        closePicker();
        showToast(emptySuccessToast);
      } catch (err) {
        const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
        showToast(
          `${changeLabel} was not saved — the current context was kept. Retry the change.${detail}`,
        );
      } finally {
        contextChangeInFlightRef.current = false;
      }
    },
    [showToast],
  );

  // A context change (project/task/condition) once the current set already holds
  // a recording rolls the set over: close the current one (server-side too, if
  // it's still active) and open a fresh set carrying the new context. Earlier
  // episodes keep their original context — condition lives per-batch server-side,
  // so relabeling in place would retroactively mislabel them. A set with nothing
  // recorded yet is updated in place instead (no empty set is ever minted).
  const pickProject = useCallback(
    async (name: string) => {
      // Never re-label a take in flight, whatever left this handler reachable.
      if (!ctxEditable) return;
      const plan = findProject(getPlans(), name);
      const t0 = plan.tasks[0];
      const next = {
        project: plan.name,
        task: t0?.name ?? '—',
        condition: t0?.conditions[0] ?? '—',
      };
      await applyContextChange({
        changeLabel: 'Project',
        rolloverReason: 'Plan change',
        rolloverSuccessLabel: 'project changed',
        emptyPatch: {
          project: next.project,
          task: next.task,
          condition: next.condition !== '—' ? next.condition : null,
        },
        next,
        closePicker: () => setProjPickerOpen(false),
        applyEmpty: () => dispatch({ type: 'SET_PROJECT', ...next }),
        emptySuccessToast: 'Project switched — plan reloaded',
      });
    },
    [applyContextChange, ctxEditable, setProjPickerOpen],
  );
  const pickTask = useCallback(
    async (name: string) => {
      if (!ctxEditable) return;
      const t = findTask(getPlans(), project ?? '', name);
      const next = {
        project: project,
        task: t?.name ?? '—',
        condition: t?.conditions[0] ?? '—',
      };
      await applyContextChange({
        changeLabel: 'Task',
        rolloverReason: 'Task change',
        rolloverSuccessLabel: 'task changed',
        emptyPatch: {
          task: next.task,
          condition: next.condition !== '—' ? next.condition : null,
        },
        next,
        closePicker: () => setTaskPickerOpen(false),
        applyEmpty: () =>
          dispatch({ type: 'SET_TASK', task: next.task, condition: next.condition }),
        emptySuccessToast: 'Task switched',
      });
    },
    [applyContextChange, ctxEditable, project, setTaskPickerOpen],
  );
  const pickCustomTask = useCallback(
    async (name: string) => {
      if (!ctxEditable) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      // A free-text task has no plan-defined conditions; clear the condition to
      // '—' so a stale plan condition can't ride along with an unrelated task.
      const next = {
        project: project,
        task: trimmed,
        condition: '—',
      };
      await applyContextChange({
        changeLabel: 'Task',
        rolloverReason: 'Task change',
        rolloverSuccessLabel: 'task changed',
        emptyPatch: { task: trimmed, condition: null },
        next,
        closePicker: () => setTaskPickerOpen(false),
        applyEmpty: () => dispatch({ type: 'SET_TASK', task: trimmed, condition: '—' }),
        emptySuccessToast: 'Custom task set',
      });
    },
    [applyContextChange, ctxEditable, project, setTaskPickerOpen],
  );
  const pickCondition = useCallback(
    async (condition: string) => {
      if (!ctxEditable) return;
      const next = {
        project: project,
        task: task,
        condition,
      };
      await applyContextChange({
        changeLabel: 'Condition',
        rolloverReason: 'Condition change',
        rolloverSuccessLabel: 'condition changed',
        emptyPatch: { condition },
        next,
        closePicker: () => setCondModalOpen(false),
        applyEmpty: () => dispatch({ type: 'SET_CONDITION', condition }),
        emptySuccessToast: 'Condition updated',
      });
    },
    [applyContextChange, ctxEditable, project, setCondModalOpen, task],
  );
  const pickCustomCondition = useCallback(
    async (condition: string) => {
      if (!ctxEditable) return;
      const trimmed = condition.trim();
      if (!trimmed) return;
      const next = {
        project: project,
        task: task,
        condition: trimmed,
      };
      await applyContextChange({
        changeLabel: 'Condition',
        rolloverReason: 'Condition change',
        rolloverSuccessLabel: 'condition changed',
        emptyPatch: { condition: trimmed },
        next,
        closePicker: () => setCondModalOpen(false),
        applyEmpty: () => dispatch({ type: 'SET_CONDITION', condition: trimmed }),
        emptySuccessToast: 'Condition updated',
      });
    },
    [applyContextChange, ctxEditable, project, setCondModalOpen, task],
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
