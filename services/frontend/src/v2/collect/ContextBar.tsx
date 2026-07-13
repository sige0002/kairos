// Collect context bar: Robot / Project / Task / Batch / Episode / Condition
// cells plus the Batch menu. Project/task/condition are plan-based mock
// selections (see useBatchMachine's PLANS) — the backend has no plan/batch
// model yet. The Robot cell is REAL: it lists config/<robot> sets from
// GET /config/options and switches the active robot via POST /config/select
// (same endpoints and cache-refresh set as the v1 Config tab), so cameras,
// default topics and expected-Hz all follow the selection immediately.

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigOptions } from '../../api/types';
import { Card, cn } from '../../components/ui';
import { type BatchMachine } from './useBatchMachine';
import { findProject, usePlans } from '../plans';

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

/** Real robot selector — the v1 Config tab's robot switch, relocated here. */
function RobotCell({ disabled }: { disabled: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const options = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const select = useMutation({
    mutationFn: (id: string) => apiPost<ConfigOptions>('/config/select', { category: 'robot', id }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.configOptions, data);
      // Same refresh set as v1 ConfigTab's selectMutation: a robot switch
      // changes the runtime config (defaults + stream panes → the camera
      // tiles) and re-points the editable recording file.
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: ['config', 'recording'] });
    },
  });

  const robots = options.data?.robots ?? [];
  const active = options.data?.active_robot;
  return (
    <div className="relative">
      <CellButton
        label="Robot"
        value={select.isPending ? 'switching…' : (active ?? '—')}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || robots.length === 0 || select.isPending}
        title="Switch robot config (disabled while recording)"
      />
      {open && (
        <PickerPopover className="left-0 top-full mt-1" heading="Robot (applies immediately)">
          {robots.map((r) => (
            <PickItem
              key={r.id}
              active={r.id === active}
              onClick={() => {
                setOpen(false);
                if (r.id !== active) select.mutate(r.id);
              }}
            >
              {r.id}
              {r.local ? <span className="text-[10px] text-gray-400"> · local</span> : null}
            </PickItem>
          ))}
        </PickerPopover>
      )}
    </div>
  );
}

export function ContextBar({ machine }: { machine: BatchMachine }) {
  const { phase, stats, selection } = machine;
  // Live shared catalog — a project/task added in Settings shows up here at once.
  const plans = usePlans();
  const epNextText =
    phase === 'completed' ? '· complete' : phase === 'ended' ? '· ended early' : `· next #${stats.epNext}`;
  const curProject = findProject(plans, machine.project);
  // Real count of what the NEXT recording captures (config defaults + the
  // Monitor picker), mirroring v1 LiveTab's idleTopicLabel.
  const recTopicsLabel = selection.customized
    ? `${selection.count} topic${selection.count === 1 ? '' : 's'}`
    : selection.topics === 'all'
      ? 'all topics'
      : `${selection.count} configured`;

  return (
    <Card className="relative flex shrink-0 items-center px-[18px] py-2.5 [@media(max-height:860px)]:py-1.5">
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
      {/* Server batch number ("Batch N"), no fabricated "/5" planned-count. Shows
          "—" until the batch is created (on the first recording). */}
      <StaticCell
        label="Batch"
        value={machine.batchSeq != null ? `Batch ${machine.batchSeq}` : 'Batch —'}
      />
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
      <Divider />
      <RobotCell disabled={!machine.ctxEditable} />
      <div className="flex-1" />
      <button
        type="button"
        onClick={machine.goMonitor}
        title="Topics captured on the next recording — open Monitor to change the selection"
        data-testid="rec-topics-chip"
        className="mr-2.5 inline-flex items-center gap-1.5 rounded-chip border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-[11.5px] font-semibold text-teal-700 hover:bg-teal-100"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-teal-500" />
        REC {recTopicsLabel}
      </button>
      <button
        type="button"
        onClick={machine.toggleBatchMenu}
        className="inline-flex items-center gap-1.5 rounded-control border border-gray-200 bg-white px-3.5 py-2 text-[13px] font-semibold text-gray-700 hover:bg-gray-50"
      >
        Batch menu <span className="text-[11px] text-gray-400">▾</span>
      </button>

      {machine.projPickerOpen && (
        <PickerPopover className="left-3.5 top-[58px]" heading="Project (from plan)">
          {plans.map((p) => (
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
          {/* Free-text task (v1 parity): the operator could always type any task
              string at record time. Uses window.prompt to match the Plans
              editor's interaction style; sets it as the selected task without
              adding it to the shared plans catalog. */}
          <PickItem
            active={!curProject.tasks.some((t) => t.name === machine.task)}
            onClick={() => {
              const entered = window.prompt('Custom task', '');
              if (entered && entered.trim()) machine.pickCustomTask(entered);
            }}
          >
            <span className="text-teal-700">Custom…</span>
          </PickItem>
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
          <MenuItem onClick={machine.openResetModal}>Reset batch…</MenuItem>
          <MenuItem onClick={machine.openIssueModal}>Report issue…</MenuItem>
          <MenuItem onClick={machine.openCondModal} disabled={!machine.condAllowed}>
            Change condition…
          </MenuItem>
        </PickerPopover>
      )}
    </Card>
  );
}
