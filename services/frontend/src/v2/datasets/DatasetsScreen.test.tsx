import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { Capture, Dataset, DatasetMember, ReplicaState } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';
import { datasetTestId, memberTestId } from './data';

// ---- a fake capture-store, honest about the rules the real one enforces ----
//
// The three that matter to this screen are modelled rather than stubbed, because
// they are exactly what the UI has to get right:
//
//   * display_index comes from a per-dataset HIGH-WATER MARK that a removal
//     never rolls back (§6) — a retired number is gone for good.
//   * POST /captures/{id}/delete is refused with 400 `capture_in_dataset` while
//     the capture is still a member (§7).
//   * a capture may have NO local replica and still be a legitimate member (§12).

interface Backend {
  datasets: Dataset[];
  members: DatasetMember[];
  captures: Capture[];
  /** Per-dataset next display_index; only ever increases. */
  highWater: Record<string, number>;
  /** What `GET /transfer/status` answers — true only on a split deploy. */
  transferAvailable: boolean;
  /** Configured KAIROS_ARCHIVE_ROOTS; empty means the feature is not offered. */
  archiveRoots: string[];
  /** Whether the copy verifies. `false` is the honesty case §6 cares about. */
  archiveVerifies: boolean;
  archived: { captureId: string; destination: string; reason: string | null }[];
  calls: string[];
}

function capture(over: Partial<Capture> = {}): Capture {
  return {
    capture_id: over.capture_id ?? 'cap-1',
    state: over.state ?? 'completed',
    review_status: over.review_status ?? 'pending',
    review_revision: over.review_revision ?? 0,
    ...over,
  };
}

function replica(state: ReplicaState | null): Partial<Capture> {
  return {
    replica: state ? { instance_id: 'inst-1', state } : null,
    digest_state: state === 'present_verified' ? 'complete' : 'pending',
  };
}

/** The one capture that may actually join a dataset: its bytes are here AND
 *  Review adopted it. Both are preconditions for "+ Add", so a fixture that is
 *  used to exercise adding has to satisfy both. */
const CAP_A = capture({
  capture_id: 'cap-a',
  run_id: 'run_20260721_090000',
  operator: 'op_a',
  task: 'pick_place',
  started_at: '2026-07-21T09:00:00Z',
  ended_at: '2026-07-21T09:01:00Z',
  message_count: 1057,
  bytes: 1_200_000_000,
  task_result: 'success',
  quality: 'good',
  review_status: 'adopted',
  ...replica('present_verified'),
});
const CAP_B = capture({
  capture_id: 'cap-b',
  run_id: 'run_20260721_091000',
  operator: 'op_b',
  task: 'pick_place',
  started_at: '2026-07-21T09:10:00Z',
  message_count: 990,
  bytes: 800_000_000,
  task_result: 'failure',
  failure_reason: 'Grasp missed',
  quality: 'needs_review',
  ...replica('present_unverified'),
});
/** Reviewed on the robot; the bytes have not been pulled across yet (§12). */
const CAP_AWAY = capture({
  capture_id: 'cap-away',
  run_id: 'run_20260721_092000',
  operator: 'op_a',
  started_at: '2026-07-21T09:20:00Z',
  ...replica(null),
});

const DS_KITCHEN: Dataset = {
  dataset_id: 'ds-kitchen',
  name: 'kitchen picks',
  operator: 'op_a',
  task: 'pick_place',
  status: 'active',
  created_at: '2026-07-21T08:00:00Z',
  member_count: 0,
};

function withMemberships(backend: Backend, c: Capture): Capture {
  const memberships = backend.members
    .filter((m) => m.capture_id === c.capture_id)
    .map((m) => ({
      membership_id: m.membership_id,
      dataset_id: m.dataset_id,
      dataset_name:
        backend.datasets.find((d) => d.dataset_id === m.dataset_id)?.name ?? null,
      display_index: m.display_index,
    }));
  return { ...c, memberships };
}

