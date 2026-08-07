// The refusal an archive came back with, and what to do about it.
//
// Shared by BOTH archive dialogs — the per-capture one and the whole-dataset
// one. That is not a breach of the rule keeping those two dialogs separate
// (see DatasetArchiveDialog.tsx's header): what must differ between them is the
// CONSEQUENCE each one describes, so an operator can tell from the dialog alone
// whether a whole dataset is about to leave. How a refusal is REPORTED must not
// differ, and two copies of this component is how that starts to drift.
//
// Three lines, in the order they are needed:
//
//   1. `ErrorMessage` — the server's own sentence, any deeper cause, and the
//      raw code, quotable in a bug report.
//   2. WHO holds the destination, when the refusal names one. The envelope
//      carries `held_by` (a dataset_id) while the server's sentence carries the
//      NAME, and showing "shelf picks" in the alert with a bare "ds-shelf"
//      directly under it reads as two different datasets. This is the only
//      place the two can be joined: the id resolves against the catalog the
//      screen has already loaded. The name is what an operator recognises, the
//      id is what survives a rename, so both are shown — and an id this catalog
//      has no row for falls back to the id alone rather than inventing a name.
//   3. The next step, from errors.ts. For the archive codes that step is the
//      whole outcome: `destination_not_empty` is fixed by an empty path or by
//      clearing the debris, while `destination_claimed` cannot be fixed by
//      clearing anything — the folder is another dataset's for good, and an
//      operator who empties it destroys an archive for nothing.
//
// No ErrorContext is passed: 'review' / 'delete' / 'job' all name actions this
// is not, and errors.ts promises the neutral wording to callers that name none.

import { ErrorMessage } from '../../components/ErrorMessage';
import { readCaptureError } from '../captures/errors';

export function ArchiveError({
  error,
  testIdPrefix,
  resolveDatasetName,
}: {
  error: unknown;
  /** Names the two lines below: `<prefix>-holder`, `<prefix>-guidance`. */
  testIdPrefix: string;
  /** A dataset's name for its id, or null when this catalog has no row. */
  resolveDatasetName?: (datasetId: string) => string | null;
}) {
  if (error == null) return null;
  const reading = readCaptureError(error);
  const heldBy =
    typeof reading.details.held_by === 'string' && reading.details.held_by
      ? reading.details.held_by
      : null;
  const holderName = heldBy && resolveDatasetName ? resolveDatasetName(heldBy) : null;
  return (
    <div className="flex flex-col gap-1">
      <ErrorMessage error={error} />
      {heldBy && (
        <p
          data-testid={`${testIdPrefix}-holder`}
          className="text-[12px] leading-relaxed text-gray-600"
        >
          Held by dataset{' '}
          <span className="font-semibold text-gray-800">
            {holderName ? `${holderName} (${heldBy})` : heldBy}
          </span>
          .
        </p>
      )}
      {reading.guidance && (
        <p
          data-testid={`${testIdPrefix}-guidance`}
          className="text-[12px] leading-relaxed text-gray-600"
        >
          {reading.guidance}
        </p>
      )}
    </div>
  );
}
