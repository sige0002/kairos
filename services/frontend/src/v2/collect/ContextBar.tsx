// Collect context bar: Project / Task / Batch / Episode / Condition cells plus
// the Batch menu. Project/task/condition are plan-based mock selections (see
// useBatchMachine's PLANS) — the backend has no plan/batch model yet.

import type { ReactNode } from 'react';
import { Card, cn } from '../../components/ui';
import { PLANS, findProject, type BatchMachine } from './useBatchMachine';

function CellButton({
  label,
  value,
  onClick,
  disabled,
  title,
}: {
  label: string;
  value: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        '-my-1 flex flex-col gap-0.5 rounded-control px-6 py-1 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-gray-50',
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-900">
        {value} <span className="text-[10px] text-gray-400">▾</span>
      </span>
    </button>
  );
}

function StaticCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-6">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
        {label}
      </span>
      <span className="font-mono text-sm font-semibold text-gray-900">{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="w-px self-stretch bg-gray-100" />;
}

function PickerPopover({
  className,
  heading,
  children,
}: {
  className: string;
  heading?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'absolute z-40 flex w-60 flex-col gap-0.5 rounded-card border border-gray-200 bg-white p-1.5 shadow-float',
        className,
      )}
    >
      {heading && (
        <span className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-400">
          {heading}
        </span>
      )}
      {children}
    </div>
  );
}

function PickItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-chip px-3 py-2 text-left text-sm transition-colors',
        active ? 'bg-teal-50 font-semibold text-teal-700' : 'font-medium text-gray-700 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-chip px-3 py-2 text-left text-sm font-medium',
        disabled ? 'cursor-not-allowed text-gray-300' : danger ? 'text-gray-700 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

export function ContextBar({ machine }: { machine: BatchMachine }) {
  const { phase, stats } = machine;
  const epNextText =
    phase === 'completed' ? '· complete' : phase === 'ended' ? '· ended early' : `· next #${stats.epNext}`;
  const curProject = findProject(machine.project);

  return (
    <Card className="relative flex shrink-0 items-center px-[18px] py-2.5">
      <CellButton
        label="Project"
        value={machine.project}
        onClick={machine.openProjPicker}
        disabled={!machine.ctxEditable}
        title="Change project (from plan)"
      />
      <Divider />
      <CellButton
        label="Task"
        value={machine.task}
        onClick={machine.openTaskPicker}
        disabled={!machine.ctxEditable}
        title="Change task (from plan)"
      />
      <Divider />
      <StaticCell label="Batch" value={`${machine.batchNum} / 5`} />
      <Divider />
      <StaticCell
        label="Episode"
        value={
          <>
            {stats.nRecorded} / 30 <span className="text-teal-600">{epNextText}</span>
          </>
        }
      />
      <Divider />
      <CellButton
        label="Condition"
        value={<span className="font-medium text-gray-700">{machine.condition}</span>}
        onClick={machine.openCondModal}
        disabled={!machine.condAllowed}
        title="Change condition (applies from next episode)"
      />
      <div className="flex-1" />
      <button
        type="button"
        onClick={machine.toggleBatchMenu}
        className="inline-flex items-center gap-1.5 rounded-control border border-gray-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50"
      >
        Batch menu <span className="text-[11px] text-gray-400">▾</span>
      </button>

      {machine.projPickerOpen && (
        <PickerPopover className="left-3.5 top-[58px]" heading="Project (from plan)">
          {PLANS.map((p) => (
            <PickItem key={p.name} active={p.name === machine.project} onClick={() => machine.pickProject(p.name)}>
              {p.name}
            </PickItem>
          ))}
        </PickerPopover>
      )}
      {machine.taskPickerOpen && (
        <PickerPopover className="left-[210px] top-[58px]" heading="Task (from plan)">
          {curProject.tasks.map((t) => (
            <PickItem key={t.name} active={t.name === machine.task} onClick={() => machine.pickTask(t.name)}>
              {t.name}
            </PickItem>
          ))}
        </PickerPopover>
      )}
      {machine.batchMenuOpen && (
        <PickerPopover className="right-3.5 top-[58px] w-56">
          <MenuItem onClick={machine.pauseBatch} disabled={phase !== 'ready'}>
            Pause batch
          </MenuItem>
          <MenuItem onClick={machine.openEndModal} danger>
            End batch early…
          </MenuItem>
          <MenuItem onClick={machine.openIssueModal}>Report issue…</MenuItem>
          <MenuItem onClick={machine.openCondModal} disabled={!machine.condAllowed}>
            Change condition…
          </MenuItem>
        </PickerPopover>
      )}
    </Card>
  );
}
