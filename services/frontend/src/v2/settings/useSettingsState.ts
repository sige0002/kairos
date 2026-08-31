// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Local state for the Settings screen: menu selection and the plans
// (project/task/condition) editor. Robot selection is real and lives in
// RobotsSection (GET /api/v1/config/options). The plans catalog is the SHARED
// v2/plans store (single source of truth with Collect) — this hook keeps its
// interactions (select, add, rename, remove) and just writes that store, so an
// edit here shows up in Collect immediately. The store's server model is Phase
// 2.5; it's browser-local for now.

import { useCallback, useEffect, useState } from 'react';
import {
  clonePlans,
  DEFAULT_SETTINGS_SECTION_ID,
  getSettingsSection,
  type PlanProjectData,
  type SettingsSectionId,
} from './data';
import {
  clearFailureShortcutsForReason,
  renameFailureShortcuts,
  setFailReasons,
  setFailReasonsAndPlans,
  newPlanId,
  setOperators,
  setPlans,
  withTaskFailureShortcuts,
  useFailReasons,
  useOperators,
  usePlans,
  type FailureShortcutSlot,
} from '../plans';
import { useToast } from '../shared/useToast';
import { useOnPopState } from '../shared/useOnPopState';
import { i18n } from '../../i18n';

export interface SettingsState {
  sectionId: SettingsSectionId;
  selectSection: (id: SettingsSectionId) => void;

  plans: PlanProjectData[];
  planProjIdx: number;
  planTaskIdx: number;
  /** The selected task vanished (the catalog changed elsewhere) and a different
   *  one is on screen. The controls that act on "the selected task" stay inert
   *  until the operator picks one, so an edit never lands on a task they did
   *  not choose. */
  taskSelectionLost: boolean;
  selectProject: (i: number) => void;
  selectTask: (i: number) => void;
  addProject: () => void;
  renameProject: () => void;
  removeProject: (i: number) => void;
  addTask: () => void;
  renameTask: () => void;
  removeTask: (i: number) => void;
  addCondition: () => void;
  renameCondition: (i: number) => void;
  removeCondition: (i: number) => void;

  failReasons: string[];
  addFailReason: () => void;
  renameFailReason: (i: number) => void;
  removeFailReason: (i: number) => void;
  /** Assign (or clear, with null) one of the selected task's LEFT / CENTER /
   *  RIGHT failure shortcuts. The value must come from the shared
   *  failure-reason vocabulary; duplicates are prevented in the UI. */
  setTaskFailureShortcut: (slot: FailureShortcutSlot, reason: string | null) => void;

  operators: string[];
  addOperator: () => void;
  renameOperator: (i: number) => void;
  removeOperator: (i: number) => void;

  toast: string;
  showToast: (message: string) => void;
}

function sameCatalogName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function validateCatalogName(
  raw: string | null,
  label: string,
  existing: string[],
  showToast: (message: string) => void,
): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) {
    showToast(i18n.t('settings:plans.nameBlank', { label }));
    return null;
  }
  if (existing.some((name) => sameCatalogName(name, value))) {
    showToast(i18n.t('settings:plans.nameExists', { label, value }));
    return null;
  }
  return value;
}

function readSettingsSectionUrl(): SettingsSectionId {
  const section = getSettingsSection(
    new URLSearchParams(window.location.search).get('settings'),
  );
  return section?.id ?? DEFAULT_SETTINGS_SECTION_ID;
}

function writeSettingsSectionUrl(id: SettingsSectionId): void {
  const params = new URLSearchParams(window.location.search);
  if (id === DEFAULT_SETTINGS_SECTION_ID) params.delete('settings');
  else params.set('settings', id);
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  );
}

