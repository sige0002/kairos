// Collect-scoped modals (End batch early / Report issue / Change condition)
// plus the toast. Rendered at the screen level per the design mock's MODALS
// section.

import { useState } from 'react';
import { Button, Modal, cn } from '../../components/ui';
import { END_REASONS, type BatchMachine } from './useBatchMachine';
import { findTask, usePlans } from '../plans';

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
        active ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-gray-200 bg-white font-medium text-gray-500',
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
      title={`End batch ${machine.batchNum} early?`}
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            Cancel
          </Button>
          <Button variant="danger" onClick={machine.confirmEndBatch} disabled={!canConfirm}>
            End batch
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-gray-900">{stats.nRecorded}</div>
          <div className="text-[11px] text-gray-400">recorded</div>
        </div>
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-gray-500">{stats.nRemaining}</div>
          <div className="text-[11px] text-gray-400">not recorded</div>
        </div>
        <div className="rounded-control border border-gray-100 px-3 py-2.5">
          <div className="font-mono text-lg font-semibold text-amber-600">{stats.nReview}</div>
          <div className="text-[11px] text-gray-400">needs review</div>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-gray-500">
        Recorded episodes are kept and stay visible in Review. This batch will be marked{' '}
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

function IssueModal({ machine }: { machine: BatchMachine }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      open={machine.issueModalOpen}
      onClose={machine.closeModals}
      title="Report an issue"
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              machine.submitIssue();
              setNote('');
            }}
          >
            Submit
          </Button>
        </>
      }
    >
      <p className="mb-2">
        Attached to Batch {machine.batchNum}, Episode {machine.stats.epNext} context automatically.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Describe what happened…"
        rows={3}
        className="w-full resize-none rounded-control border border-gray-200 px-3 py-2.5 text-sm text-gray-700 focus:border-teal-500 focus:outline-none"
      />
    </Modal>
  );
}

function ConditionModal({ machine }: { machine: BatchMachine }) {
  const plans = usePlans();
  const task = findTask(plans, machine.project, machine.task);
  return (
    <Modal open={machine.condModalOpen} onClose={machine.closeModals} title="Change condition">
      <p className="mb-3">Applies from the next episode. Current episode plans are unaffected.</p>
      <div className="flex flex-col gap-1.5">
        {task.conditions.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => machine.pickCondition(c)}
            className={cn(
              'rounded-control border px-3.5 py-2.5 text-left text-sm',
              c === machine.condition
                ? 'border-teal-600 bg-teal-50 font-semibold text-teal-700'
                : 'border-gray-200 bg-white font-medium text-gray-700',
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

// Discard-episode confirmation: unlike v1's post-stop Keep/Discard prompt, this
// lives on the result phase (the operator already reviewed the take). Confirm
// runs a real DELETE /runs/{id}; a failure keeps the episode and shows the error.
function DiscardModal({ machine }: { machine: BatchMachine }) {
  const size = formatBytes(machine.discardRunBytes);
  return (
    <Modal
      open={machine.discardModalOpen}
      onClose={machine.closeModals}
      title="Discard this episode?"
      footer={
        <>
          <Button variant="ghost" onClick={machine.closeModals} disabled={machine.isDiscarding}>
            Keep
          </Button>
          <Button variant="danger" onClick={machine.confirmDiscard} disabled={machine.isDiscarding}>
            {machine.isDiscarding ? 'Discarding…' : 'Discard permanently'}
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-gray-600">
        This permanently deletes the recorded run
        {machine.discardRunId ? (
          <>
            {' '}
            <span className="font-mono text-gray-800">{machine.discardRunId}</span>
          </>
        ) : null}
        {size ? ` (${size})` : ''} from disk, then re-arms for a fresh take of this episode. This
        cannot be undone.
      </p>
      {!machine.discardRunId && (
        <p className="mt-2 text-[12px] text-gray-400">
          Nothing was persisted for this take yet — this just re-records the episode.
        </p>
      )}
      {machine.discardError && (
        <div
          role="alert"
          data-testid="discard-error"
          className="mt-3 rounded-control border border-red-200 bg-red-50/70 px-3 py-2 text-[12px] text-red-800"
        >
          <span className="font-semibold">Discard failed</span> — {machine.discardError}. The
          episode is kept.
        </div>
      )}
    </Modal>
  );
}

function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-gray-900 px-[18px] py-[11px] text-sm font-medium text-gray-50 shadow-float">
      <span className="h-[7px] w-[7px] rounded-sm bg-teal-400" />
      {message}
    </div>
  );
}

export function CollectModals({ machine }: { machine: BatchMachine }) {
  return (
    <>
      <EndBatchModal machine={machine} />
      <IssueModal machine={machine} />
      <ConditionModal machine={machine} />
      <DiscardModal machine={machine} />
      <Toast message={machine.toast} />
    </>
  );
}