function mockApi(seed: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    datasets: seed.datasets ?? [],
    members: seed.members ?? [],
    captures: seed.captures ?? [],
    highWater: seed.highWater ?? {},
    transferAvailable: seed.transferAvailable ?? false,
    archiveRoots: seed.archiveRoots ?? [],
    archiveVerifies: seed.archiveVerifies ?? true,
    archived: [],
    calls: [],
  };
  let nextId = 1;

  const datasetOut = (d: Dataset): Dataset => ({
    ...d,
    member_count: backend.members.filter((m) => m.dataset_id === d.dataset_id).length,
  });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(/^.*\/api\/v1/, '').split('?')[0]!;
    backend.calls.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // ---- datasets --------------------------------------------------------
    const memberMatch = path.match(/^\/datasets\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (memberMatch) {
      const datasetId = decodeURIComponent(memberMatch[1]!);
      if (method === 'POST') {
        const index = backend.highWater[datasetId] ?? 1;
        backend.highWater[datasetId] = index + 1;
        const created: DatasetMember = {
          membership_id: `m-${nextId++}`,
          dataset_id: datasetId,
          capture_id: String(body.capture_id),
          display_index: index,
        };
        backend.members.push(created);
        return jsonResponse(created, 201);
      }
      // DELETE: the row goes, the number stays retired.
      const membershipId = decodeURIComponent(memberMatch[2]!);
      backend.members = backend.members.filter((m) => m.membership_id !== membershipId);
      return new Response(null, { status: 204 });
    }

    const datasetMatch = path.match(/^\/datasets\/([^/]+)$/);
    if (datasetMatch) {
      const datasetId = decodeURIComponent(datasetMatch[1]!);
      if (method === 'DELETE') {
        backend.datasets = backend.datasets.filter((d) => d.dataset_id !== datasetId);
        backend.members = backend.members.filter((m) => m.dataset_id !== datasetId);
        return new Response(null, { status: 204 });
      }
      const found = backend.datasets.find((d) => d.dataset_id === datasetId);
      if (!found) {
        return jsonResponse(
          { error: { code: 'dataset_not_found', message: 'gone' } },
          404,
        );
      }
      return jsonResponse({
        ...datasetOut(found),
        members: backend.members
          .filter((m) => m.dataset_id === datasetId)
          .sort((a, b) => a.display_index - b.display_index),
      });
    }

    if (path === '/datasets') {
      if (method === 'POST') {
        const created: Dataset = {
          dataset_id: `ds-${nextId++}`,
          name: String(body.name),
          operator: (body.operator as string | null) ?? null,
          task: (body.task as string | null) ?? null,
          status: 'active',
          created_at: '2026-07-22T08:00:00Z',
          member_count: 0,
        };
        backend.datasets.push(created);
        return jsonResponse(created, 201);
      }
      return jsonResponse({ items: backend.datasets.map(datasetOut) });
    }

    if (path === '/transfer/status') {
      return jsonResponse({ available: backend.transferAvailable });
    }

    // ---- captures --------------------------------------------------------
    if (path.endsWith('/archive/config')) {
      return jsonResponse({
        enabled: backend.archiveRoots.length > 0,
        roots: backend.archiveRoots,
      });
    }
    const archiveMatch = path.match(/^\/captures\/([^/]+)\/archive$/);
    if (archiveMatch && method === 'POST') {
      const captureId = decodeURIComponent(archiveMatch[1]!);
      // The real service refuses a dataset member here for the same reason it
      // refuses a delete: the dataset would be left citing something gone.
      if (backend.members.some((m) => m.capture_id === captureId)) {
        return jsonResponse(
          {
            error: {
              code: 'capture_in_dataset',
              message: `${captureId} belongs to a dataset; remove it first.`,
            },
          },
          400,
        );
      }
      const destination = String(body.destination);
      backend.archived.push({
        captureId,
        destination,
        reason: (body.reason as string | null) ?? null,
      });
      backend.captures = backend.captures.filter((c) => c.capture_id !== captureId);
      return jsonResponse({
        capture_id: captureId,
        // The server writes into <destination>/<capture_id> and echoes THAT.
        destination: `${destination}/${captureId}`,
        bytes: 1_200_000_000,
        file_count: 3,
        files: [],
        verified: backend.archiveVerifies,
      });
    }
    const deleteMatch = path.match(/^\/captures\/([^/]+)\/delete$/);
    if (deleteMatch) {
      const captureId = decodeURIComponent(deleteMatch[1]!);
      const memberships = backend.members.filter((m) => m.capture_id === captureId);
      if (memberships.length > 0) {
        return jsonResponse(
          {
            error: {
              code: 'capture_in_dataset',
              message: `${captureId} belongs to ${memberships.length} dataset(s); remove it from them first.`,
              details: { capture_id: captureId },
            },
          },
          400,
        );
      }
      backend.captures = backend.captures.filter((c) => c.capture_id !== captureId);
      return jsonResponse({ capture_id: captureId, state: 'discarded' });
    }
    const captureMatch = path.match(/^\/captures\/([^/]+)$/);
    if (captureMatch) {
      const captureId = decodeURIComponent(captureMatch[1]!);
      const found = backend.captures.find((c) => c.capture_id === captureId);
      return found
        ? jsonResponse({ ...withMemberships(backend, found), topics: [] })
        : jsonResponse({ error: { code: 'capture_not_found', message: 'gone' } }, 404);
    }
    if (path === '/captures') {
      return jsonResponse({
        items: backend.captures.map((c) => withMemberships(backend, c)),
        next_cursor: null,
      });
    }

    return jsonResponse({});
  });

  return backend;
}

