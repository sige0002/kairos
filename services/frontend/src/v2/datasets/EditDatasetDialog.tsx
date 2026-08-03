// Edit a dataset's three labels (§6). Identity is dataset_id, so a rename
// changes what the dataset is CALLED, never what it IS: same members, same
// numbers, same history. The views/ tree follows server-side — the labels are
// its path — and the dialog says both things out loud, because the model this
// replaced made "rename" mean "a different directory", and the two must not be
// confused while both are in living memory.
//
// Only active datasets get here: an archived dataset's labels are baked into
// the folder its run wrote, and the button that opens this is not rendered.

import { Button, Modal } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import type { DatasetsState } from './useDatasetsState';

export function EditDatasetDialog({ state }: { state: DatasetsState }) {
  return (
    <Modal
      open={state.editOpen}
      onClose={state.cancelEdit}
      title="Edit dataset labels"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={state.cancelEdit}
            disabled={state.editing}
            data-testid="edit-dataset-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={state.submitEdit}
            disabled={state.editing || state.editName.trim() === ''}
            data-testid="edit-dataset-submit"
          >
            {state.editing ? 'Saving…' : 'Save labels'}
          </Button>
        </>
      }
    >
      <div data-testid="edit-dataset-dialog" className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Name
          </span>
          <input
            data-testid="edit-dataset-name"
            value={state.editName}
            onChange={(e) => state.setEditName(e.target.value)}
            maxLength={200}
            autoFocus
            className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12.5px] text-gray-700"
          />
        </label>
        <div className="flex gap-1.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Operator{' '}
              <span className="font-normal normal-case text-gray-400">(optional)</span>
            </span>
            <input
              data-testid="edit-dataset-operator"
              value={state.editOperator}
              onChange={(e) => state.setEditOperator(e.target.value)}
              className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
              Task{' '}
              <span className="font-normal normal-case text-gray-400">(optional)</span>
            </span>
            <input
              data-testid="edit-dataset-task"
              value={state.editTask}
              onChange={(e) => state.setEditTask(e.target.value)}
              className="rounded-control border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700"
            />
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-gray-500">
          Labels only: the members and their numbers do not change, and no
          recording moves. Leave operator empty when several people recorded the
          members — each recording keeps its own operator either way, and the
          browsable views/ tree follows the new labels on its own.
        </p>
        {state.editError != null && <ErrorMessage error={state.editError} />}
      </div>
    </Modal>
  );
}
