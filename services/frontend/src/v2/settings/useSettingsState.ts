// Local state for the Settings screen: menu selection and the plans
// (project/task/condition) editor. Robot selection is real and lives in
// RobotsSection (GET /api/v1/config/options). The plans catalog is the SHARED
// v2/plans store (single source of truth with Collect) — this hook keeps its
// interactions (select, add, rename, remove) and just writes that store, so an
// edit here shows up in Collect immediately. The store's server model is Phase
// 2.5; it's browser-local for now.

import { useCallback, useState } from 'react';
import { clonePlans, type PlanProjectData } from './data';
import {
  setFailReasons,
  setOperators,
  setPlans,
  useFailReasons,
  useOperators,
  usePlans,
} from '../plans';
import { useToast } from '../shared/useToast';

export interface SettingsState {
  menuIdx: number;
  selectMenu: (i: number) => void;

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

  operators: string[];
  addOperator: () => void;
  renameOperator: (i: number) => void;
  removeOperator: (i: number) => void;

  toast: string;
  showToast: (message: string) => void;
}

export function useSettingsState(): SettingsState {
  const [menuIdx, setMenuIdx] = useState(0);
  // The catalog lives in the shared store; mutations below call setPlans (which
  // persists + notifies Collect). Only the editor's cursor is local.
  const plans = usePlans();
  const failReasons = useFailReasons();
  const operators = useOperators();
  const [planProjIdx, setPlanProjIdx] = useState(0);
  const [planTaskIdx, setPlanTaskIdx] = useState(0);
  const { toast, showToast } = useToast();

  const selectMenu = useCallback((i: number) => setMenuIdx(i), []);

  // The catalog can legitimately be EMPTY. This editor blocks removing the last
  // project (see removeProject), but the catalog is SHARED: another terminal — or
  // a direct `PUT /api/v1/plans {"projects": []}` — can empty it, and this browser
  // adopts an explicitly-emptied catalog as-is (plans.ts adoptServerPlans). So
  // `plans[ppIdx]` may be undefined; clamping alone is not enough (on an empty
  // catalog `plans.length - 1` is -1, and plans[-1] is undefined). Every handler
  // below no-ops when there is no selected project, and PlansSection renders an
  // empty state.
  const ppIdx = Math.max(0, Math.min(planProjIdx, plans.length - 1));
  const planProj = plans[ppIdx];
  // ONE clamped task cursor per render, used by the handlers below AND returned
  // to PlansSection. They used to disagree — the view derived `disabled` from
  // the clamped index while the handlers read the raw state — so after a
  // partial shrink (the project survives, its task list shortens) "+ Add
  // condition" was ENABLED and silently did nothing. Sharing one value makes
  // that impossible: the control is correct, or it is disabled.
  const ptIdx = Math.min(planTaskIdx, Math.max(0, (planProj?.tasks.length ?? 0) - 1));
  // The clamp MOVED the cursor, i.e. the task the operator selected is no longer
  // there and a different one is being shown. Derived rather than stored, so
  // picking any task clears it — that click IS the re-confirmation.
  const taskSelectionLost = planTaskIdx > ptIdx && (planProj?.tasks.length ?? 0) > 0;

  const selectProject = useCallback((i: number) => {
    setPlanProjIdx(i);
    setPlanTaskIdx(0);
  }, []);
  const selectTask = useCallback((i: number) => setPlanTaskIdx(i), []);

  const addProject = useCallback(() => {
    const v = window.prompt('New project name', '');
    if (!v) return;
    const next = clonePlans(plans);
    next.push({ name: v, tasks: [] });
    setPlans(next);
    setPlanProjIdx(next.length - 1);
    setPlanTaskIdx(0);
    showToast(`Project "${v}" added`);
  }, [plans, showToast]);

  const renameProject = useCallback(() => {
    const current = plans[ppIdx];
    if (!current) return;
    const v = window.prompt('Project name', current.name);
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.name = v;
    setPlans(next);
    showToast('Project renamed');
  }, [plans, ppIdx, showToast]);

  const removeProject = useCallback((i: number) => {
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
      showToast('Keep at least one project — the last one can’t be removed');
      return;
    }
    const nTasks = target.tasks.length;
    const ok = window.confirm(
      `Remove project “${target.name}”? Its ${nTasks} task${nTasks === 1 ? '' : 's'} ` +
        'will disappear from the Collect picker. Episodes already recorded keep their plan.',
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
    showToast(`Project “${target.name}” removed`);
  }, [plans, showToast]);

  const addTask = useCallback(() => {
    if (!plans[ppIdx]) return; // empty catalog: no project to add a task to
    const v = window.prompt('New task name', '');
    if (!v) return;
    const next = clonePlans(plans);
    const proj = next[ppIdx]!;
    proj.tasks.push({ name: v, conditions: [] });
    setPlans(next);
    setPlanTaskIdx(proj.tasks.length - 1);
    showToast(`Task "${v}" added`);
  }, [plans, ppIdx, showToast]);

  const renameTask = useCallback(() => {
    if (taskSelectionLost) return;
    const task = plans[ppIdx]?.tasks[ptIdx];
    if (!task) return;
    const v = window.prompt('Task name', task.name);
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.name = v;
    setPlans(next);
    showToast('Task renamed');
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  const removeTask = useCallback((i: number) => {
    if (!plans[ppIdx]?.tasks[i]) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks.splice(i, 1);
    setPlans(next);
    setPlanTaskIdx(0);
    showToast('Task removed from plan');
  }, [plans, ppIdx, showToast]);

  const addCondition = useCallback(() => {
    // No project (empty catalog) or no task yet — the button is disabled in both
    // cases, but the handler must not depend on that to stay safe.
    if (taskSelectionLost) return;
    if (!plans[ppIdx]?.tasks[ptIdx]) return;
    const v = window.prompt('New condition (e.g. "Object: Left → Tray: Center")', '');
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.conditions.push(v);
    setPlans(next);
    showToast('Condition added');
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  const renameCondition = useCallback((i: number) => {
    if (taskSelectionLost) return;
    const label = plans[ppIdx]?.tasks[ptIdx]?.conditions[i];
    if (label === undefined) return;
    const v = window.prompt('Condition', label);
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.conditions[i] = v;
    setPlans(next);
    showToast('Condition updated');
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  const removeCondition = useCallback((i: number) => {
    if (taskSelectionLost) return;
    if (plans[ppIdx]?.tasks[ptIdx]?.conditions[i] === undefined) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[ptIdx]!.conditions.splice(i, 1);
    setPlans(next);
    showToast('Condition removed');
  }, [plans, ppIdx, ptIdx, taskSelectionLost, showToast]);

  // Fail-reason vocabulary (Collect's "What failed?" chips) — same shared-store
  // funnel as the plans handlers above.
  const addFailReason = useCallback(() => {
    const v = window.prompt('New failure reason (e.g. "Grasp missed")', '');
    if (!v) return;
    setFailReasons([...failReasons, v]);
    showToast('Failure reason added');
  }, [failReasons, showToast]);

  const renameFailReason = useCallback((i: number) => {
    const label = failReasons[i];
    if (label === undefined) return;
    const v = window.prompt('Failure reason', label);
    if (!v) return;
    const next = failReasons.slice();
    next[i] = v;
    setFailReasons(next);
    showToast('Failure reason updated');
  }, [failReasons, showToast]);

  // Operator roster (attribution, not auth) — empty is allowed: it turns the
  // OP picker back into free text (see OperatorsSection's caption).
  const addOperator = useCallback(() => {
    const v = window.prompt('New operator name (e.g. "sadasue")', '');
    if (!v || !v.trim()) return;
    setOperators([...operators, v.trim()]);
    showToast('Operator added');
  }, [operators, showToast]);

  const renameOperator = useCallback(
    (i: number) => {
      const label = operators[i];
      if (label === undefined) return;
      const v = window.prompt('Operator name', label);
      if (!v || !v.trim()) return;
      const next = operators.slice();
      next[i] = v.trim();
      setOperators(next);
      showToast('Operator renamed');
    },
    [operators, showToast],
  );

  const removeOperator = useCallback(
    (i: number) => {
      setOperators(operators.filter((_, idx) => idx !== i));
      showToast('Operator removed');
    },
    [operators, showToast],
  );

  const removeFailReason = useCallback((i: number) => {
    // The last reason can't go: marking a Failure REQUIRES picking one (the
    // section's ✕ is disabled at one entry; the store refuses [] as well).
    if (failReasons.length <= 1) return;
    setFailReasons(failReasons.filter((_, idx) => idx !== i));
    showToast('Failure reason removed');
  }, [failReasons, showToast]);

  return {
    menuIdx,
    selectMenu,
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
    operators,
    addOperator,
    renameOperator,
    removeOperator,
    toast,
    showToast,
  };
}