/** The member row for a capture, found by the data attribute the row carries. */
function memberRowFor(captureId: string): HTMLElement {
  const row = document.querySelector(`[data-capture-id="${captureId}"][data-membership-id]`);
  if (!row) throw new Error(`no member row for ${captureId}`);
  return row as HTMLElement;
}

beforeEach(() => {
  setApiBase('/api/v1');
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

// ---- the list ------------------------------------------------------------

test('lists datasets with an honest aggregate over their members', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    highWater: { 'ds-kitchen': 3 },
  });
  renderWithClient(<DatasetsScreen />);

  const row = await screen.findByTestId(datasetTestId('ds-kitchen'));
  expect(within(row).getByText('kitchen picks')).toBeInTheDocument();
  expect(within(row).getByText('2 members')).toBeInTheDocument();
  expect(within(row).getByText('✓1 ✗1')).toBeInTheDocument();
  expect(within(row).getByText('2 here')).toBeInTheDocument();
});

test('a dataset with no labels says so instead of showing a 0/0 split', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [capture({ capture_id: 'cap-plain', ...replica('present_verified') })],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-plain', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  const row = await screen.findByTestId(datasetTestId('ds-kitchen'));
  expect(within(row).getByText('no labels')).toBeInTheDocument();
  expect(within(row).queryByText(/✓/)).not.toBeInTheDocument();
  // Exact text: "1 members" would not match, and that is the point.
  expect(within(row).getByText('1 member')).toBeInTheDocument();
});

// ---- creating ------------------------------------------------------------

test('creating a dataset posts it, selects it, and states that nothing moved', async () => {
  const backend = mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  fireEvent.change(screen.getByTestId('new-dataset-name'), {
    target: { value: 'shelf restock' },
  });
  fireEvent.change(screen.getByTestId('new-dataset-operator'), { target: { value: 'op_a' } });
  fireEvent.click(screen.getByTestId('new-dataset-submit'));

  await waitFor(() => expect(backend.datasets).toHaveLength(1));
  expect(backend.datasets[0]).toMatchObject({
    name: 'shelf restock',
    operator: 'op_a',
    task: null,
  });
  // The new dataset becomes the scope, and the toast says the recordings were
  // not touched — the model this replaced would have MOVED them.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('shelf restock'),
  );
  expect(screen.getByTestId('toast')).toHaveTextContent('nothing was written under objects/');
});

