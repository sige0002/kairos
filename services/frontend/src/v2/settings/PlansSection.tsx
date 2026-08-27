// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Projects & tasks (the mock's "Plans" section) — projects list
// (middle column) + selected project's tasks/conditions editor (right
// column). Edits funnel through the SHARED plans store (src/v2/plans.ts):
// Collect's pickers update immediately, and the catalog is persisted
// server-side (PUT /api/v1/plans) so every terminal offers the same
// project/task/condition vocabulary — the labels stamped onto batches and
// episodes stay aggregable across machines.

import { Card, cn } from '../../components/ui';
import { FAILURE_SHORTCUT_SLOTS, type FailureShortcutSlot } from '../plans';
import type { SettingsState } from './useSettingsState';

const SHORTCUT_SLOTS: FailureShortcutSlot[] = FAILURE_SHORTCUT_SLOTS;

export function PlansSection({ settings }: { settings: SettingsState }) {
  const {
    plans,
    planProjIdx,
    planTaskIdx,
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
    taskSelectionLost,
    failReasons,
    setTaskFailureShortcut,
  } = settings;

  // The catalog can be EMPTY — it is shared, and a catalog emptied from another
  // terminal is adopted as-is (see useSettingsState's ppIdx note). Then there is
  // no selected project and the detail column shows an empty state instead of a
  // project that does not exist.
  const project = plans[planProjIdx];
  const task = project?.tasks[planTaskIdx];

  return (
    <>
      <Card className="flex flex-col overflow-auto" data-testid="plan-projects">
        <div className="border-b border-border px-4 py-[13px]">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            Projects
          </h2>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {plans.map((p, i) => {
            const nConditions = p.tasks.reduce((n, t) => n + t.conditions.length, 0);
            return (
              <div
                key={p.project_id}
                data-testid={`plan-project-${i}`}
                className={cn(
                  'flex items-center gap-2 rounded-[11px] border px-[13px] py-[11px]',
                  i === planProjIdx ? 'border-accent bg-interaction-selected' : 'border-border',
                )}
              >
                <button
                  type="button"
                  onClick={() => selectProject(i)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                >
                  <span className="text-[13px] font-semibold text-text-primary">{p.name}</span>
                  <span className="text-[11.5px] text-text-muted">
                    {p.tasks.length} task{p.tasks.length === 1 ? '' : 's'} · {nConditions} conditions
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeProject(i)}
                  title="Remove project"
                  className="shrink-0 px-0.5 text-xs text-text-muted hover:text-text-muted"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addProject}
            className="rounded-control border border-dashed border-border-strong bg-surface p-2.5 text-[12.5px] font-semibold text-accent hover:bg-interaction-selected"
          >
            + Add project
          </button>
        </div>
      </Card>

      <Card className="flex min-w-0 flex-col overflow-auto" data-testid="plan-detail">
        {project ? (
          <>
            <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-[13px]">
              <h2 data-testid="plan-project-name" className="text-[15px] font-bold text-text-primary">
                {project.name}
              </h2>
              <button
                type="button"
                onClick={renameProject}
                className="rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-text-muted hover:bg-surface-muted"
              >
                Rename
              </button>
              <div className="flex-1" />
              <span className="text-xs text-text-muted">used by Collect pickers &amp; batch plans</span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
              <div className="flex flex-col gap-2 overflow-auto border-r border-border p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                  Tasks
                </h3>
                {project.tasks.map((t, i) => (
                  <div
                    key={t.task_id}
                    data-testid={`plan-task-${i}`}
                    className={cn(
                      'flex items-center gap-2 rounded-control border px-3 py-[9px]',
                      i === planTaskIdx ? 'border-accent bg-interaction-selected' : 'border-border',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectTask(i)}
                      className="min-w-0 flex-1 text-left text-[13px] font-semibold text-text-primary"
                    >
                      {t.name}
                    </button>
                    <span className="font-mono text-[11px] text-text-muted">
                      {t.conditions.length} cond
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTask(i)}
                      title="Remove task"
                      className="px-0.5 text-xs text-text-muted hover:text-text-muted"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addTask}
                  className="rounded-control border border-dashed border-border-strong bg-surface p-[9px] text-[12.5px] font-semibold text-accent hover:bg-interaction-selected"
                >
                  + Add task
                </button>
              </div>

              <div className="flex min-w-0 flex-col gap-2 overflow-auto px-[18px] py-[14px]">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                    Conditions — {task?.name ?? '—'}
                  </h3>
                  <button
                    type="button"
                    onClick={renameTask}
                    disabled={!task || taskSelectionLost}
                    className="rounded-[7px] border border-border bg-surface px-2.5 py-[3px] text-[11px] font-semibold text-text-muted hover:bg-surface-muted disabled:opacity-40"
                  >
                    Rename task
                  </button>
                </div>
                {taskSelectionLost && (
                  <p
                    data-testid="plan-task-selection-lost"
                    className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[11.5px] leading-[1.5] text-status-warning-text"
                  >
                    The task you had selected is no longer in this project — the catalog changed
                    elsewhere. <span className="font-semibold">{task?.name}</span> is shown instead;
                    pick a task to edit it, so nothing is changed on a task you did not choose.
                  </p>
                )}
                {(task?.conditions ?? []).map((condition, i) => (
                  <div
                    key={condition.condition_id}
                    data-testid={`plan-condition-${i}`}
                    className="flex items-center gap-2.5 rounded-control border border-border px-[13px] py-[9px]"
                  >
                    <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-accent" />
                    <span className="text-[13px] text-text-primary">{condition.name}</span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => renameCondition(i)}
                      disabled={taskSelectionLost}
                      className="text-[11.5px] font-semibold text-text-muted hover:text-accent disabled:opacity-40"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      disabled={taskSelectionLost}
                      title="Remove condition"
                      className="px-0.5 text-xs text-text-muted hover:text-text-muted disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addCondition}
                  disabled={!task || taskSelectionLost}
                  className="rounded-control border border-dashed border-border-strong bg-surface p-[9px] text-[12.5px] font-semibold text-accent hover:bg-interaction-selected disabled:opacity-40"
                >
                  + Add condition
                </button>

                {/* Per-task LEFT / CENTER / RIGHT failure-reason shortcuts (#35):
                    the three slots Collect's external operator actions save when
                    Failure is selected. Values come from the shared vocabulary;
                    a slot may stay unassigned; the same reason cannot sit in two
                    slots of this task (the options disable it). */}
                <div
                  className="flex flex-col gap-1.5"
                  data-testid="plan-task-shortcuts"
                >
                  <div className="flex items-baseline gap-2 pt-1">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                      Failure shortcuts
                    </h3>
                    <span className="text-[11px] text-text-muted">
                      {task ? task.name : '—'} · saved by Collect&apos;s LEFT / CENTER / RIGHT
                      external actions after Failure is selected
                    </span>
                  </div>
                  {SHORTCUT_SLOTS.map((slot) => {
                    const assigned = task?.failure_shortcuts[slot] ?? null;
                    const takenElsewhere = (reason: string) =>
                      task !== undefined &&
                      SHORTCUT_SLOTS.some(
                        (other) =>
                          other !== slot && task.failure_shortcuts[other] === reason,
                      );
                    return (
                      <div key={slot} className="flex items-center gap-2.5">
                        <span
                          className="w-[52px] text-[11.5px] font-bold uppercase tracking-wide text-text-secondary"
                          data-testid={`plan-task-shortcut-slot-${slot}`}
                        >
                          {slot.toUpperCase()}
                        </span>
                        <select
                          data-testid={`plan-task-shortcut-${slot}`}
                          value={assigned ?? ''}
                          disabled={!task || taskSelectionLost}
                          onChange={(event) =>
                            setTaskFailureShortcut(
                              slot,
                              event.target.value === '' ? null : event.target.value,
                            )
                          }
                          className="h-[34px] min-w-0 flex-1 rounded-control border border-border bg-surface px-2 text-[12.5px] text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <option value="">Unassigned</option>
                          {failReasons.map((reason) => (
                            <option key={reason} value={reason} disabled={takenElsewhere(reason)}>
                              {reason}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-control border border-border bg-surface-muted px-3 py-2.5 text-xs leading-[1.5] text-text-muted">
                  Changes here update the Collect Project / Task / Condition pickers immediately.
                  Episodes already recorded keep the plan version they were recorded under.
                  Renaming or removing a failure reason updates or clears the shortcuts that
                  reference it.
                </div>
              </div>
            </div>
          </>
        ) : (
          <div
            data-testid="plan-empty"
            className="flex flex-1 flex-col items-start justify-center gap-2.5 px-[18px] py-10"
          >
            <span className="text-[15px] font-bold text-text-primary">
              No projects in the shared catalog
            </span>
            <p className="max-w-[420px] text-[13px] leading-[1.6] text-text-muted">
              The Project / Task / Condition vocabulary is shared by every terminal, and this
              catalog is currently empty — so Collect&apos;s pickers have nothing to offer. Add the
              first project to start it.
            </p>
            <button
              type="button"
              data-testid="plan-add-first"
              onClick={addProject}
              className="mt-1 rounded-control bg-accent px-4 py-2 text-[12.5px] font-semibold text-text-inverse shadow-btn hover:bg-accent-strong"
            >
              + Add the first project
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
