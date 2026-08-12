// Combine datasets (§6): a NEW dataset listing every member of the chosen
// sources, sources untouched. Because a dataset is rows plus ledger events,
// combining is ordinary building done in bulk — create one dataset, then the
// same add-member POST the rail uses, once per recording. Nothing on disk
// moves, and the sources are never written to: reading a list does not change
// it.
//
// The standing bulk rule applies (frontend.md): sequential, visible {done}/{n}
// progress, per-capture failures reported honestly, Cancel blocked while
// running. A capture present in two sources joins the new set once, numbered
// at its first appearance; source order = the order sources were ticked.

import { Button, Modal, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { shortCaptureId } from './data';
import type { DatasetsState } from './useDatasetsState';

export function CombineDatasetsDialog({ state }: { state: DatasetsState }) {
  const picked = state.combineSources.length;
  const ready = picked > 0 && state.combineName.trim() !== '';
  const finishedWithFailures =
    !state.combineBusy && state.combineFailures.length > 0 && state.combineTotal > 0;

  return (
    <Modal
      open={state.combineOpen}
      onClose={state.cancelCombine}
      title="Combine datasets"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelCombine}
            disabled={state.combineBusy}
            data-testid="combine-datasets-cancel"
          >
            {finishedWithFailures ? 'Close' : 'Cancel'}
          </Button>
          {!finishedWithFailures && (
            <Button
              variant="primary"
              onClick={state.submitCombine}
              disabled={state.combineBusy || !ready}
              data-testid="combine-datasets-submit"
            >
              {state.combineBusy
                ? `Combining… ${state.combineDone} / ${state.combineTotal}`
                : 'Combine into a new dataset'}
            </Button>
          )}
        </>
      }
    >
      <div data-testid="combine-datasets-dialog" className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-gray-600">
          A new dataset listing every recording of the sources you pick.{' '}
          <span className="font-semibold text-gray-800">
            The sources are not touched
          </span>{' '}
          — a dataset is a list of captures, and nothing moves on disk. A
          recording in two sources joins once.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            New dataset name
          </span>
          <input
            data-testid="combine-datasets-name"
            value={state.combineName}
            onChange={(e) => state.setCombineName(e.target.value)}
            maxLength={200}
            autoFocus
            disabled={state.combineBusy}
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-gray-700"
          />
        </label>
        <div className="flex gap-1.5">
          <input
            data-testid="combine-datasets-operator"
            value={state.combineOperator}
            onChange={(e) => state.setCombineOperator(e.target.value)}
            // Named for the dataset being BUILT, matching the visible "New
            // dataset name" above — and so it is not confusable with the create
            // panel's own operator field, which can be open behind this dialog.
            aria-label="New dataset operator (optional)"
            placeholder="Operator (optional)"
            disabled={state.combineBusy}
            className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 placeholder:text-gray-400"
          />
          <input
            data-testid="combine-datasets-task"
            value={state.combineTask}
            onChange={(e) => state.setCombineTask(e.target.value)}
            aria-label="New dataset task (optional)"
            placeholder="Task (optional)"
            disabled={state.combineBusy}
            className="min-w-0 flex-1 rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 placeholder:text-gray-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Sources ({picked} picked)
          </span>
          <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto rounded-[10px] border border-gray-100 p-1.5">
            {state.combineChoices.length === 0 ? (
              <span className="px-1.5 py-1 text-[12px] text-gray-400">
                No active dataset to combine from.
              </span>
            ) : (
              state.combineChoices.map((choice) => {
                const order = state.combineSources.indexOf(choice.datasetId);
                return (
                  <label
                    key={choice.datasetId}
                    data-testid={`combine-source-${choice.datasetId}`}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-[8px] px-1.5 py-1',
                      order >= 0 ? 'bg-teal-50' : 'hover:bg-gray-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={order >= 0}
                      disabled={state.combineBusy}
                      onChange={() => state.toggleCombineSource(choice.datasetId)}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">
                      {choice.name}
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {choice.memberCount} member{choice.memberCount === 1 ? '' : 's'}
                    </span>
                    {order >= 0 && (
                      <span className="text-[10.5px] font-semibold text-teal-700">
                        #{order + 1}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <span className="text-[10.5px] text-gray-400">
            Members are numbered source by source, in the order you picked them.
          </span>
        </div>

        {finishedWithFailures && (
          <div
            data-testid="combine-datasets-failures"
            className="flex flex-col gap-1 rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
          >
            <span className="font-semibold">
              {state.combineDone - state.combineFailures.length} of{' '}
              {state.combineTotal} joined; {state.combineFailures.length} did not:
            </span>
            {state.combineFailures.map((f) => (
              <span key={f.captureId}>
                <span className="font-mono">{shortCaptureId(f.captureId)}</span> —{' '}
                {f.message}
              </span>
            ))}
            <span>The new dataset exists with everything that joined.</span>
          </div>
        )}
        {state.combineError != null && <ErrorMessage error={state.combineError} />}
      </div>
    </Modal>
  );
}
