// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Live resolution of the three external operator actions for THIS machine:
// the current phase/result state plus the CURRENT TASK's configured failure
// shortcuts (#35), funneled through the ONE pure resolver in
// machine/externalActions.ts. The HUD renders `meanings` and the shortcut
// handler dispatches on the same value, so what the operator reads is exactly
// what a press will do. Switching Task (picker or batch rollover) re-resolves
// immediately — the displayed reasons follow the task.
//
// Takes explicit fields (not the whole machine) so it can be wired next to
// the other shortcut layer before the machine object is assembled.

import { useMemo } from 'react';
import { EMPTY_FAILURE_SHORTCUTS, usePlans } from '../../plans';
import {
  resolveExternalActionMeanings,
  type ExternalActionMeanings,
} from '../machine/externalActions';
import type { Phase } from '../machine/types';

export interface ExternalActionsInput {
  phase: Phase;
  pendingTask: 'ok' | 'fail' | null;
  isSavingReview: boolean;
  takeoverActive: boolean;
  /** READY's Start is usable (selection + operator gates cleared, no start
   *  in flight) — the same gates that disable the mouse Start button. */
  startEnabled: boolean;
  /** RECORDING's Stop is usable (the stop floor has passed) — the same gate
   *  that disables the mouse Stop button. */
  stopEnabled: boolean;
  project: string | null;
  task: string | null;
}

export interface ExternalActions {
  meanings: ExternalActionMeanings;
  /** The task the failure-reason slots resolve against (null: no catalog). */
  taskName: string | null;
}

export function useExternalActions(input: ExternalActionsInput): ExternalActions {
  const plans = usePlans();
  // Unlike picker rendering, an external action may SAVE a review. It must
  // never use findTask's display-oriented fallback: a custom or stale context
  // could otherwise trigger another task's configured failure reason.
  const task = plans
    .find((project) => project.name === input.project)
    ?.tasks.find((candidate) => candidate.name === input.task);
  return useMemo(
    () => ({
      meanings: resolveExternalActionMeanings({
        phase: input.phase,
        pendingTask: input.pendingTask,
        isSavingReview: input.isSavingReview,
        takeoverActive: input.takeoverActive,
        startEnabled: input.startEnabled,
        stopEnabled: input.stopEnabled,
        shortcuts: task?.failure_shortcuts ?? EMPTY_FAILURE_SHORTCUTS,
      }),
      taskName: task?.name ?? null,
    }),
    [
      input.phase,
      input.pendingTask,
      input.isSavingReview,
      input.takeoverActive,
      input.startEnabled,
      input.stopEnabled,
      input.project,
      input.task,
      task,
    ],
  );
}
