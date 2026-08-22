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
import { Button, Modal, cn } from '../../components/ui';
import { END_REASONS, type BatchMachine } from './useBatchMachine';
import { findTask, usePlans } from '../plans';
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
          ? 'border-teal-600 bg-teal-50 text-teal-700'
          : 'border-gray-200 bg-white font-medium text-gray-500',
      )}
    >
      {children}
    </button>
  );
}

function EndBatchModal({ machine }: { machine: BatchMachine }) {
  const { stats } = machine;
  const canConfirm = !!machine.endReason;
  return (
    <Modal
      open={machine.endModalOpen}
      onClose={machine.closeModals}
      title={
        machine.batchSeq != null
          ? `End batch ${machine.batchSeq} early?`
          : 'End batch early?'
      }
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={machine.confirmEndBatch}
            disabled={!canConfirm}
          >
            End batch
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-gray-900">
            {stats.nRecorded}
          </div>
          <div className="text-[11px] text-gray-500">recorded</div>
        </div>
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-gray-500">
            {stats.nRemaining}
          </div>
          <div className="text-[11px] text-gray-500">not recorded</div>
        </div>
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-amber-700">
            {stats.nReview}
          </div>
          <div className="text-[11px] text-gray-500">needs review</div>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-gray-500">
        Recorded episodes are kept and stay visible in Review. This set will be marked{' '}
        <strong className="text-gray-700">Incomplete</strong>.
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Reason (required)
        </span>
        <div className="flex flex-wrap gap-1.5">
          {END_REASONS.map((reason) => (
            <ReasonChip
              key={reason}
              active={reason === machine.endReason}
              onClick={() => machine.pickEndReason(reason)}
            >
              {reason}
            </ReasonChip>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ResetBatchModal({ machine }: { machine: BatchMachine }) {
  // An empty set (nothing recorded) has no server row and no number — resetting
  // it is a pure local no-op that neither closes nor allocates any set number.
  const empty = machine.stats.nRecorded === 0;
  const seq = machine.batchSeq != null ? ` ${machine.batchSeq}` : '';
  return (
    <Modal
      open={machine.resetModalOpen}
      onClose={machine.closeModals}
      title={empty ? 'Reset batch?' : `Reset batch${seq}?`}
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            Cancel
          </Button>
          <Button data-testid="reset-batch-confirm" onClick={machine.resetBatch}>
            Reset batch
          </Button>
        </>
      }
    >
      {empty ? (
        <p className="text-[12.5px] leading-relaxed text-gray-600">
          Nothing has been recorded in this batch yet, so this just clears local state —
          no batch is created or closed, and the batch number is unchanged.
        </p>
      ) : (
        <>
          <p className="text-[12.5px] leading-relaxed text-gray-600">
            This closes the current set. The counter returns to{' '}
            <span className="font-mono text-gray-800">
              0 / {machine.targetEpisodes}
            </span>
            ; the next set number is assigned when you start your next recording.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-gray-600">
            The{' '}
            <strong className="text-gray-700">
              {machine.stats.nRecorded} recording(s)
            </strong>{' '}
            already taken are <strong className="text-gray-700">not deleted</strong> —
            they stay in Review.
          </p>
        </>
      )}
    </Modal>
  );
}

function ConditionModal({ machine }: { machine: BatchMachine }) {
  const plans = usePlans();
  const task = findTask(plans, machine.project ?? '', machine.task ?? '');
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
      title="Change condition"
      footer={
        <Button variant="ghost" onClick={machine.closeModals}>
          Cancel
        </Button>
      }
    >
      <p className="mb-3">
        {hasRecordings
          ? 'This set already has recordings — changing the condition closes it and starts a new set, so earlier episodes keep their condition.'
          : 'Applies to this batch. No episodes are recorded yet.'}
      </p>
      <div className="flex flex-col gap-1.5">
        {task.conditions.map((c) => (
          <button
            key={c.condition_id}
            type="button"
            onClick={() => machine.pickCondition(c.name)}
            className={cn(
              'rounded-control border px-3.5 py-2.5 text-left text-sm',
              c.name === machine.condition
                ? 'border-teal-600 bg-teal-50 font-semibold text-teal-700'
                : 'border-gray-200 bg-white font-medium text-gray-700',
            )}
          >
            {c.name}
          </button>
        ))}
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
          placeholder="Custom condition…"
          data-testid="custom-condition-input"
          className="min-w-0 flex-1 rounded-control border border-gray-200 px-3 py-2.5 text-sm text-gray-700 focus:border-teal-600 focus:outline-none"
        />
        <Button
          data-testid="custom-condition-add"
          disabled={!custom.trim()}
          onClick={submitCustom}
        >
          Add
        </Button>
      </div>
    </Modal>
  );
}

function TargetModal({ machine }: { machine: BatchMachine }) {
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
      title="Change set target"
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            Cancel
          </Button>
          <Button
            data-testid="target-confirm"
            disabled={!valid}
            onClick={() => valid && machine.changeTarget(parsed)}
          >
            Set target
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] leading-relaxed text-gray-600">
        Planned episodes for this batch (currently{' '}
        <span className="font-mono text-gray-800">{machine.targetEpisodes}</span>,
        recorded{' '}
        <span className="font-mono text-gray-800">{machine.stats.nRecorded}</span>).
        Applies to the current set and is inherited by the next one.
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
        className="w-full rounded-control border border-gray-200 px-3 py-2.5 font-mono text-sm text-gray-700 focus:border-teal-600 focus:outline-none"
      />
      {completesNow && (
        <p className="mt-2 text-[12px] leading-relaxed text-amber-700">
          {machine.stats.nRecorded} episode(s) are already recorded, so this target
          marks the batch complete immediately.
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
  const t = machine.takeover;
  const size = formatBytes(t?.bytes);
  return (
    <Modal
      open={machine.takeoverStopModalOpen}
      onClose={machine.closeModals}
      title="Stop this recording?"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={machine.closeModals}
            disabled={machine.isTakeoverStopping}
          >
            Keep recording
          </Button>
          <Button
            variant="danger"
            onClick={machine.confirmTakeoverStop}
            disabled={machine.isTakeoverStopping}
          >
            {machine.isTakeoverStopping ? 'Stopping…' : 'Stop & save'}
          </Button>
        </>
      }
    >
      {machine.takeoverResumedOwn ? (
        <p className="text-[12.5px] leading-relaxed text-gray-600">
          Stop the recording that&apos;s still running? {size} captured so far will be
          saved to Review.
        </p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-gray-600">
          This recording was started from another session (operator{' '}
          <strong className="text-gray-700">{t?.operator || '—'}</strong> · running{' '}
          <span className="font-mono text-gray-800">
            {formatElapsedClock(t?.startedAt ?? null)}
          </span>{' '}
          · {size}). Stopping it saves what&apos;s captured so far — it will appear in
          Review.
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
  const rows: [string, string][] = [
    ['R', 'Start recording (when ready)'],
    ['S / Space', 'Stop recording'],
    ['Esc', 'Cancel arming · close a dialog'],
    ['Ctrl+Alt+1', 'External action LEFT — state-dependent, see the table'],
    ['Ctrl+Alt+2', 'External action CENTER — state-dependent, see the table'],
    ['Ctrl+Alt+3', 'External action RIGHT — state-dependent, see the table'],
    ['?', 'Show this shortcuts sheet'],
  ];
  const stateRows: [string, string, string, string][] = [
    ['State', 'LEFT', 'CENTER', 'RIGHT'],
    ['READY', '—', 'Start', '—'],
    ['RECORDING', '—', 'Stop', '—'],
    ['SAVING / QUICK CHECK', '—', '—', '—'],
    ['RESULT, before Failure', 'Select Failure', '—', 'Success + Save'],
    [
      'RESULT, Failure selected',
      'Reason 1 + Save',
      'Reason 2 + Save',
      'Reason 3 + Save',
    ],
  ];
  return (
    <Modal
      open={machine.shortcutsOpen}
      onClose={machine.closeModals}
      title="Keyboard shortcuts"
      footer={
        <Button variant="ghost" onClick={machine.closeModals}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map(([key, desc]) => (
          <div key={key} className="flex items-center gap-3">
            <kbd className="rounded-control border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[12px] text-gray-700">
              {key}
            </kbd>
            <span className="text-[12.5px] text-gray-600">{desc}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          External actions (hands-busy / foot pedal)
        </span>
        <div className="mt-2 overflow-hidden rounded-control border border-gray-200">
          {stateRows.map((row, i) => (
            <div
              key={row[0]}
              className={cn(
                'grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-2 px-3 py-1.5 text-[11.5px]',
                i === 0
                  ? 'bg-gray-50 font-semibold text-gray-500'
                  : 'border-t border-gray-100 text-gray-700',
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
        <p className="mt-2 text-[11.5px] leading-[1.6] text-gray-500">
          The “Reason N” slots are the current task&apos;s three failure shortcuts
          (Settings → Projects &amp; tasks); an unassigned slot saves nothing and
          explains why. Failure reasons are accepted only AFTER Failure has been
          selected — the slots can never stamp a reason during recording. The chords
          work on a plain keyboard (development and testing need no hardware), and any
          programmable three-switch USB foot pedal can be mapped onto them — left switch
          → Ctrl+Alt+1, center → Ctrl+Alt+2, right → Ctrl+Alt+3. No specific pedal
          product, driver or SDK is required or assumed.
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
