// The shared Modal's focus contract, tested on the Modal ITSELF.
//
// These assertions previously lived only in a Collect test, where the
// post-close focus was actually being placed by ControlCard's own phase effect
// — so deleting the Modal's entire focus block left them green. On any screen
// without ControlCard that path was untested. Here there is no other focus
// manager in the tree, so each assertion can only be satisfied by the Modal.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { useState } from 'react';
import { Modal } from './ui';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A page with a <main> landmark, a trigger, and a dialog — the shape the
 *  fallback path depends on. `unmountTrigger` models the real case: a menu that
 *  disappears as the dialog it opened appears. */
function Page({ unmountTrigger }: { unmountTrigger: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      {!(unmountTrigger && open) && (
        <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
          Open
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="A dialog">
        <p>body</p>
      </Modal>
    </main>
  );
}

test('focus moves into the dialog and back to a surviving trigger', () => {
  render(<Page unmountTrigger={false} />);
  const trigger = screen.getByTestId('trigger');
  trigger.focus();

  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);

  fireEvent.keyDown(document, { key: 'Escape' });
  // Back to the exact control the operator came from — not merely "not body".
  expect(document.activeElement).toBe(trigger);
});

test('a trigger that unmounted with the dialog falls back to <main>', () => {
  render(<Page unmountTrigger />);
  const trigger = screen.getByTestId('trigger');
  trigger.focus();

  fireEvent.click(trigger);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

  fireEvent.keyDown(document, { key: 'Escape' });
  // The specific element, because "not body" was satisfied by an unrelated
  // focus manager on the one screen this used to be tested from.
  const main = document.querySelector('main');
  expect(document.activeElement).toBe(main);
  // …and the tabindex that made it focusable is not left behind on a node the
  // Modal does not own.
  expect(main?.hasAttribute('tabindex')).toBe(false);
});

test('a trigger that detaches WHILE the dialog is open still lands somewhere', () => {
  // The case the `isConnected` check exists for, and the only one that reaches
  // it: the trigger is still present when the dialog opens, so it IS captured
  // as the restore target, and only leaves the document afterwards. Restoring
  // to it then is a silent no-op — focus would end on <body> — so the check has
  // to notice the node is detached and fall back.
  function LateUnmount() {
    const [open, setOpen] = useState(false);
    const [gone, setGone] = useState(false);
    return (
      <main>
        {!gone && (
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
        )}
        <button type="button" data-testid="remove" onClick={() => setGone(true)}>
          Remove the trigger
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="A dialog">
          <p>body</p>
        </Modal>
      </main>
    );
  }

  render(<LateUnmount />);
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  fireEvent.click(trigger); // captured while still attached

  fireEvent.click(screen.getByTestId('remove')); // now it detaches
  fireEvent.keyDown(document, { key: 'Escape' });

  expect(document.activeElement).toBe(document.querySelector('main'));
  expect(document.activeElement).not.toBe(document.body);
});

// ---------------------------------------------------------------------------
// Tab containment (E-31's deferred half).
//
// E-31 ruled the missing trap was not a trap in the operator's sense — Escape
// has always closed the dialog, so nobody was stuck — but Tab still walked out
// of the dialog and into the page BEHIND the overlay, where the cursor is
// invisible and the controls are the ones the dialog is covering.
//
// WHAT jsdom CAN AND CANNOT SHOW. jsdom does not implement native Tab
// navigation: a `Tab` keydown moves no focus by itself. So these tests cannot
// claim "Tab cycles through the dialog" — that is the browser's half. What they
// pin is the half this component owns: at the two WRAP POINTS the handler
// redirects focus and cancels the event, and everywhere else it does not touch
// it. The "everywhere else" assertion is the one that keeps this from becoming
// a keyboard hijack, so it is a control, not a nicety.
// ---------------------------------------------------------------------------

/** A dialog with three tab stops, so there is a real middle. */
function ThreeStopPage() {
  const [open, setOpen] = useState(true);
  return (
    <main>
      <button type="button" data-testid="behind">
        Behind the overlay
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="A dialog"
        footer={
          <>
            <button type="button" data-testid="cancel">
              Cancel
            </button>
            <button type="button" data-testid="confirm">
              Confirm
            </button>
          </>
        }
      >
        <input data-testid="field" />
      </Modal>
    </main>
  );
}

/** Press Tab where the cursor actually is. Returns false when the handler
 *  cancelled the event, i.e. took the navigation over. */
function pressTab(shiftKey = false): boolean {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  return fireEvent.keyDown(target, { key: 'Tab', shiftKey });
}

test('Tab off the last control in the dialog wraps to the first', () => {
  render(<ThreeStopPage />);
  screen.getByTestId('confirm').focus();

  expect(pressTab()).toBe(false); // the handler took it
  expect(document.activeElement).toBe(screen.getByTestId('field'));
});

test('Shift+Tab off the first control wraps to the last', () => {
  render(<ThreeStopPage />);
  screen.getByTestId('field').focus();

  expect(pressTab(true)).toBe(false);
  expect(document.activeElement).toBe(screen.getByTestId('confirm'));
});

// The control on the whole feature: everywhere that is not a wrap point, the
// browser's own tab order is already right and the handler must keep its hands
// off. A trap that cancels every Tab would pass both tests above and break
// tabbing inside the dialog.
test('Tab in the middle of the dialog is left to the browser', () => {
  render(<ThreeStopPage />);
  screen.getByTestId('field').focus();

  expect(pressTab()).toBe(true); // not cancelled
  expect(document.activeElement).toBe(screen.getByTestId('field')); // unmoved by us
});

test('Tab pulls a cursor that escaped the dialog back inside', () => {
  render(<ThreeStopPage />);
  // The state the dialog opens in when nothing inside it took focus, and the
  // state a stray click on the page behind can produce.
  screen.getByTestId('behind').focus();

  expect(pressTab()).toBe(false);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
});

test('a closed dialog traps nothing', () => {
  function ClosedPage() {
    return (
      <main>
        <button type="button" data-testid="behind">
          Behind
        </button>
        <Modal open={false} onClose={() => {}} title="A dialog">
          <input data-testid="field" />
        </Modal>
      </main>
    );
  }
  render(<ClosedPage />);
  screen.getByTestId('behind').focus();

  expect(pressTab()).toBe(true);
  expect(document.activeElement).toBe(screen.getByTestId('behind'));
});

// Unchanged by the trap, and re-asserted here because a trap is the one change
// that could turn a dialog into a real one: Escape still closes it.
test('Escape still closes a dialog that now contains Tab', () => {
  render(<ThreeStopPage />);
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
