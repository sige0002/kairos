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
