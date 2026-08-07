// The discard reason stays REQUIRED on the wire — the ledger line is the only
// surviving explanation once the files are gone. What these cover is the typing
// burden: during a collection session an operator discards obviously-bad takes
// constantly, and a free-text box every time taxed the honest path hardest.

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  DiscardDialog,
  composeDiscardReason,
  prefillDiscardReason,
} from './DeleteDialogs';
import type { CaptureListItem } from '../../api/types';

function capture(over: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    capture_id: 'cap-1',
    state: 'completed',
    review_status: 'pending',
    review_revision: 0,
    bytes: 2_000_000,
    ...over,
  };
}

function renderDialog(captures: CaptureListItem[], onConfirm = vi.fn()) {
  render(
    <DiscardDialog
      open
      captures={captures}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
}

// ---- composition (what reaches the ledger) --------------------------------

test('a preset composes to its own label', () => {
  expect(composeDiscardReason('false_start', null, '')).toBe('False start');
});

test('a known failure reason is appended, so the ledger keeps the specifics', () => {
  expect(composeDiscardReason('failed_take', 'gripper never closed', '')).toBe(
    'Failed take — gripper never closed',
  );
});

test('Other is the operator’s own words and nothing else', () => {
  expect(composeDiscardReason('other', 'ignored detail', 'cable snagged')).toBe(
    'cable snagged',
  );
});

test('nothing chosen, or whitespace-only Other, composes to empty', () => {
  // Empty is what keeps Confirm disabled rather than sending a blank the
  // server would reject with reason_required.
  expect(composeDiscardReason(null, null, 'typed but unselected')).toBe('');
  expect(composeDiscardReason('other', null, '   ')).toBe('');
});

// ---- prefill (the operator's own earlier answer) --------------------------

test('a take already marked failed pre-selects Failed take with its reason', () => {
  expect(
    prefillDiscardReason([
      capture({ task_result: 'failure', failure_reason: 'object dropped' }),
    ]),
  ).toEqual({ chip: 'failed_take', detail: 'object dropped' });
});

test('a bulk discard of all-failed takes prefills too', () => {
  expect(
    prefillDiscardReason([
      capture({ capture_id: 'a', task_result: 'failure', failure_reason: 'slipped' }),
      capture({ capture_id: 'b', task_result: 'failure', failure_reason: 'slipped' }),
    ]),
  ).toEqual({ chip: 'failed_take', detail: 'slipped' });
});

test('targets that disagree on why get the chip but no detail', () => {
  // Appending one capture's reason would attach the wrong explanation to the
  // other, and both are about to become unreadable.
  expect(
    prefillDiscardReason([
      capture({ capture_id: 'a', task_result: 'failure', failure_reason: 'slipped' }),
      capture({ capture_id: 'b', task_result: 'failure', failure_reason: 'missed' }),
    ]),
  ).toEqual({ chip: 'failed_take', detail: null });
});

test('a successful take is not pre-answered for the operator', () => {
  expect(prefillDiscardReason([capture({ task_result: 'success' })])).toEqual({
    chip: null,
    detail: null,
  });
  // One success among failures is enough to stop the guess.
  expect(
    prefillDiscardReason([
      capture({ capture_id: 'a', task_result: 'failure' }),
      capture({ capture_id: 'b', task_result: 'success' }),
    ]),
  ).toEqual({ chip: null, detail: null });
});

// ---- the dialog -----------------------------------------------------------

test('one chip click is enough to confirm — no typing', () => {
  const onConfirm = renderDialog([capture()]);
  expect(screen.getByTestId('discard-confirm')).toBeDisabled();

  fireEvent.click(screen.getByTestId('discard-reason-false_start'));
  expect(screen.getByTestId('discard-confirm')).toBeEnabled();

  fireEvent.click(screen.getByTestId('discard-confirm'));
  expect(onConfirm).toHaveBeenCalledWith('False start');
});

test('the free-text field appears only for Other, and is required there', () => {
  const onConfirm = renderDialog([capture()]);
  // Not present until asked for — that is the whole point of the chips.
  expect(screen.queryByTestId('discard-reason')).toBeNull();

  fireEvent.click(screen.getByTestId('discard-reason-other'));
  expect(screen.getByTestId('discard-reason')).toBeInTheDocument();
  expect(screen.getByTestId('discard-confirm')).toBeDisabled();

  // Whitespace is not an explanation.
  fireEvent.change(screen.getByTestId('discard-reason'), { target: { value: '   ' } });
  expect(screen.getByTestId('discard-confirm')).toBeDisabled();

  fireEvent.change(screen.getByTestId('discard-reason'), {
    target: { value: 'cable snagged' },
  });
  fireEvent.click(screen.getByTestId('discard-confirm'));
  expect(onConfirm).toHaveBeenCalledWith('cable snagged');
});

test('a failed take opens pre-answered, and says what will be recorded', () => {
  const onConfirm = renderDialog([
    capture({ task_result: 'failure', failure_reason: 'object dropped' }),
  ]);
  // Confirm is live on open: the operator already answered this in Review.
  expect(screen.getByTestId('discard-reason-failed_take')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByTestId('discard-confirm')).toBeEnabled();
  expect(screen.getByTestId('discard-reason-detail')).toHaveTextContent(
    'Failed take — object dropped',
  );

  fireEvent.click(screen.getByTestId('discard-confirm'));
  expect(onConfirm).toHaveBeenCalledWith('Failed take — object dropped');
});

test('a prefilled chip can be overridden, and the detail goes with it', () => {
  const onConfirm = renderDialog([
    capture({ task_result: 'failure', failure_reason: 'object dropped' }),
  ]);
  fireEvent.click(screen.getByTestId('discard-reason-sensor'));
  fireEvent.click(screen.getByTestId('discard-confirm'));
  // The failure detail belonged to "Failed take"; it must not ride along on a
  // reason the operator changed to something else.
  expect(onConfirm).toHaveBeenCalledWith('Sensor or data issue');
});

test('consent is unchanged: the warning, the scope and the honesty line stay', () => {
  render(
    <DiscardDialog
      open
      captures={[capture()]}
      splitDeploy
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  expect(screen.getByTestId('discard-irreversible').textContent).toMatch(
    /cannot be undone/i,
  );
  expect(screen.getByTestId('discard-scope').textContent).toMatch(/1 recording/);
  expect(screen.getByTestId('discard-scope').textContent).toMatch(/2\.0 MB/);
  expect(screen.getByTestId('discard-split-note').textContent).toMatch(
    /may still exist on the robot/i,
  );
});
