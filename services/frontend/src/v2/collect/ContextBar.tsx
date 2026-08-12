// Collect context bar: Robot / Project / Task / Batch / Episode / Condition
// cells plus the Batch menu. Project/task/condition are plan-based mock
// selections (see useBatchMachine's PLANS) — the backend has no plan/batch
// model yet. The Robot cell is REAL: it lists config/<robot> sets from
// GET /config/options and switches the active robot via POST /config/select
// (same endpoints and cache-refresh set as the v1 Config tab), so cameras,
// default topics and expected-Hz all follow the selection immediately.

import { type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfigOptions, selectConfig } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import { Card, cn } from '../../components/ui';
import { type BatchMachine } from './useBatchMachine';
import { findProject, usePlans } from '../plans';
import { RECORDING_CONFIG_KEY } from '../../api/queryKeys';

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
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-900">
        {value} <span className="text-[10px] text-gray-500">▾</span>
      </span>
    </button>
  );
}

/**
 * The catalog's "there is nothing here" fallback, as it arrives in the header.
 *
 * `createBatchMachineState` seeds project/task from the shared catalog and
 * falls back to this em dash when the catalog is empty — the same placeholder
 * `plans.ts` uses. It is not a name, and a header cell is the one place it must
 * not be rendered as though it were one: the operator gets a populated-looking
 * header with two cells they cannot act on and nothing saying why, or where the
 * fix is. (Reported as a side finding during E-5, which reached Collect from a
 * catalog another terminal emptied.)
 */
const NO_PLAN = '—';

function planCellValue(value: string | null): ReactNode {
  // `null` is the state the machine now holds when there is no catalog; the em
  // dash is the same state as restored from an older persisted blob.
  if (value !== null && value !== NO_PLAN) return value;
  return <span className="font-normal text-gray-500">no plans configured</span>;
}

function StaticCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-6">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
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
        <span className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500">
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
        active
          ? 'bg-teal-50 font-semibold text-teal-700'
          : 'font-medium text-gray-700 hover:bg-gray-50',
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
        disabled
          ? 'cursor-not-allowed text-gray-300'
          : danger
            ? 'text-gray-700 hover:bg-red-50'
            : 'text-gray-700 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

