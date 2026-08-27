// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Collect-scoped modals (End batch early / Change condition)
// plus the toast. Rendered at the screen level per the design mock's MODALS
// section. ("Set" is the operator-facing name for a batch.)
//
// Discard is deliberately NOT here. On Collect it is one click with no dialog
// (user decision 2026-08-03: the press is the consent; the ledger records that
// no reason was asked) — only Review still opens the shared DiscardDialog,
// where §12's wording obligations live.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal, cn } from '../../components/ui';
import { END_REASONS, type BatchMachine } from './useBatchMachine';
import { usePlans } from '../plans';
import { Toast } from '../shared/Toast';
import { formatBytes } from '../review/format';

function ReasonChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-chip border px-3 py-1.5 text-xs font-semibold',
        active
          ? 'border-accent bg-interaction-selected text-accent'
          : 'border-border bg-surface font-medium text-text-muted',
      )}
    >
      {children}
    </button>
  );
}

function endReasonLabel(
  reason: string,
  t: (
    key:
      | 'endReasonWorkTime'
      | 'endReasonEquipment'
      | 'endReasonCondition'
      | 'endReasonSafety'
      | 'endReasonPlan'
      | 'endReasonOther',
  ) => string,
) {
  if (reason === 'Work time over') return t('endReasonWorkTime');
  if (reason === 'Equipment / system problem') return t('endReasonEquipment');
  if (reason === 'Condition change') return t('endReasonCondition');
  if (reason === 'Safety') return t('endReasonSafety');
  if (reason === 'Plan change') return t('endReasonPlan');
  return t('endReasonOther');
}