test('a nameless dataset cannot be submitted', async () => {
  const backend = mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  expect(screen.getByTestId('new-dataset-submit')).toBeDisabled();
  expect(backend.calls.filter((c) => c === 'POST /datasets')).toHaveLength(0);
});

// ---- membership ----------------------------------------------------------

test('adding a capture creates a membership and moves nothing on disk', async () => {
  const backend = mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('dataset-add-cap-a'));

  await waitFor(() => expect(backend.members).toHaveLength(1));
  expect(backend.members[0]).toMatchObject({ capture_id: 'cap-a', display_index: 1 });
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  expect(screen.getByTestId('toast')).toHaveTextContent('the recording did not move');
  // Adding a member never asks the server to rebuild views/ (§6: server-owned).
  expect(backend.calls.some((c) => c.includes('/views'))).toBe(false);

  // One member is "1 member". A count that disagrees with its noun reads as a
  // rendering fault and takes the number's credibility with it.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-count').textContent).toBe('1 member'),
  );
  expect(screen.getByTestId('build-target').textContent).toMatch(/\b1 member\b/);
});

test('a capture that cannot legitimately join a dataset is listed with a dead "+ Add" and the reason', async () => {
  // Two independent preconditions, and the control has to say WHICH one failed:
  // "unavailable" sends the operator looking in the wrong place. Nothing is
  // hidden from the rail — a candidate the operator cannot see is a refusal
  // they cannot understand.
  const CAP_ADOPTED_AWAY = capture({
    capture_id: 'cap-adopted-away',
    run_id: 'run_20260721_093000',
    review_status: 'adopted',
    ...replica(null),
  });
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B, CAP_ADOPTED_AWAY, CAP_AWAY],
  });
  renderWithClient(<DatasetsScreen />);
  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));

  for (const id of ['cap-a', 'cap-b', 'cap-adopted-away', 'cap-away']) {
    expect(await screen.findByTestId(`dataset-candidate-${id}`)).toBeInTheDocument();
  }

  // Bytes here AND adopted: the only one that may join.
  await waitFor(() => expect(screen.getByTestId('dataset-add-cap-a')).toBeEnabled());

  // Readable here, but Review has not adopted it.
  const notAdopted = screen.getByTestId('dataset-add-cap-b');
  expect(notAdopted).toBeDisabled();
  expect(notAdopted.title).toMatch(/adopted in Review/);
  expect(notAdopted.title).not.toMatch(/not on this machine/);

  // Adopted, but the bytes never landed on this host.
  const notHere = screen.getByTestId('dataset-add-cap-adopted-away');
  expect(notHere).toBeDisabled();
  expect(notHere.title).toMatch(/not on this machine/);
  expect(notHere.title).not.toMatch(/adopted in Review/);

  // Neither: both reasons are named, so fixing one does not leave the operator
  // clicking a still-dead button with no new explanation.
  const neither = screen.getByTestId('dataset-add-cap-away');
  expect(neither).toBeDisabled();
  expect(neither.title).toMatch(/not on this machine/);
  expect(neither.title).toMatch(/adopted in Review/);

  fireEvent.click(notAdopted);
  fireEvent.click(notHere);
  expect(backend.calls.some((c) => c.startsWith('POST /datasets/'))).toBe(false);
  expect(backend.members).toHaveLength(0);
});