/** Real robot selector — the v1 Config tab's robot switch, relocated here. */
function RobotCell({
  disabled,
  open,
  onToggle,
}: {
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const select = useMutation({
    mutationFn: (id: string) =>
      selectConfig({ category: 'robot', id }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.configOptions, data);
      // Same refresh set as Settings > Robots' selectMutation: a robot switch
      // changes the runtime config (defaults + stream panes → the camera
      // tiles) and re-points the editable recording file.
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
    },
  });

  const robots = options.data?.robots ?? [];
  const active = options.data?.active_robot;

  // The open state lives in the machine (see toggleRobotPicker): the keyboard
  // shortcut layer has to be able to SEE this overlay, or `r` starts a take
  // behind the open list. The machine also closes it when the context stops
  // being editable — a list opened before Start must not stay live over a
  // running recording, where picking from it would switch robots with no
  // confirmation and no stop.

  return (
    <div className="relative">
      <CellButton
        label="Robot"
        value={select.isPending ? 'switching…' : (active ?? '—')}
        onClick={onToggle}
        disabled={disabled || robots.length === 0 || select.isPending}
        title="Switch robot config (disabled while recording)"
      />
      {open && (
        <PickerPopover
          className="left-0 top-full mt-1"
          heading="Robot (applies immediately)"
        >
          {robots.map((r) => (
            <PickItem
              key={r.id}
              active={r.id === active}
              onClick={() => {
                onToggle();
                // Defence in depth: never act on a selection the guard forbids,
                // rather than trusting the popover to have been dismissed.
                if (disabled) return;
                if (r.id !== active) select.mutate(r.id);
              }}
            >
              {r.id}
              {r.local ? (
                <span className="text-[10px] text-gray-500"> · local</span>
              ) : null}
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
    phase === 'completed'
      ? '· complete'
      : phase === 'ended'
        ? '· ended early'
        : `· next #${stats.epNext}`;
  const curProject = findProject(plans, machine.project ?? '');
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
        value={planCellValue(machine.project)}
        onClick={machine.openProjPicker}
        disabled={!machine.ctxEditable}
        title="Change project (from plan)"
      />
      <Divider />
      <CellButton
        label="Task"
        value={planCellValue(machine.task)}
        onClick={machine.openTaskPicker}
        disabled={!machine.ctxEditable}
        title="Change task (from plan)"
      />
      <Divider />
      {/* Server batch number, no fabricated "/5"
          planned-count. Before the batch is created (on the first recording) we
          show an honest, muted prediction of the number it will most likely get
          rather than a bare "—". The real number is assigned server-side, hence
          "next". */}
      <StaticCell
        label="Batch"
        value={
          machine.batchSeq != null ? (
            `Batch ${machine.batchSeq}`
          ) : (
            <span className="font-normal text-gray-500">
              next #{machine.predictedSeq ?? 1}
              <span className="ml-1.5 font-sans text-[11px] font-normal text-gray-500">
                · assigned on first recording
              </span>
            </span>
          )
        }
      />
      <Divider />
      <StaticCell
        label="Episode"
        value={
          <>
            {/* A rebuild reconstructs the counter from the sidecars still on
                disk, so it cannot count a capture that was reviewed in and
                later deleted. Saying "12 / 30" of a lower bound sends the
                operator to re-record takes they already have. */}
            {machine.recordedIsFloor && (
              <span title="At least this many — the count was rebuilt from the recordings still on disk, so takes deleted after review are not counted.">
                &ge;{' '}
              </span>
            )}
            {stats.nRecorded} / {machine.targetEpisodes}{' '}
            <span className="text-teal-600">{epNextText}</span>
          </>
        }
      />
      <Divider />
      <CellButton
        label="Condition"
        value={<span className="font-medium text-gray-700">{machine.condition}</span>}
        onClick={machine.openCondModal}
        disabled={!machine.condAllowed}
        title="Change condition (starts a new set once this one has recordings)"
      />
      <Divider />
      <RobotCell
        disabled={!machine.ctxEditable}
        open={machine.robotPickerOpen}
        onToggle={machine.toggleRobotPicker}
      />
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
        Batch menu <span className="text-[11px] text-gray-500">▾</span>
      </button>

      {machine.projPickerOpen && (
        <PickerPopover className="left-3.5 top-[58px]" heading="Project (from plan)">
          {/* The one real dead end on an empty catalog: with nothing to pick
              this popover was a blank rectangle. (The Task picker has always
              had `Custom…`, so it is never a dead end.) */}
          {plans.length === 0 ? (
            <span className="px-3 pb-1.5 pt-0.5 text-[12px] leading-relaxed text-gray-500">
              No projects in the shared catalog. Add one in Settings &gt; Projects &amp;
              tasks.
            </span>
          ) : (
            plans.map((p) => (
              <PickItem
                key={p.name}
                active={p.name === machine.project}
                onClick={() => machine.pickProject(p.name)}
              >
                {p.name}
              </PickItem>
            ))
          )}
        </PickerPopover>
      )}
      {machine.taskPickerOpen && (
        <PickerPopover className="left-[210px] top-[58px]" heading="Task (from plan)">
          {curProject.tasks.map((t) => (
            <PickItem
              key={t.name}
              active={t.name === machine.task}
              onClick={() => machine.pickTask(t.name)}
            >
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
            Pause set
          </MenuItem>
          <MenuItem onClick={machine.openEndModal} danger>
            End batch early…
          </MenuItem>
          <MenuItem onClick={machine.openResetModal}>Reset batch…</MenuItem>
          <MenuItem onClick={machine.openTargetModal}>Change target…</MenuItem>
          <MenuItem onClick={machine.openIssueModal}>Report issue…</MenuItem>
          <MenuItem onClick={machine.openCondModal} disabled={!machine.condAllowed}>
            Change condition…
          </MenuItem>
        </PickerPopover>
      )}
    </Card>
  );
}
