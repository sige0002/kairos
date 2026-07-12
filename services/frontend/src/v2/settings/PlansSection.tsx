// Settings > Projects & tasks (the mock's "Plans" section) — projects list
// (middle column) + selected project's tasks/conditions editor (right
// column). Drives the Collect screen's Project/Task/Condition pickers
// conceptually; sharing that state with Collect is Phase 2 (Collect keeps
// its own local PLANS catalog today — see src/v2/collect/useBatchMachine.ts),
// so this editor is local state seeded with the same catalog values.

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
    addTask,
    renameTask,
    removeTask,
    addCondition,
    renameCondition,
    removeCondition,
  } = settings;

  const project = plans[planProjIdx]!;
  const task = project.tasks[planTaskIdx];

  return (
    <>
      <Card className="flex flex-col overflow-auto" data-testid="plan-projects">
        <div className="border-b border-gray-100 px-4 py-[13px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Projects
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {plans.map((p, i) => {
            const nConditions = p.tasks.reduce((n, t) => n + t.conditions.length, 0);
            return (
              <button
                key={p.name}
                type="button"
                data-testid={`plan-project-${i}`}
                onClick={() => selectProject(i)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-[11px] border px-[13px] py-[11px] text-left',
                  i === planProjIdx ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
                )}
              >
                <span className="text-[13px] font-semibold text-gray-900">{p.name}</span>
                <span className="text-[11.5px] text-gray-400">
                  {p.tasks.length} task{p.tasks.length === 1 ? '' : 's'} · {nConditions} conditions
                </span>
              </button>
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
        <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
          <span data-testid="plan-project-name" className="text-[15px] font-bold text-gray-900">
            {project.name}
          </span>
          <button
            type="button"
            onClick={renameProject}
            className="rounded-[8px] border border-gray-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-gray-500 hover:bg-gray-50"
          >
            Rename
          </button>
          <div className="flex-1" />
          <span className="text-xs text-gray-400">used by Collect pickers &amp; batch plans</span>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
          <div className="flex flex-col gap-2 overflow-auto border-r border-gray-100 p-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Tasks
            </span>
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
                <span className="font-mono text-[11px] text-gray-400">
                  {t.conditions.length} cond
                </span>
                <button
                  type="button"
                  onClick={() => removeTask(i)}
                  title="Remove task"
                  className="px-0.5 text-xs text-gray-300 hover:text-gray-500"
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
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Conditions — {task?.name ?? '—'}
              </span>
              <button
                type="button"
                onClick={renameTask}
                disabled={!task}
                className="rounded-[7px] border border-gray-200 bg-white px-2.5 py-[3px] text-[11px] font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-40"
              >
                Rename task
              </button>
            </div>
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
                  className="text-[11.5px] font-semibold text-gray-400 hover:text-teal-700"
                >
                  edit
                </button>
                <button
                  type="button"
                  onClick={() => removeCondition(i)}
                  title="Remove condition"
                  className="px-0.5 text-xs text-gray-300 hover:text-gray-500"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addCondition}
              disabled={!task}
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
      </Card>
    </>
  );
}