test('removing a member leaves the capture alone and never reissues its number', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    highWater: { 'ds-kitchen': 3 },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());

  // Select #1 and remove it.
  fireEvent.click(memberRowFor('cap-a'));
  fireEvent.click(await screen.findByTestId('remove-member-btn'));

  await waitFor(() => expect(backend.members.map((m) => m.membership_id)).toEqual(['m-2']));
  // The capture itself is untouched — a removal is not a deletion.
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a', 'cap-b']);
  await waitFor(() =>
    expect(screen.queryByTestId(memberTestId('m-1'))).not.toBeInTheDocument(),
  );

  // Re-adding gives the NEXT number, never the retired #1 (§6).
  fireEvent.click(await screen.findByTestId('dataset-add-cap-a'));
  await waitFor(() => expect(backend.members).toHaveLength(2));
  const readded = backend.members.find((m) => m.capture_id === 'cap-a')!;
  expect(readded.display_index).toBe(3);
  await waitFor(() =>
    expect(memberRowFor('cap-a')).toHaveAttribute('data-display-index', '3'),
  );
  // #2 kept its own number throughout: the survivors are not renumbered.
  expect(memberRowFor('cap-b')).toHaveAttribute('data-display-index', '2');
});

test('a surviving member keeps its number even when it is the only one left', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_B],
    // #1 was removed some time ago; #2 is what remains.
    members: [
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    highWater: { 'ds-kitchen': 3 },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRowFor('cap-b')).toBeInTheDocument());
  // Not "#1": display_index is a label, never a position in the list.
  expect(within(memberRowFor('cap-b')).getByText('#2')).toBeInTheDocument();
});

// ---- split deploy (§12) --------------------------------------------------

test('a member whose bytes are not on this host still renders, as a normal state', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_AWAY],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-away', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  const chip = await screen.findByTestId('dataset-member-availability-m-1');
  expect(chip).toHaveAttribute('data-availability', 'awaiting_transfer');
  expect(chip).toHaveTextContent('not here yet');
  // And it is counted apart from the states that need a look.
  const row = screen.getByTestId(datasetTestId('ds-kitchen'));
  expect(within(row).getByText('1 not here yet')).toBeInTheDocument();
  expect(within(row).queryByText(/need a look/)).not.toBeInTheDocument();
});

test('a member the catalog has no capture for is shown, not silently dropped', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-gone', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  expect(await screen.findByTestId('dataset-member-unresolved-m-1')).toHaveTextContent(
    'not in the catalog',
  );
});

// ---- the delete ordering rule (§7) ---------------------------------------

test('discarding a member is refused, and the dialog says to remove it first', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  fireEvent.click(memberRowFor('cap-a'));

  // The ordering is stated BEFORE anything is clicked.
  expect(await screen.findByTestId('dataset-member-order-note')).toHaveTextContent(
    /Remove it from this dataset first/,
  );

  fireEvent.click(screen.getByTestId('discard-member-btn'));
  fireEvent.change(screen.getByTestId('discard-reason'), {
    target: { value: 'unusable take' },
  });
  fireEvent.click(screen.getByTestId('discard-confirm'));

  const error = await screen.findByTestId('discard-error');
  expect(error).toHaveAttribute('data-error-code', 'capture_in_dataset');
  expect(error).toHaveTextContent('Remove it from the dataset first');
  // Nothing was destroyed.
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a']);
});

test('taking the removal path clears the block the discard ran into', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  fireEvent.click(memberRowFor('cap-a'));
  fireEvent.click(await screen.findByTestId('remove-member-btn'));
  await waitFor(() => expect(backend.members).toHaveLength(0));

  // It is no longer a member, so the dataset no longer holds a delete back —
  // and the capture is offered as something to add, not as something gone.
  expect(document.querySelector('[data-capture-id="cap-a"][data-membership-id]')).toBeNull();
  expect(screen.queryByTestId('discard-member-btn')).not.toBeInTheDocument();
  expect(await screen.findByTestId('dataset-candidate-cap-a')).toBeInTheDocument();
});

test('on a split deploy the discard dialog says a copy may remain on the robot', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    transferAvailable: true,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('dataset-add-cap-a'));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  fireEvent.click(memberRowFor('cap-a'));
  fireEvent.click(await screen.findByTestId('discard-member-btn'));

  // §12: the operator must not walk away believing the recording is gone
  // everywhere when only this machine's copy was removed.
  expect(await screen.findByTestId('discard-split-note')).toHaveTextContent(
    /copy may still exist on the robot/,
  );
});

// ---- deleting the dataset ------------------------------------------------