export function useSettingsState(): SettingsState {
  const [sectionId, setSectionId] = useState<SettingsSectionId>(readSettingsSectionUrl);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('settings');
    if (raw !== null && !getSettingsSection(raw)) {
      writeSettingsSectionUrl(DEFAULT_SETTINGS_SECTION_ID);
    }
  }, []);
  useOnPopState(() => {
    const raw = new URLSearchParams(window.location.search).get('settings');
    const section = getSettingsSection(raw);
    setSectionId(section?.id ?? DEFAULT_SETTINGS_SECTION_ID);
    if (raw !== null && !section) writeSettingsSectionUrl(DEFAULT_SETTINGS_SECTION_ID);
  });
  // The catalog lives in the shared store; mutations below call setPlans (which
  // persists + notifies Collect). Only the editor's cursor is local.
  const plans = usePlans();
  const failReasons = useFailReasons();
  const operators = useOperators();
  const [planProjIdx, setPlanProjIdx] = useState(0);
  const [planTaskIdx, setPlanTaskIdx] = useState(0);
  // Persist selection by identity rather than display name/index: a rename or
  // remote reorder must not quietly retarget the Settings editor.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { toast, showToast } = useToast();

  // Does any task's LEFT/CENTER/RIGHT slot name this reason? Decides whether a
  // vocabulary rename/remove must rewrite the task shortcuts in the SAME edit.
  const someTaskShortcutReferences = useCallback(
    (reason: string) =>
      plans.some((project) =>
        project.tasks.some((task) =>
          [
            task.failure_shortcuts.left,
            task.failure_shortcuts.center,
            task.failure_shortcuts.right,
          ].includes(reason),
        ),
      ),
    [plans],
  );

  const selectSection = useCallback((id: SettingsSectionId) => {
    setSectionId(id);
    writeSettingsSectionUrl(id);
  }, []);

  // The catalog can legitimately be EMPTY. This editor blocks removing the last
  // project (see removeProject), but the catalog is SHARED: another terminal — or
  // a direct `PUT /api/v1/plans {"projects": []}` — can empty it, and this browser
  // adopts an explicitly-emptied catalog as-is (plans.ts adoptServerPlans). So
  // `plans[ppIdx]` may be undefined; clamping alone is not enough (on an empty
  // catalog `plans.length - 1` is -1, and plans[-1] is undefined). Every handler
  // below no-ops when there is no selected project, and PlansSection renders an
  // empty state.
  const selectedProjectIdx = selectedProjectId
    ? plans.findIndex((project) => project.project_id === selectedProjectId)
    : -1;
  const ppIdx =
    selectedProjectIdx >= 0
      ? selectedProjectIdx
      : Math.max(0, Math.min(planProjIdx, plans.length - 1));
  const planProj = plans[ppIdx];
  // ONE clamped task cursor per render, used by the handlers below AND returned
  // to PlansSection. They used to disagree — the view derived `disabled` from
  // the clamped index while the handlers read the raw state — so after a
  // partial shrink (the project survives, its task list shortens) "+ Add
  // condition" was ENABLED and silently did nothing. Sharing one value makes
  // that impossible: the control is correct, or it is disabled.
  const selectedTaskIdx = selectedTaskId
    ? (planProj?.tasks.findIndex((task) => task.task_id === selectedTaskId) ?? -1)
    : -1;
  const ptIdx =
    selectedTaskIdx >= 0
      ? selectedTaskIdx
      : Math.min(planTaskIdx, Math.max(0, (planProj?.tasks.length ?? 0) - 1));
  // The clamp MOVED the cursor, i.e. the task the operator selected is no longer
  // there and a different one is being shown. Derived rather than stored, so
  // picking any task clears it — that click IS the re-confirmation.
  const taskSelectionLost =
    (selectedTaskId !== null && selectedTaskIdx === -1) ||
    (selectedTaskId === null &&
      planTaskIdx > ptIdx &&
      (planProj?.tasks.length ?? 0) > 0);

  const selectProject = useCallback(
    (i: number) => {
      setPlanProjIdx(i);
      setPlanTaskIdx(0);
      const project = plans[i];
      setSelectedProjectId(project?.project_id ?? null);
      setSelectedTaskId(project?.tasks[0]?.task_id ?? null);
    },
    [plans],
  );
  const selectTask = useCallback(
    (i: number) => {
      setPlanTaskIdx(i);
      setSelectedTaskId(planProj?.tasks[i]?.task_id ?? null);
    },
    [planProj],
  );

  const addProject = useCallback(() => {
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.newProject'), ''),
      i18n.t('settings:plans.projectName'),
      plans.map((project) => project.name),
      showToast,
    );
    if (!v) return;
    const next = clonePlans(plans);
    next.push({ project_id: newPlanId('project'), name: v, tasks: [] });
    setPlans(next);
    setPlanProjIdx(next.length - 1);
    setPlanTaskIdx(0);
    setSelectedProjectId(next.at(-1)?.project_id ?? null);
    setSelectedTaskId(null);
    showToast(i18n.t('settings:plans.projectAdded', { name: v }));
  }, [plans, showToast]);

  const renameProject = useCallback(() => {
    const current = plans[ppIdx];
    if (!current) return;
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.projectName'), current.name),
      i18n.t('settings:plans.projectName'),
      plans.filter((_, index) => index !== ppIdx).map((project) => project.name),
      showToast,
    );
    if (!v) return;
    if (v === current.name) return;
    const next = clonePlans(plans);
    next[ppIdx]!.name = v;
    setPlans(next);
    showToast(i18n.t('settings:plans.renamed'));
  }, [plans, ppIdx, showToast]);

  const removeProject = useCallback(
    (i: number) => {
      const target = plans[i];
      if (!target) return;
      // A plan needs at least one project: emptying it here leaves Collect with
      // no Project/Task/Condition vocabulary, and the store can't even persist
      // the result (readInitial falls back to the defaults for a zero-length
      // array), so the deleted projects would silently reappear on reload. Block
      // the last removal with an honest note rather than half-doing it. (An
      // empty catalog adopted from the SERVER is a different, supported case —
      // it renders PlansSection's empty state, see the ppIdx note above.)
      if (plans.length <= 1) {
        showToast(i18n.t('settings:plans.lastProject'));
        return;
      }
      const nTasks = target.tasks.length;
      const ok = window.confirm(
        i18n.t('settings:plans.removeProjectConfirm', {
          name: target.name,
          count: nTasks,
        }),
      );
      if (!ok) return;
      const next = clonePlans(plans);
      next.splice(i, 1);
      setPlans(next);
      // Keep the currently-selected project selected when a different one is
      // removed; otherwise land on the neighbour. Clamp into the shorter list.
      setPlanProjIdx((prev) => {
        const shifted = i < prev ? prev - 1 : prev;
        return Math.max(0, Math.min(shifted, next.length - 1));
      });
      setPlanTaskIdx(0);
      setSelectedProjectId(
        next[Math.max(0, Math.min(ppIdx, next.length - 1))]?.project_id ?? null,
      );
      setSelectedTaskId(null);
      showToast(i18n.t('settings:plans.projectRemoved', { name: target.name }));
    },
    [plans, showToast],
  );

  const addTask = useCallback(() => {
    if (!plans[ppIdx]) return; // empty catalog: no project to add a task to
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.newTask'), ''),
      i18n.t('settings:plans.taskName'),
      plans[ppIdx]!.tasks.map((task) => task.name),
      showToast,
    );
    if (!v) return;
    const next = clonePlans(plans);
    const proj = next[ppIdx]!;
    proj.tasks.push({
      task_id: newPlanId('task'),
      name: v,
      conditions: [],
      failure_shortcuts: { left: null, center: null, right: null },
    });
    setPlans(next);
    setPlanTaskIdx(proj.tasks.length - 1);
    setSelectedTaskId(proj.tasks.at(-1)?.task_id ?? null);
    showToast(i18n.t('settings:plans.taskAdded', { name: v }));
  }, [plans, ppIdx, showToast]);

  const renameTask = useCallback(() => {
    if (taskSelectionLost) return;
    const task = plans[ppIdx]?.tasks[ptIdx];
    if (!task) return;
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.taskName'), task.name),
      i18n.t('settings:plans.taskName'),
      plans[ppIdx]!.tasks.filter((_, index) => index !== ptIdx).map(
        (item) => item.name,
      ),
      showToast,
    );
    if (!v) return;
    if (v === task.name) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.name = v;
    setPlans(next);
    showToast(i18n.t('settings:plans.taskRenamed'));
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  const removeTask = useCallback(
    (i: number) => {
      const target = plans[ppIdx]?.tasks[i];
      if (!target) return;
      const ok = window.confirm(
        i18n.t('settings:plans.removeTaskConfirm', {
          name: target.name,
          count: target.conditions.length,
        }),
      );
      if (!ok) return;
      const next = clonePlans(plans);
      next[ppIdx]!.tasks.splice(i, 1);
      setPlans(next);
      setPlanTaskIdx(0);
      setSelectedTaskId(next[ppIdx]?.tasks[0]?.task_id ?? null);
      showToast(i18n.t('settings:plans.taskRemoved'));
    },
    [plans, ppIdx, showToast],
  );

  const addCondition = useCallback(() => {
    // No project (empty catalog) or no task yet — the button is disabled in both
    // cases, but the handler must not depend on that to stay safe.
    if (taskSelectionLost) return;
    if (!plans[ppIdx]?.tasks[ptIdx]) return;
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.conditionPrompt'), ''),
      i18n.t('settings:plans.condition'),
      plans[ppIdx]!.tasks[ptIdx]!.conditions.map((condition) => condition.name),
      showToast,
    );
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.conditions.push({
      condition_id: newPlanId('condition'),
      name: v,
    });
    setPlans(next);
    showToast(i18n.t('settings:plans.conditionAdded'));
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  const renameCondition = useCallback(
    (i: number) => {
      if (taskSelectionLost) return;
      const condition = plans[ppIdx]?.tasks[ptIdx]?.conditions[i];
      if (condition === undefined) return;
      const v = validateCatalogName(
        window.prompt(i18n.t('settings:plans.condition'), condition.name),
        i18n.t('settings:plans.condition'),
        plans[ppIdx]!.tasks[ptIdx]!.conditions.filter((_, index) => index !== i).map(
          (item) => item.name,
        ),
        showToast,
      );
      if (!v) return;
      if (v === condition.name) return;
      const next = clonePlans(plans);
      next[ppIdx]!.tasks[ptIdx]!.conditions[i]!.name = v;
      setPlans(next);
      showToast(i18n.t('settings:plans.conditionUpdated'));
    },
    [plans, ppIdx, ptIdx, taskSelectionLost, showToast],
  );

  const removeCondition = useCallback(
    (i: number) => {
      if (taskSelectionLost) return;
      const target = plans[ppIdx]?.tasks[ptIdx]?.conditions[i];
      if (target === undefined) return;
      const ok = window.confirm(
        i18n.t('settings:plans.removeConditionConfirm', { name: target.name }),
      );
      if (!ok) return;
      const next = clonePlans(plans);
      next[ppIdx]!.tasks[ptIdx]!.conditions.splice(i, 1);
      setPlans(next);
      showToast(i18n.t('settings:plans.conditionRemoved'));
    },
    [plans, ppIdx, ptIdx, taskSelectionLost, showToast],
  );

  // Fail-reason vocabulary (Collect's "What failed?" chips) — same shared-store
  // funnel as the plans handlers above.
  const addFailReason = useCallback(() => {
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.newFailureReason'), ''),
      i18n.t('settings:plans.failureReason'),
      failReasons,
      showToast,
    );
    if (!v) return;
    setFailReasons([...failReasons, v]);
    showToast(i18n.t('settings:plans.failureAdded'));
  }, [failReasons, showToast]);

  const renameFailReason = useCallback(
    (i: number) => {
      const label = failReasons[i];
      if (label === undefined) return;
      const v = validateCatalogName(
        window.prompt(i18n.t('settings:plans.failureReason'), label),
        i18n.t('settings:plans.failureReason'),
        failReasons.filter((_, index) => index !== i),
        showToast,
      );
      if (!v) return;
      if (v === label) return;
      const next = failReasons.slice();
      next[i] = v;
      // Renaming keeps the reason's identity: every task shortcut that named
      // it must follow to the new name, or the slot would silently point at a
      // reason that no longer exists (#35). One combined edit — a split
      // vocabulary/plans push would leave an intermediate catalog whose
      // shortcut the server's validation rejects.
      if (someTaskShortcutReferences(label)) {
        setFailReasonsAndPlans(next, renameFailureShortcuts(plans, label, v));
        showToast(i18n.t('settings:plans.failureUpdatedShortcuts'));
      } else {
        setFailReasons(next);
        showToast(i18n.t('settings:plans.failureUpdated'));
      }
    },
    [failReasons, plans, showToast, someTaskShortcutReferences],
  );

  // Operator roster (attribution, not auth) — empty is allowed: it turns the
  // OP picker back into free text (see OperatorsSection's caption).
  const addOperator = useCallback(() => {
    const v = validateCatalogName(
      window.prompt(i18n.t('settings:plans.newOperator'), ''),
      i18n.t('settings:plans.operatorName'),
      operators,
      showToast,
    );
    if (!v) return;
    setOperators([...operators, v]);
    showToast(i18n.t('settings:plans.operatorAdded'));
  }, [operators, showToast]);

  const renameOperator = useCallback(
    (i: number) => {
      const label = operators[i];
      if (label === undefined) return;
      const v = validateCatalogName(
        window.prompt(i18n.t('settings:plans.operatorName'), label),
        i18n.t('settings:plans.operatorName'),
        operators.filter((_, index) => index !== i),
        showToast,
      );
      if (!v) return;
      if (v === label) return;
      const next = operators.slice();
      next[i] = v;
      setOperators(next);
      showToast(i18n.t('settings:plans.operatorRenamed'));
    },
    [operators, showToast],
  );

  const removeOperator = useCallback(
    (i: number) => {
      const target = operators[i];
      if (target === undefined) return;
      const ok = window.confirm(
        i18n.t('settings:plans.removeOperatorConfirm', { name: target }),
      );
      if (!ok) return;
      setOperators(operators.filter((_, idx) => idx !== i));
      showToast(i18n.t('settings:plans.operatorRemoved'));
    },
    [operators, showToast],
  );

  const removeFailReason = useCallback(
    (i: number) => {
      // The last reason can't go: marking a Failure REQUIRES picking one (the
      // section's ✕ is disabled at one entry; the store refuses [] as well).
      if (failReasons.length <= 1) return;
      const target = failReasons[i];
      if (target === undefined) return;
      const clearsShortcut = someTaskShortcutReferences(target);
      const ok = window.confirm(
        i18n.t('settings:plans.removeFailureReasonConfirm', {
          name: target,
          shortcut: clearsShortcut
            ? i18n.t('settings:plans.failureShortcutNotice')
            : '',
        }),
      );
      if (!ok) return;
      const next = failReasons.filter((_, idx) => idx !== i);
      if (clearsShortcut) {
        // A removed reason must not leave a stale mapping that would save a
        // label nobody configured any more (#35) — clear the slot and say so.
        setFailReasonsAndPlans(next, clearFailureShortcutsForReason(plans, target));
        showToast(i18n.t('settings:plans.failureRemovedShortcuts'));
      } else {
        setFailReasons(next);
        showToast(i18n.t('settings:plans.failureRemoved'));
      }
    },
    [failReasons, plans, showToast, someTaskShortcutReferences],
  );

  // The selected task's shortcut editor writes the shared catalog through the
  // same funnel as every other plan edit (so Collect sees it immediately).
  const setTaskFailureShortcut = useCallback(
    (slot: FailureShortcutSlot, reason: string | null) => {
      if (taskSelectionLost) return;
      const task = plans[ppIdx]?.tasks[ptIdx];
      if (!task) return;
      if (reason !== null && !failReasons.includes(reason)) {
        // The selects only offer vocabulary members; this is the backstop for
        // a future caller (the server would reject it as unknown too).
        showToast(i18n.t('settings:plans.failureReasonUnknown', { reason }));
        return;
      }
      const next = withTaskFailureShortcuts(plans, task.task_id, {
        ...task.failure_shortcuts,
        [slot]: reason,
      });
      setPlans(next);
    },
    [plans, ppIdx, ptIdx, taskSelectionLost, failReasons, showToast],
  );

  return {
    sectionId,
    selectSection,
    plans,
    planProjIdx: ppIdx,
    planTaskIdx: ptIdx,
    taskSelectionLost,
    selectProject,
    selectTask,
    addProject,
    renameProject,
    removeProject,
    addTask,
    renameTask,
    removeTask,
    addCondition,
    renameCondition,
    removeCondition,
    failReasons,
    addFailReason,
    renameFailReason,
    removeFailReason,
    setTaskFailureShortcut,
    operators,
    addOperator,
    renameOperator,
    removeOperator,
    toast,
    showToast,
  };
}
