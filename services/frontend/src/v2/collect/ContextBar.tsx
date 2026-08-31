// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collect context bar: Robot / Project / Task / Batch / Episode / Condition
// cells plus the Batch menu. Project/task/condition are plan-based mock
// selections (see useBatchMachine's PLANS) — the backend has no plan/batch
// model yet. The Robot cell is REAL: it lists config/<robot> sets from
// GET /config/options and switches the active robot via POST /config/select
// (same endpoints and cache-refresh set as the v1 Config tab), so cameras,
// default topics and expected-Hz all follow the selection immediately.

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfigOptions, selectConfig } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import { Card, cn } from '../../components/ui';
import { type BatchMachine } from './useBatchMachine';
import { usePlans } from '../plans';
import { RECORDING_CONFIG_KEY } from '../../api/queryKeys';
import { RecordingSoundControl } from './RecordingSoundControl';

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
        disabled
          ? 'cursor-not-allowed opacity-55'
          : 'cursor-pointer hover:bg-surface-muted',
      )}
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {label}
      </span>
      <span className="text-sm font-semibold text-text-primary">
        {value} <span className="text-[10px] text-text-muted">▾</span>
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
  return (
    <span className="font-normal text-text-muted">
      {i18n.t('collect:noPlansConfigured')}
    </span>
  );
}

function StaticCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-6">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
        {label}
      </span>
      <span className="font-mono text-sm font-semibold text-text-primary">{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="w-px self-stretch bg-surface-muted" />;
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
        'absolute z-40 flex w-60 max-w-[calc(100vw-58px)] flex-col gap-0.5 rounded-card border border-border bg-surface p-1.5 shadow-float',
        className,
      )}
    >
      {heading && (
        <span className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
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
          ? 'bg-interaction-selected font-semibold text-accent'
          : 'font-medium text-text-primary hover:bg-surface-muted',
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
          ? 'cursor-not-allowed text-text-muted'
          : danger
            ? 'text-text-primary hover:bg-status-danger-bg'
            : 'text-text-primary hover:bg-surface-muted',
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
  const { t } = useTranslation('collect');
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const select = useMutation({
    mutationFn: (id: string) => selectConfig({ category: 'robot', id }),
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
        label={t('robot')}
        value={select.isPending ? t('switching') : (active ?? '—')}
        onClick={onToggle}
        disabled={disabled || robots.length === 0 || select.isPending}
        title={t('switchRobotHelp')}
      />
      {open && (
        <PickerPopover
          className="left-0 top-full mt-1"
          heading={t('robotAppliesImmediately')}
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
                <span className="text-[10px] text-text-muted">
                  {' '}
                  · {t('localConfig')}
                </span>
              ) : null}
            </PickItem>
          ))}
        </PickerPopover>
      )}
    </div>
  );
}