test('deleting a dataset removes the rows and says no recording is touched', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('delete-dataset-btn'));
  expect(screen.getByTestId('delete-dataset-scope')).toHaveTextContent(
    'No recording is deleted',
  );
  fireEvent.click(screen.getByTestId('delete-dataset-confirm'));

  await waitFor(() => expect(backend.datasets).toHaveLength(0));
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a']);
  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('All datasets'),
  );
});

// ---- archive capability --------------------------------------------------

test('with no archive roots configured the control is never offered', async () => {
  mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);

  await screen.findByTestId('dataset-candidate-cap-a');
  await waitFor(() => expect(screen.getByTestId('dataset-add-cap-a')).toBeInTheDocument());
  expect(screen.queryByTestId('dataset-archive-cap-a')).not.toBeInTheDocument();
});

// ---- addressability ------------------------------------------------------

test('the selection is addressable by dataset_id and membership_id', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  fireEvent.click(memberRowFor('cap-a'));

  await waitFor(() => {
    const params = new URLSearchParams(window.location.search);
    expect(params.get('dsid')).toBe('ds-kitchen');
    expect(params.get('dsmem')).toBe('m-1');
  });
});

test('a deep link restores the dataset and member it names', async () => {
  window.history.replaceState(null, '', '/?tab=datasets&dsid=ds-kitchen&dsmem=m-1');
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('dataset-scope-title')).toHaveTextContent('kitchen picks'),
  );
  expect(await screen.findByTestId('dataset-member-number')).toHaveTextContent('#1');
  // The shell's own key survives the round-trip untouched.
  expect(new URLSearchParams(window.location.search).get('tab')).toBe('datasets');
});

// ---- archive (§6): copy out, verify, THEN remove the source ---------------

test('the archive destination is the PARENT — the server appends the capture id', async () => {
  // The operator types where the capture should land beside its siblings; the
  // server writes into `<destination>/<capture_id>`. Sending the id-suffixed
  // path would bury the archive one level deeper than intended, so the dialog
  // shows both and submits only the parent.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    archiveRoots: ['/mnt/archive'],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('dataset-archive-cap-a'));
  const destination = await screen.findByTestId('archive-destination');
  // Default subpath is the capture's own operator/task, not an invented folder.
  expect(destination).toHaveTextContent('/mnt/archive/op_a/pick_place');
  expect(screen.getByTestId('archive-final-path')).toHaveTextContent(
    '/mnt/archive/op_a/pick_place/cap-a',
  );

  fireEvent.change(screen.getByTestId('archive-reason'), {
    target: { value: 'end of study' },
  });
  fireEvent.click(screen.getByTestId('archive-confirm'));

  await waitFor(() => expect(backend.archived).toHaveLength(1));
  expect(backend.archived[0]).toEqual({
    captureId: 'cap-a',
    destination: '/mnt/archive/op_a/pick_place',
    reason: 'end of study',
  });
});

test('a dataset member is not offered archive at all', async () => {
  // The backend refuses it (400 capture_in_dataset) because the dataset would
  // be left citing something gone, so offering the control would be offering a
  // guaranteed failure.
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    archiveRoots: ['/mnt/archive'],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  expect(await screen.findByTestId('dataset-archive-cap-a')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('dataset-add-cap-a'));
  await waitFor(() => expect(memberRowFor('cap-a')).toBeInTheDocument());
  await waitFor(() =>
    expect(screen.queryByTestId('dataset-archive-cap-a')).not.toBeInTheDocument(),
  );
});

test('a copy that did not verify is reported as such, never as archived', async () => {
  // The source is deleted moments after the copy, so an unverified archive is
  // the one outcome the operator must not read as success.
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    archiveRoots: ['/mnt/archive'],
    archiveVerifies: false,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('dataset-archive-cap-a'));
  fireEvent.click(await screen.findByTestId('archive-confirm'));

  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent(/did NOT verify/);
  expect(toast).not.toHaveTextContent(/^Archived to/);
});
