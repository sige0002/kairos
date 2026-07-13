import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { SystemInfo } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SystemStatusCard } from './SideCards';
import type { BatchMachine } from './useBatchMachine';

const GB = 1024 ** 3;

// SystemStatusCard only reads machine.phase + machine.arming; the rest of the
// (large) BatchMachine is irrelevant to the Storage row under test.
const machine = { phase: 'idle', arming: null } as unknown as BatchMachine;

function mockSystem(body: SystemInfo) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

function renderCard() {
  return renderWithClient(
    <SystemStatusCard
      machine={machine}
      sseStatus="closed"
      monitorBridge={null}
      camerasOk={true}
    />,
  );
}

/** The Storage row's container div (label + value + chip). */
function storageRow(): HTMLElement {
  return screen.getByText('Storage').parentElement as HTMLElement;
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('shows real free space with an OK chip when above the low-storage threshold', async () => {
  mockSystem({
    cpu: { model: 'Test CPU', cores: 8 },
    gpu: null,
    disk: { path: '/data', total_bytes: 500 * GB, free_bytes: 300 * GB },
  });
  renderCard();

  await waitFor(() => expect(within(storageRow()).getByText('300.0 GB free')).toBeInTheDocument());
  expect(within(storageRow()).getByText('OK')).toBeInTheDocument();
});

test('flags low free space with an amber CHECK chip', async () => {
  mockSystem({
    cpu: { model: 'Test CPU', cores: 8 },
    gpu: null,
    disk: { path: '/data', total_bytes: 500 * GB, free_bytes: 10 * GB },
  });
  renderCard();

  await waitFor(() => expect(within(storageRow()).getByText('10.0 GB free')).toBeInTheDocument());
  expect(within(storageRow()).getByText('CHECK')).toBeInTheDocument();
});

test('falls back to an honest "—" when the backend reports no disk', async () => {
  mockSystem({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null });
  renderCard();

  // Give the query a tick to resolve, then confirm no fabricated figure.
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(screen.queryByText(/GB free/)).not.toBeInTheDocument();
  // Both the value and the chip in the Storage row are dashes.
  expect(within(storageRow()).getAllByText('—').length).toBeGreaterThanOrEqual(1);
});
