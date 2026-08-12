// The store's lifecycle, which nothing else pins: the two cards agree only for
// as long as publish/clear behave, and StrictMode (on in the app, off in RTL by
// default) drives a mount → unmount → mount that passes through an EMPTY store
// on its way back. If the republish did not follow, the warnings card would
// come up speaking for no rows at all.

import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  __resetPublishers,
  usePublishSystemRows,
  useSystemRowsStore,
} from './systemRowsStore';
import type { SysRow } from './useSystemRows';

const ROW: SysRow = {
  label: 'Topic rates',
  value: '27 / 29 at expected',
  chip: 'CHECK',
  tone: 'amber',
  cause: 'rates-shortfall',
};

/** A bare publisher, standing in for SystemStatusCard. */
function Publisher({ rows }: { rows: SysRow[] }) {
  usePublishSystemRows(rows);
  return null;
}

function rowsInStore(): SysRow[] {
  return useSystemRowsStore.getState().rows;
}

afterEach(() => {
  vi.restoreAllMocks();
  useSystemRowsStore.setState({ rows: [] });
  __resetPublishers();
});

test('an identical republish does not notify subscribers', () => {
  let notifications = 0;
  const unsubscribe = useSystemRowsStore.subscribe(() => {
    notifications += 1;
  });

  const { rerender } = render(<Publisher rows={[ROW]} />);
  expect(notifications).toBe(1);
  expect(rowsInStore()).toHaveLength(1);

  // A FRESH array with identical contents — which is what useSystemRows hands
  // over on every one of its renders. Without sameRows this would notify (and
  // re-render the warnings card) once per render of the system card, forever.
  rerender(<Publisher rows={[{ ...ROW }]} />);
  rerender(<Publisher rows={[{ ...ROW }]} />);
  expect(notifications).toBe(1);

  // A real change still gets through.
  rerender(<Publisher rows={[{ ...ROW, chip: 'OK', tone: 'green', cause: undefined }]} />);
  expect(notifications).toBe(2);
  expect(rowsInStore()[0]!.chip).toBe('OK');

  unsubscribe();
});

test('a field that differs only in `cause` still counts as news', () => {
  // sameRows compares every key of SysRow (guarded by `satisfies`), so the
  // discriminator that selects the warnings prose cannot change underneath a
  // row whose visible value happens to be identical.
  const { rerender } = render(<Publisher rows={[ROW]} />);
  rerender(<Publisher rows={[{ ...ROW, cause: 'rates-mixed' }]} />);
  expect(rowsInStore()[0]!.cause).toBe('rates-mixed');
});

test('unmounting the publisher clears the rows', () => {
  const { unmount } = render(<Publisher rows={[ROW]} />);
  expect(rowsInStore()).toHaveLength(1);

  unmount();
  // Not a frozen last set: a warnings card outliving the system card has
  // nothing to speak for, and says so, rather than quoting a dead snapshot.
  expect(rowsInStore()).toEqual([]);
});

test('StrictMode publish → clear → publish ends with the rows intact', () => {
  // React 18 StrictMode mounts, unmounts and remounts every effect. The clear
  // on the simulated unmount empties the store; the republish on the remount is
  // what puts it back, and only the ORDER of the two effects makes that true.
  render(
    <StrictMode>
      <Publisher rows={[ROW]} />
    </StrictMode>,
  );
  expect(rowsInStore()).toHaveLength(1);
  expect(rowsInStore()[0]!.chip).toBe('CHECK');
});

// ---- the single-publisher invariant ----------------------------------------

test('a second publisher warns in development', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(
    <>
      <Publisher rows={[ROW]} />
      <Publisher rows={[{ ...ROW, value: 'rival' }]} />
    </>,
  );
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toMatch(/second System status publisher/i);
  // The warning is all that changes: last write still wins, as it did before.
  expect(rowsInStore()[0]!.value).toBe('rival');
});

test('one publisher remounting is not mistaken for a rival', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(
    <StrictMode>
      <Publisher rows={[ROW]} />
    </StrictMode>,
  );
  // StrictMode's mount → unmount → mount must not look like two publishers;
  // the identity is per-instance (a ref), not per-mount.
  expect(warn).not.toHaveBeenCalled();
});
