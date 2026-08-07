// Edit a dataset's three labels (§6). Identity is dataset_id, so a rename
// changes what the dataset is CALLED, never what it IS: same members, same
// numbers, same history. The views/ tree follows server-side — the labels are
// its path — and the dialog says both things out loud, because the model this
// replaced made "rename" mean "a different directory", and the two must not be
// confused while both are in living memory.
//
// An archived dataset's labels are baked into the folder its run wrote, so the
// button that OPENS this is only rendered while the dataset is active. That is
// the gate on opening, not a gate on the dialog: since the dialogs outlived the
// pane switch (DatasetCenter.tsx) this one stays up while the dataset changes
// underneath it, and an external archive mid-dialog leaves Save live against a
// dataset that is no longer active. The server answers 409 `dataset_not_active`
// and the dialog shows it — deliberately, rather than adding a second status
// gate here that could drift from the server's (see the archived-under-the-
// dialog case in DatasetsExternalChange.test.tsx). Deletion is different: that
// one the screen can state as fact from the list, so `gone` stands Save down.

import { Button, Modal } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { DatasetGoneNote } from './SelectionGone';
import type { DatasetsState } from './useDatasetsState';

export function EditDatasetDialog({ state }: { state: DatasetsState }) {
  // Deleted underneath the form. This dialog is not destructive, but it is the
  // fourth door onto the same row and it now outlives that row's disappearance
  // like the other three (DatasetCenter.tsx), so it owes the same answer: say
  // what happened, and stop offering a Save that can only 404.
  const gone = state.selectionGone;
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
            {gone ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            onClick={state.submitEdit}
            disabled={state.editing || gone || state.editName.trim() === ''}
            data-testid="edit-dataset-submit"
          >
            {state.editing ? 'Saving…' : 'Save labels'}
          </Button>
        </>
      }
    >
      {gone ? (
        <div data-testid="edit-dataset-dialog" className="flex flex-col gap-3">
          <DatasetGoneNote testId="edit-dataset-gone" datasetId={state.selectedDatasetId} />
          <p className="text-[12px] leading-relaxed text-gray-500">
            Nothing was renamed. The labels you typed are not saved anywhere.
          </p>
          {state.editError != null && <ErrorMessage error={state.editError} />}
        </div>
      ) : (
        <EditForm state={state} />
      )}
    </Modal>
  );
}

function EditForm({ state }: { state: DatasetsState }) {
  return (
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
  );
}