function EndBatchModal({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation(['collect', 'common']);
  const { stats } = machine;
  const canConfirm = !!machine.endReason;
  return (
    <Modal
      open={machine.endModalOpen}
      onClose={machine.closeModals}
      title={
        machine.batchSeq != null
          ? t('collect:endBatchEarlyNumber', { number: String(machine.batchSeq) })
          : t('collect:endBatchEarly')
      }
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={machine.confirmEndBatch}
            disabled={!canConfirm}
          >
            {t('collect:endBatch')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-control border border-border px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-text-primary">
            {stats.nRecorded}
          </div>
          <div className="text-[11px] text-text-muted">{t('collect:recorded')}</div>
        </div>
        <div className="rounded-control border border-border px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-text-muted">
            {stats.nRemaining}
          </div>
          <div className="text-[11px] text-text-muted">{t('collect:notRecorded')}</div>
        </div>
        <div className="rounded-control border border-border px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-status-warning-text">
            {stats.nReview}
          </div>
          <div className="text-[11px] text-text-muted">{t('collect:needsReview')}</div>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-text-muted">
        {t('collect:endBatchKeepsRecordingsBefore')}{' '}
        <strong className="text-text-primary">{t('collect:incomplete')}</strong>
        {t('collect:endBatchKeepsRecordingsAfter')}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('collect:reasonRequired')}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {END_REASONS.map((reason) => (
            <ReasonChip
              key={reason}
              active={reason === machine.endReason}
              onClick={() => machine.pickEndReason(reason)}
            >
              {endReasonLabel(reason, t)}
            </ReasonChip>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ResetBatchModal({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation(['collect', 'common']);
  // An empty set (nothing recorded) has no server row and no number — resetting
  // it is a pure local no-op that neither closes nor allocates any set number.
  const empty = machine.stats.nRecorded === 0;
  const seq = machine.batchSeq != null ? ` ${machine.batchSeq}` : '';
  return (
    <Modal
      open={machine.resetModalOpen}
      onClose={machine.closeModals}
      title={
        empty
          ? t('collect:resetBatchQuestion')
          : t('collect:resetBatchNumber', { number: seq })
      }
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            {t('common:actions.cancel')}
          </Button>
          <Button data-testid="reset-batch-confirm" onClick={machine.resetBatch}>
            {t('collect:resetBatch')}
          </Button>
        </>
      }
    >
      {empty ? (
        <p className="text-[12.5px] leading-relaxed text-text-secondary">
          {t('collect:resetEmptyHelp')}
        </p>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-text-secondary">
            {t('collect:resetBatchHelpBefore')}{' '}
            <span className="font-mono text-text-primary">
              0 / {machine.targetEpisodes}
            </span>
            {t('collect:resetBatchHelpAfter')}
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-text-secondary">
            The{' '}
            <strong className="text-text-primary">
              {machine.stats.nRecorded} recording(s)
            </strong>{' '}
            {t('collect:resetRecordedMiddle')}{' '}
            <strong className="text-text-primary">{t('collect:notDeleted')}</strong>
            {t('collect:resetRecordedAfter')}
          </p>
        </>
      )}
    </Modal>
  );
}

function ConditionModal({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation(['collect', 'common']);
  const plans = usePlans();
  // A catalog condition is a task-owned value. Display labels are mutable, so
  // a stale/deleted selection must not borrow another task's first conditions.
  const task = plans
    .find((project) => project.project_id === machine.projectId)
    ?.tasks.find((candidate) => candidate.task_id === machine.taskId);
  // Free-text condition input (mirrors the custom-task pattern: trim, ignore
  // empty). A typed condition is just a string on the batch — never added to the
  // plan catalog.
  const [custom, setCustom] = useState('');
  const submitCustom = () => {
    const trimmed = custom.trim();
    if (!trimmed) return;
    machine.pickCustomCondition(trimmed);
    setCustom('');
  };
  const hasRecordings = machine.stats.nRecorded > 0;
  return (
    <Modal
      open={machine.condModalOpen}
      onClose={machine.closeModals}
      title={t('collect:changeCondition')}
      footer={
        <Button variant="ghost" onClick={machine.closeModals}>
          {t('common:actions.cancel')}
        </Button>
      }
    >
      <p className="mb-3">
        {hasRecordings
          ? t('collect:conditionChangeRolloverHelp')
          : t('collect:conditionChangeEmptyHelp')}
      </p>
      <div className="flex flex-col gap-1.5">
        {task ? (
          task.conditions.map((c) => (
            <button
              key={c.condition_id}
              type="button"
              onClick={() => machine.pickCondition(c.name)}
              className={cn(
                'rounded-control border px-3.5 py-2.5 text-left text-sm',
                c.name === machine.condition
                  ? 'border-accent bg-interaction-selected font-semibold text-accent'
                  : 'border-border bg-surface font-medium text-text-primary',
              )}
            >
              {c.name}
            </button>
          ))
        ) : (
          <p className="rounded-control border border-border bg-surface-muted px-3.5 py-2.5 text-sm text-text-muted">
            {t('collect:missingPlanTaskHelp')}
          </p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitCustom();
            }
          }}
          placeholder={t('collect:customCondition')}
          data-testid="custom-condition-input"
          className="min-w-0 flex-1 rounded-control border border-border px-3 py-2.5 text-sm text-text-primary focus:border-accent focus:outline-none"
        />
        <Button
          data-testid="custom-condition-add"
          disabled={!custom.trim()}
          onClick={submitCustom}
        >
          {t('common:actions.add')}
        </Button>
      </div>
    </Modal>
  );
}

function TargetModal({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation(['collect', 'common']);
  const [value, setValue] = useState<string>('');
  const parsed = Number.parseInt(value, 10);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 500;
  // Lowering below what's already recorded completes the batch — say so
  // instead of surprising the operator.
  const completesNow = valid && parsed <= machine.stats.nRecorded;
  return (
    <Modal
      open={machine.targetModalOpen}
      onClose={machine.closeModals}
      title={t('collect:changeSetTarget')}
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            data-testid="target-confirm"
            disabled={!valid}
            onClick={() => valid && machine.changeTarget(parsed)}
          >
            {t('collect:setTarget')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-text-secondary">
        {t('collect:targetHelpBefore')}{' '}
        <span className="font-mono text-text-primary">{machine.targetEpisodes}</span>,
        {t('collect:targetHelpRecorded')}{' '}
        <span className="font-mono text-text-primary">{machine.stats.nRecorded}</span>).
        {t('collect:targetHelpAfter')}
      </p>
      <input
        type="number"
        min={1}
        max={500}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={String(machine.targetEpisodes)}
        data-testid="target-input"
        autoFocus
        className="w-full rounded-control border border-border px-3 py-2.5 font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
      />
      {completesNow && (
        <p className="mt-2 text-[12px] leading-relaxed text-status-warning-text">
          {t('collect:targetCompletesNow', { count: machine.stats.nRecorded })}
        </p>
      )}
    </Modal>
  );
}

function formatElapsedClock(startedAt: string | null): string {
  if (!startedAt) return '—';
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Confirm stopping a recording this screen isn't driving (D-1). Guards against
// knocking over another operator's take by mistake; the two body variants match
// whether it's a resumed-own recording or another session's.
function TakeoverStopModal({ machine }: { machine: BatchMachine }) {
  const { t: tr } = useTranslation('collect');
  const t = machine.takeover;
  const size = formatBytes(t?.bytes);
  return (
    <Modal
      open={machine.takeoverStopModalOpen}
      onClose={machine.closeModals}
      title={tr('stopThisRecording')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={machine.closeModals}
            disabled={machine.isTakeoverStopping}
          >
            {tr('keepRecording')}
          </Button>
          <Button
            variant="danger"
            onClick={machine.confirmTakeoverStop}
            disabled={machine.isTakeoverStopping}
          >
            {machine.isTakeoverStopping ? tr('stopping') : tr('stopAndSave')}
          </Button>
        </>
      }
    >
      {machine.takeoverResumedOwn ? (
        <p className="text-[12.5px] leading-relaxed text-text-secondary">
          {tr('stopResumedRecordingHelp', { size })}
        </p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-text-secondary">
          {tr('takeoverStartedElsewhereBefore')}{' '}
          <strong className="text-text-primary">{t?.operator || '—'}</strong> · running{' '}
          <span className="font-mono text-text-primary">
            {formatElapsedClock(t?.startedAt ?? null)}
          </span>{' '}
          · {size}). {tr('takeoverStartedElsewhereAfter')}
        </p>
      )}
    </Modal>
  );
}

// Keyboard-shortcuts help sheet (opened with `?`). Collect-local — the shared
// header is out of scope for this screen (deviation noted in the change report).
// The three external operator actions are documented here too (#36/#37): the
// exact chords, their state-dependent meanings, and the hardware story (any
// programmable three-switch pedal maps onto the chords — Kairos assumes no
// specific product, driver or SDK).
function ShortcutsSheet({ machine }: { machine: BatchMachine }) {
  const { t } = useTranslation(['collect', 'common']);
  const rows: [string, string][] = [
    ['R', t('collect:shortcutStart')],
    ['S / Space', t('collect:shortcutStop')],
    ['Esc', t('collect:shortcutEscape')],
    ['Ctrl+Alt+1', t('collect:shortcutLeft')],
    ['Ctrl+Alt+2', t('collect:shortcutCenter')],
    ['Ctrl+Alt+3', t('collect:shortcutRight')],
    ['?', t('collect:shortcutHelp')],
  ];
  const stateRows: [string, string, string, string][] = [
    [
      t('collect:shortcutState'),
      t('collect:shortcutLeftHeader'),
      t('collect:shortcutCenterHeader'),
      t('collect:shortcutRightHeader'),
    ],
    [t('collect:shortcutReady'), '—', t('collect:externalStart'), '—'],
    [t('collect:shortcutRecording'), '—', t('collect:externalStop'), '—'],
    [t('collect:shortcutSavingQuickCheck'), '—', '—', '—'],
    [
      t('collect:shortcutResultBeforeFailure'),
      t('collect:shortcutSelectFailure'),
      t('collect:shortcutRetakeRecord'),
      t('collect:shortcutSuccessSave'),
    ],
    [
      t('collect:shortcutResultFailureSelected'),
      t('collect:shortcutReasonSave', { number: '1' }),
      t('collect:shortcutReasonSave', { number: '2' }),
      t('collect:shortcutReasonSave', { number: '3' }),
    ],
  ];
  return (
    <Modal
      open={machine.shortcutsOpen}
      onClose={machine.closeModals}
      title={t('collect:keyboardShortcuts')}
      footer={
        <Button variant="ghost" onClick={machine.closeModals}>
          {t('common:actions.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map(([key, desc]) => (
          <div key={key} className="flex items-center gap-3">
            <kbd className="rounded-control border border-border bg-surface-muted px-2 py-0.5 font-mono text-[12px] text-text-primary">
              {key}
            </kbd>
            <span className="text-[12.5px] text-text-secondary">{desc}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-border pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('collect:externalActionsHelpTitle')}
        </span>
        <div className="mt-2 overflow-hidden rounded-control border border-border">
          {stateRows.map((row, i) => (
            <div
              key={row[0]}
              className={cn(
                'grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-2 px-3 py-1.5 text-[11.5px]',
                i === 0
                  ? 'bg-surface-muted font-semibold text-text-muted'
                  : 'border-t border-border text-text-primary',
              )}
            >
              {row.map((cell, cellIndex) => (
                <span key={`${row[0]}-${cellIndex}`} className="truncate">
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-[1.6] text-text-muted">
          {t('collect:externalActionsHelp')}
        </p>
      </div>
    </Modal>
  );
}

export function CollectModals({ machine }: { machine: BatchMachine }) {
  return (
    <>
      <EndBatchModal machine={machine} />
      <ResetBatchModal machine={machine} />
      <TargetModal machine={machine} />
      <ConditionModal machine={machine} />
      <TakeoverStopModal machine={machine} />
      <ShortcutsSheet machine={machine} />
      <Toast message={machine.toast} />
    </>
  );
}