export function ContextBar({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation('collect');
  const { phase, stats, selection } = machine;
  // Live shared catalog — a project/task added in Settings shows up here at once.
  const plans = usePlans();
  const epNextText =
    phase === 'completed'
      ? `· ${t('complete').toLowerCase()}`
      : phase === 'ended'
        ? `· ${t('endedEarly')}`
        : `· ${t('next', { number: String(stats.epNext) })}`;
  // This fallback only supplies choices after Settings removed the selected
  // project. Clicking one is an explicit new ID selection; it is never used
  // to resolve task-specific shortcuts for the stale machine context.
  const curProject =
    plans.find((project) => project.project_id === machine.projectId) ?? plans[0];
  // Real count of what the NEXT recording captures (config defaults + the
  // Monitor picker), mirroring v1 LiveTab's idleTopicLabel.
  const recTopicsLabel = selection.customized
    ? t('topicCount', { count: selection.count })
    : selection.topics === 'all'
      ? t('allTopics')
      : t('configuredTopicCount', { count: selection.count });

  return (
    <Card className="relative flex shrink-0 flex-wrap items-center gap-y-1 px-[18px] py-2.5 [@media(max-height:860px)]:py-1.5">
      <CellButton
        label={t('project')}
        value={planCellValue(machine.project)}
        onClick={machine.openProjPicker}
        disabled={!machine.ctxEditable}
        title={t('changeProjectHelp')}
      />
      <Divider />
      <CellButton
        label={t('task')}
        value={planCellValue(machine.task)}
        onClick={machine.openTaskPicker}
        disabled={!machine.ctxEditable}
        title={t('changeTaskHelp')}
      />
      <Divider />
      {/* Server batch number, no fabricated "/5"
          planned-count. Before the batch is created (on the first recording) we
          show an honest, muted prediction of the number it will most likely get
          rather than a bare "—". The real number is assigned server-side, hence
          "next". */}
      <StaticCell
        label={t('batch')}
        value={
          machine.batchSeq != null ? (
            `${t('batch')} ${machine.batchSeq}`
          ) : (
            <span className="font-normal text-text-muted">
              {t('next', { number: String(machine.predictedSeq ?? 1) })}
              <span className="ml-1.5 font-sans text-[11px] font-normal text-text-muted">
                · {t('assignedOnFirstRecording')}
              </span>
            </span>
          )
        }
      />
      <Divider />
      <StaticCell
        label={t('episodeLabel')}
        value={
          <>
            {/* A rebuild reconstructs the counter from the sidecars still on
                disk, so it cannot count a capture that was reviewed in and
                later deleted. Saying "12 / 30" of a lower bound sends the
                operator to re-record takes they already have. */}
            {machine.recordedIsFloor && (
              <span title={t('reconstructedCountHelp')}>&ge; </span>
            )}
            {stats.nRecorded} / {machine.targetEpisodes}{' '}
            <span className="text-accent">{epNextText}</span>
          </>
        }
      />
      <Divider />
      <CellButton
        label={t('condition')}
        value={
          <span className="font-medium text-text-primary">{machine.condition}</span>
        }
        onClick={machine.openCondModal}
        disabled={!machine.condAllowed}
        title={t('changeConditionHelp')}
      />
      <Divider />
      <RobotCell
        disabled={!machine.ctxEditable}
        open={machine.robotPickerOpen}
        onToggle={machine.toggleRobotPicker}
      />
      <div className="flex-1" />
      <RecordingSoundControl
        settings={machine.recordingCueSettings}
        open={machine.soundMenuOpen}
        onToggle={machine.toggleSoundMenu}
      />
      <button
        type="button"
        onClick={machine.goMonitor}
        title={t('recordingTopicsHelp')}
        data-testid="rec-topics-chip"
        className="mr-2.5 inline-flex items-center gap-1.5 rounded-chip border border-accent bg-interaction-selected px-2.5 py-1.5 text-[11.5px] font-semibold text-accent hover:bg-interaction-selected"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-accent" />
        {t('recordingTopics', { topics: recTopicsLabel })}
      </button>
      <button
        type="button"
        onClick={machine.toggleBatchMenu}
        className="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-3.5 py-2 text-[13px] font-semibold text-text-primary hover:bg-surface-muted"
      >
        {t('batchMenu')} <span className="text-[11px] text-text-muted">▾</span>
      </button>

      {machine.projPickerOpen && (
        <PickerPopover
          className="left-3.5 top-full lg:top-[58px]"
          heading={t('projectFromPlan')}
        >
          {/* The one real dead end on an empty catalog: with nothing to pick
              this popover was a blank rectangle. (The Task picker has always
              had `Custom…`, so it is never a dead end.) */}
          {plans.length === 0 ? (
            <span className="px-3 pb-1.5 pt-0.5 text-[12px] leading-relaxed text-text-muted">
              {t('noProjectsInCatalog')}
            </span>
          ) : (
            plans.map((p) => (
              <PickItem
                key={p.project_id}
                active={p.project_id === machine.projectId}
                onClick={() => machine.pickProject(p.project_id)}
              >
                {p.name}
              </PickItem>
            ))
          )}
        </PickerPopover>
      )}
      {machine.taskPickerOpen && (
        <PickerPopover
          className="left-3.5 top-full lg:left-[210px] lg:top-[58px]"
          heading={t('taskFromPlan')}
        >
          {(curProject?.tasks ?? []).map((t) => (
            <PickItem
              key={t.task_id}
              active={t.task_id === machine.taskId}
              onClick={() => machine.pickTask(curProject!.project_id, t.task_id)}
            >
              {t.name}
            </PickItem>
          ))}
          {/* Free-text task (v1 parity): the operator could always type any task
              string at record time. Uses window.prompt to match the Plans
              editor's interaction style; sets it as the selected task without
              adding it to the shared plans catalog. */}
          <PickItem
            active={machine.taskId === null}
            onClick={() => {
              const entered = window.prompt(t('customTask'), '');
              if (entered && entered.trim()) machine.pickCustomTask(entered);
            }}
          >
            <span className="text-accent">{t('custom')}</span>
          </PickItem>
        </PickerPopover>
      )}
      {machine.batchMenuOpen && (
        <PickerPopover className="right-3.5 top-full w-56 lg:top-[58px]">
          <MenuItem onClick={machine.pauseBatch} disabled={phase !== 'ready'}>
            {t('pauseSet')}
          </MenuItem>
          <MenuItem onClick={machine.openEndModal} danger>
            {t('endBatch')}…
          </MenuItem>
          <MenuItem onClick={machine.openResetModal}>{t('resetBatch')}</MenuItem>
          <MenuItem onClick={machine.openTargetModal}>{t('changeTarget')}</MenuItem>
          <MenuItem onClick={machine.openCondModal} disabled={!machine.condAllowed}>
            {t('changeCondition')}
          </MenuItem>
        </PickerPopover>
      )}
    </Card>
  );
}
