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
import type { SettingsState } from './useSettingsState';

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
        <div className="border-b border-gray-100 px-4 py-[13px]">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Projects
          </h2>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {plans.map((p, i) => {
            const nConditions = p.tasks.reduce((n, t) => n + t.conditions.length, 0);
            return (
              <div
                key={p.name}
                data-testid={`plan-project-${i}`}
                className={cn(
                  'flex items-center gap-2 rounded-[11px] border px-[13px] py-[11px]',
                  i === planProjIdx ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
                )}
              >
                <button
                  type="button"
                  onClick={() => selectProject(i)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                >
                  <span className="text-[13px] font-semibold text-gray-900">{p.name}</span>
                  <span className="text-[11.5px] text-gray-500">
                    {p.tasks.length} task{p.tasks.length === 1 ? '' : 's'} · {nConditions} conditions
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => removeProject(i)}
                  title="Remove project"
                  className="shrink-0 px-0.5 text-xs text-gray-500 hover:text-gray-500"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addProject}
            className="rounded-control border border-dashed border-gray-300 bg-white p-2.5 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
          >
            + Add project
          </button>
        </div>
      </Card>

      <Card className="flex min-w-0 flex-col overflow-auto" data-testid="plan-detail">
        {project ? (
          <>
            <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
              <h2 data-testid="plan-project-name" className="text-[15px] font-bold text-gray-900">
                {project.name}
              </h2>
              <button
                type="button"
                onClick={renameProject}
                className="rounded-[8px] border border-gray-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-gray-500 hover:bg-gray-50"
              >
                Rename
              </button>
              <div className="flex-1" />
              <span className="text-xs text-gray-500">used by Collect pickers &amp; batch plans</span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
              <div className="flex flex-col gap-2 overflow-auto border-r border-gray-100 p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                  Tasks
                </h3>
                {project.tasks.map((t, i) => (
                  <div
                    key={t.name}
                    data-testid={`plan-task-${i}`}
                    className={cn(
                      'flex items-center gap-2 rounded-control border px-3 py-[9px]',
                      i === planTaskIdx ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => selectTask(i)}
                      className="min-w-0 flex-1 text-left text-[13px] font-semibold text-gray-900"
                    >
                      {t.name}
                    </button>
                    <span className="font-mono text-[11px] text-gray-500">
                      {t.conditions.length} cond
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTask(i)}
                      title="Remove task"
                      className="px-0.5 text-xs text-gray-500 hover:text-gray-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addTask}
                  className="rounded-control border border-dashed border-gray-300 bg-white p-[9px] text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
                >
                  + Add task
                </button>
              </div>

              <div className="flex min-w-0 flex-col gap-2 overflow-auto px-[18px] py-[14px]">
                <div className="flex items-center gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                    Conditions — {task?.name ?? '—'}
                  </h3>
                  <button
                    type="button"
                    onClick={renameTask}
                    disabled={!task || taskSelectionLost}
                    className="rounded-[7px] border border-gray-200 bg-white px-2.5 py-[3px] text-[11px] font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Rename task
                  </button>
                </div>
                {taskSelectionLost && (
                  <p
                    data-testid="plan-task-selection-lost"
                    className="rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] leading-[1.5] text-amber-800"
                  >
                    The task you had selected is no longer in this project — the catalog changed
                    elsewhere. <span className="font-semibold">{task?.name}</span> is shown instead;
                    pick a task to edit it, so nothing is changed on a task you did not choose.
                  </p>
                )}
                {(task?.conditions ?? []).map((label, i) => (
                  <div
                    key={`${label}-${i}`}
                    data-testid={`plan-condition-${i}`}
                    className="flex items-center gap-2.5 rounded-control border border-gray-100 px-[13px] py-[9px]"
                  >
                    <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-teal-600" />
                    <span className="text-[13px] text-gray-700">{label}</span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => renameCondition(i)}
                      disabled={taskSelectionLost}
                      className="text-[11.5px] font-semibold text-gray-500 hover:text-teal-700 disabled:opacity-40"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCondition(i)}
                      disabled={taskSelectionLost}
                      title="Remove condition"
                      className="px-0.5 text-xs text-gray-500 hover:text-gray-500 disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addCondition}
                  disabled={!task || taskSelectionLost}
                  className="rounded-control border border-dashed border-gray-300 bg-white p-[9px] text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-40"
                >
                  + Add condition
                </button>
                <div className="rounded-control border border-gray-100 bg-gray-50 px-3 py-2.5 text-xs leading-[1.5] text-gray-500">
                  Changes here update the Collect Project / Task / Condition pickers immediately.
                  Episodes already recorded keep the plan version they were recorded under.
                </div>
              </div>
            </div>
          </>
        ) : (
          <div
            data-testid="plan-empty"
            className="flex flex-1 flex-col items-start justify-center gap-2.5 px-[18px] py-10"
          >
            <span className="text-[15px] font-bold text-gray-900">
              No projects in the shared catalog
            </span>
            <p className="max-w-[420px] text-[13px] leading-[1.6] text-gray-500">
              The Project / Task / Condition vocabulary is shared by every terminal, and this
              catalog is currently empty — so Collect&apos;s pickers have nothing to offer. Add the
              first project to start it.
            </p>
            <button
              type="button"
              data-testid="plan-add-first"
              onClick={addProject}
              className="mt-1 rounded-control bg-teal-700 px-4 py-2 text-[12.5px] font-semibold text-white shadow-btn hover:bg-teal-800"
            >
              + Add the first project
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
