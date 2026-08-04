// Local state for the Settings screen: menu selection and the plans
// (project/task/condition) editor. Robot selection is real and lives in
// RobotsSection (GET /api/v1/config/options). The plans catalog is the SHARED
// v2/plans store (single source of truth with Collect) — this hook keeps its
// interactions (select, add, rename, remove) and just writes that store, so an
// edit here shows up in Collect immediately. The store's server model is Phase
// 2.5; it's browser-local for now.

import { useCallback, useEffect, useRef, useState } from 'react';
import { clonePlans, type PlanProjectData } from './data';
import {
  setFailReasons,
  setOperators,
  setPlans,
  useFailReasons,
  useOperators,
  usePlans,
} from '../plans';

const TOAST_MS = 2400;

export interface SettingsState {
  menuIdx: number;
  selectMenu: (i: number) => void;

  plans: PlanProjectData[];
  planProjIdx: number;
  planTaskIdx: number;
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
  const [toast, setToast] = useState('');

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);

  const selectMenu = useCallback((i: number) => setMenuIdx(i), []);

  // Projects can only be added, never removed, so `plans[ppIdx]` always exists.
  const ppIdx = Math.min(planProjIdx, plans.length - 1);
  const planProj = plans[ppIdx]!;

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
    // A plan needs at least one project: an empty catalog would crash the
    // editor (it reads plans[idx].name) and the store can't even persist it
    // (readInitial falls back to the defaults for a zero-length array). So
    // block the last removal with an honest note rather than half-doing it.
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
    const v = window.prompt('New task name', '');
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks.push({ name: v, conditions: [] });
    setPlans(next);
    setPlanTaskIdx(next[ppIdx]!.tasks.length - 1);
    showToast(`Task "${v}" added`);
  }, [plans, ppIdx, showToast]);

  const renameTask = useCallback(() => {
    const task = plans[ppIdx]?.tasks[planTaskIdx];
    if (!task) return;
    const v = window.prompt('Task name', task.name);
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[planTaskIdx]!.name = v;
    setPlans(next);
    showToast('Task renamed');
  }, [plans, ppIdx, planTaskIdx, showToast]);

  const removeTask = useCallback((i: number) => {
    const next = clonePlans(plans);
    next[ppIdx]!.tasks.splice(i, 1);
    setPlans(next);
    setPlanTaskIdx(0);
    showToast('Task removed from plan');
  }, [plans, ppIdx, showToast]);

  const addCondition = useCallback(() => {
    const v = window.prompt('New condition (e.g. "Object: Left → Tray: Center")', '');
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[planTaskIdx]!.conditions.push(v);
    setPlans(next);
    showToast('Condition added');
  }, [plans, ppIdx, planTaskIdx, showToast]);

  const renameCondition = useCallback((i: number) => {
    const label = plans[ppIdx]?.tasks[planTaskIdx]?.conditions[i];
    if (label === undefined) return;
    const v = window.prompt('Condition', label);
    if (!v) return;
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[planTaskIdx]!.conditions[i] = v;
    setPlans(next);
    showToast('Condition updated');
  }, [plans, ppIdx, planTaskIdx, showToast]);

  const removeCondition = useCallback((i: number) => {
    const next = clonePlans(plans);
    next[ppIdx]!.tasks[planTaskIdx]!.conditions.splice(i, 1);
    setPlans(next);
    showToast('Condition removed');
  }, [plans, ppIdx, planTaskIdx, showToast]);

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
    planTaskIdx: Math.min(planTaskIdx, Math.max(0, planProj.tasks.length - 1)),
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
