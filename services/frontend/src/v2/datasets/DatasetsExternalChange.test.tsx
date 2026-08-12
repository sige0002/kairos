// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// E-19 — the store changed underneath the screen.
//
// This screen is never the only writer. Another operator has the same page
// open, a script curls the API, a rebuild replays the ledger — and any of them
// can delete the dataset this browser has selected, or the membership row the
// operator is about to press Remove on. The standard here is the same one §12
// sets everywhere else: converge on the SERVER's truth within one refetch, and
// report every refusal with the server's own reason rather than swallowing it.
//
// The fake backend answers exactly as the real router does
// (services/api_orchestrator/src/api_orchestrator/routers/datasets.py plus
// dataset_service.py), because the whole point is the 404 envelopes:
//
//   DELETE /datasets/{id}                  -> 404 dataset_not_found
//   DELETE /datasets/{id}/members/{mid}    -> 404 dataset_member_not_found
//   POST   /datasets/{id}/archive          -> 404 dataset_not_found
//
// A mock that answered 204 to a delete of something already gone would let a UI
// that invents success walk straight through these tests.
//
// "The next refetch" is `queryClient.invalidateQueries()` — not a test-only
// contrivance: it is literally what the SSE `resync` event does
// (src/sse/useEventStream.ts), and what a tab round-trip amounts to.

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { CaptureListItem, Dataset, DatasetMember, ReplicaState } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';
import { datasetTestId, memberTestId } from './data';

interface Backend {
  datasets: Dataset[];
  members: DatasetMember[];
  captures: CaptureListItem[];
  archiveRoots: string[];
  /** When set, POST /datasets/{id}/members answers with this envelope. */
  addMemberError: { status: number; code: string; message: string } | null;
  /** Every request the screen actually sent, `METHOD /path`. */
  calls: string[];
}

function capture(over: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    capture_id: over.capture_id ?? 'cap-1',
    state: over.state ?? 'completed',
    review_status: over.review_status ?? 'adopted',
    review_revision: over.review_revision ?? 0,
    ...over,
  };
}

function replica(state: ReplicaState | null): Partial<CaptureListItem> {
  return {
    replica: state ? { instance_id: 'inst-1', state } : null,
    digest_state: state === 'present_verified' ? 'complete' : 'pending',
  };
}

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
  ...replica('present_verified'),
});
const CAP_C = capture({
  capture_id: 'cap-c',
  run_id: 'run_20260721_092000',
  operator: 'op_a',
  task: 'pick_place',
  started_at: '2026-07-21T09:20:00Z',
  message_count: 800,
  bytes: 700_000_000,
  ...replica('present_verified'),
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

function member(
  membershipId: string,
  captureId: string,
  displayIndex: number,
): DatasetMember {
  return {
    membership_id: membershipId,
    dataset_id: 'ds-kitchen',
    capture_id: captureId,
    display_index: displayIndex,
  };
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): Response {
  return jsonResponse({ error: { code, message, details } }, status);
}

function mockApi(seed: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    datasets: (seed.datasets ?? []).map((d) => ({ ...d })),
    members: (seed.members ?? []).map((m) => ({ ...m })),
    captures: (seed.captures ?? []).map((c) => ({ ...c })),
    archiveRoots: seed.archiveRoots ?? [],
    addMemberError: seed.addMemberError ?? null,
    calls: [],
  };

  const datasetOut = (d: Dataset): Dataset => ({
    ...d,
    member_count: backend.members.filter((m) => m.dataset_id === d.dataset_id).length,
  });
  const withMemberships = (c: CaptureListItem): CaptureListItem => ({
    ...c,
    memberships: backend.members
      .filter((m) => m.capture_id === c.capture_id)
      .map((m) => ({
        membership_id: m.membership_id,
        dataset_id: m.dataset_id,
        dataset_name:
          backend.datasets.find((d) => d.dataset_id === m.dataset_id)?.name ?? null,
        display_index: m.display_index,
      })),
  });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input)
      .replace(/^.*\/api\/v1/, '')
      .split('?')[0]!;
    backend.calls.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // ---- adding a membership ---------------------------------------------
    const addMatch = path.match(/^\/datasets\/([^/]+)\/members$/);
    if (addMatch && method === 'POST') {
      if (backend.addMemberError) {
        const e = backend.addMemberError;
        return errorResponse(e.status, e.code, e.message, {
          dataset_id: decodeURIComponent(addMatch[1]!),
        });
      }
      const created: DatasetMember = {
        membership_id: `m-new`,
        dataset_id: decodeURIComponent(addMatch[1]!),
        capture_id: String(body.capture_id),
        display_index: 1,
      };
      backend.members.push(created);
      return jsonResponse(created, 201);
    }

    // ---- one membership --------------------------------------------------
    const memberMatch = path.match(/^\/datasets\/([^/]+)\/members\/([^/]+)$/);
    if (memberMatch && method === 'DELETE') {
      const datasetId = decodeURIComponent(memberMatch[1]!);
      const membershipId = decodeURIComponent(memberMatch[2]!);
      if (!backend.datasets.some((d) => d.dataset_id === datasetId)) {
        return errorResponse(404, 'dataset_not_found', `Dataset not found: ${datasetId}`, {
          dataset_id: datasetId,
        });
      }
      const found = backend.members.find(
        (m) => m.membership_id === membershipId && m.dataset_id === datasetId,
      );
      if (!found) {
        return errorResponse(
          404,
          'dataset_member_not_found',
          `No member ${membershipId} in dataset ${datasetId}.`,
          { dataset_id: datasetId, membership_id: membershipId },
        );
      }
      backend.members = backend.members.filter((m) => m.membership_id !== membershipId);
      return new Response(null, { status: 204 });
    }

    // ---- the dataset archive run (§6.x) -----------------------------------
    const archiveMatch = path.match(/^\/datasets\/([^/]+)\/archive$/);
    if (archiveMatch) {
      const datasetId = decodeURIComponent(archiveMatch[1]!);
      const dataset = backend.datasets.find((d) => d.dataset_id === datasetId);
      if (!dataset) {
        return errorResponse(404, 'dataset_not_found', `Dataset not found: ${datasetId}`, {
          dataset_id: datasetId,
        });
      }
      if (method === 'POST') {
        dataset.status = 'archiving';
        dataset.archive_mode = (body.mode as string | undefined) ?? 'move';
        dataset.archive_destination = `${body.destination}/${body.path}`;
        return jsonResponse(
          {
            dataset_id: datasetId,
            status: 'archiving',
            destination: dataset.archive_destination,
            mode: dataset.archive_mode,
            member_total: backend.members.filter((m) => m.dataset_id === datasetId).length,
            members_done: 0,
            running: true,
            error: null,
          },
          202,
        );
      }
      return jsonResponse({
        dataset_id: datasetId,
        status: dataset.status,
        destination: dataset.archive_destination ?? null,
        member_total: backend.members.filter((m) => m.dataset_id === datasetId).length,
        members_done: 0,
        running: false,
        error: null,
      });
    }

    // ---- one dataset ------------------------------------------------------
    const datasetMatch = path.match(/^\/datasets\/([^/]+)$/);
    if (datasetMatch) {
      const datasetId = decodeURIComponent(datasetMatch[1]!);
      const found = backend.datasets.find((d) => d.dataset_id === datasetId);
      if (!found) {
        // The service raises this for GET, PATCH and DELETE alike: there is no
        // idempotent "already deleted, fine" answer to give.
        return errorResponse(404, 'dataset_not_found', `Dataset not found: ${datasetId}`, {
          dataset_id: datasetId,
        });
      }
      if (method === 'DELETE') {
        // A sealed dataset's row is what remembers where its recordings went,
        // and a run in flight would be orphaned — dataset_service.py refuses
        // both rather than deleting the record (§6.x).
        if (found.status === 'archived') {
          return errorResponse(
            409,
            'dataset_archived',
            `This dataset was archived to ${found.archive_destination ?? 'an external folder'}; ` +
              'its record is what remembers that and is kept.',
            {
              dataset_id: datasetId,
              archive_destination: found.archive_destination ?? null,
            },
          );
        }
        if (found.status === 'archiving') {
          return errorResponse(
            409,
            'dataset_archiving',
            'This dataset is being archived; let the run finish or resume it. ' +
              'Deleting the record mid-run would orphan the copy in progress.',
            { dataset_id: datasetId },
          );
        }
        backend.datasets = backend.datasets.filter((d) => d.dataset_id !== datasetId);
        backend.members = backend.members.filter((m) => m.dataset_id !== datasetId);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        // Labels freeze with the member set: an archived dataset's labels are
        // baked into the folder its run wrote (§6.1).
        if (found.status !== 'active') {
          // The service shares `_require_active` between label edits and
          // membership changes, so a refused LABEL edit answers about the
          // member set. Quoted as the server actually sends it — a nicer
          // paraphrase here would hide the real wording from every test.
          return errorResponse(
            409,
            'dataset_not_active',
            `Dataset ${found.name || datasetId} is ${found.status}; its member ` +
              'set is frozen.',
            { dataset_id: datasetId, status: found.status },
          );
        }
        if (typeof body.name === 'string' && body.name) found.name = body.name;
        if ('operator' in body) found.operator = body.operator as string | null;
        if ('task' in body) found.task = body.task as string | null;
        return jsonResponse(datasetOut(found));
      }
      return jsonResponse({
        ...datasetOut(found),
        members: backend.members
          .filter((m) => m.dataset_id === datasetId)
          .sort((a, b) => a.display_index - b.display_index),
      });
    }

    if (path === '/datasets') return jsonResponse({ items: backend.datasets.map(datasetOut) });
    if (path === '/transfer/status') return jsonResponse({ available: false });

    // ---- captures ---------------------------------------------------------
    if (path.endsWith('/archive/config')) {
      return jsonResponse({
        enabled: backend.archiveRoots.length > 0,
        roots: backend.archiveRoots,
      });
    }
    const captureMatch = path.match(/^\/captures\/([^/]+)$/);
    if (captureMatch) {
      const captureId = decodeURIComponent(captureMatch[1]!);
      const found = backend.captures.find((c) => c.capture_id === captureId);
      return found
        ? jsonResponse({ ...withMemberships(found), topics: [] })
        : errorResponse(404, 'capture_not_found', `Capture not found: ${captureId}`, {
            capture_id: captureId,
          });
    }
    if (path === '/captures') {
      return jsonResponse({
        items: backend.captures.map(withMemberships),
        next_cursor: null,
      });
    }

    // Loud rather than empty: an unhandled path that answered `{}` would let a
    // test pass on a request nobody modelled.
    return errorResponse(500, 'unhandled_in_mock', `no handler for ${method} ${path}`, {});
  });

  return backend;
}

/** The refetch that follows an out-of-band change — an SSE `resync`, a tab
 *  round-trip, or any other cause. What matters is that it is ONE refetch and
 *  the operator did not ask for it. */
async function nextRefetch(client: QueryClient): Promise<void> {
  await act(async () => {
    await client.invalidateQueries();
    // react-query notifies its observers on a batched schedule, so the refetch
    // resolving is not yet the screen having re-rendered. Give that one turn,
    // or every assertion below reads the state from BEFORE the refetch and the
    // tests pass by looking too early.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const memberRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-membership-id]'));

beforeEach(() => {
  setApiBase('/api/v1');
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

// ---- (a) the selected dataset is deleted out of band ----------------------

test('E-19a: the selected dataset deleted elsewhere is reported as gone, not as an empty selection', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [member('m-1', 'cap-a', 1), member('m-2', 'cap-b', 2)],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(screen.getByTestId(memberTestId('m-1'))).toBeInTheDocument());

  // Another terminal: `curl -XDELETE .../datasets/ds-kitchen`. The memberships
  // go with it; the recordings do not.
  backend.datasets = [];
  backend.members = [];
  await nextRefetch(client);

  // The screen states what happened. Falling back to the ordinary "pick a
  // dataset" prompt would read as "your click was lost", and the operator
  // would click the same missing row again looking for it.
  const gone = await screen.findByTestId('dataset-selection-gone');
  expect(gone).toHaveTextContent('ds-kitchen');
  expect(gone).toHaveTextContent(/no longer in the catalog/i);
  expect(screen.queryByTestId('dataset-none-selected')).not.toBeInTheDocument();
  // Nothing stale is left asserting a membership that no longer exists.
  expect(memberRows()).toHaveLength(0);
  expect(screen.queryByTestId('dataset-scope-title')).not.toBeInTheDocument();

  // It learned this from the list it refetched — not from a request it invented,
  // and least of all from a write.
  expect(backend.calls.filter((c) => c === 'GET /datasets').length).toBeGreaterThan(1);
  expect(backend.calls.some((c) => c.startsWith('DELETE ') || c.startsWith('POST '))).toBe(
    false,
  );

  // And there is a way out that also clears the deep link, so a reload does not
  // land back on the same dead selection.
  fireEvent.click(screen.getByTestId('dataset-selection-gone-clear'));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('dsid')).toBeNull(),
  );
  expect(screen.getByTestId('dataset-none-selected')).toBeInTheDocument();
});

test('E-19a: a dataset merely hidden by the search is NOT reported as gone', async () => {
  // The guard on the guard: `selectedDataset` is null for a search that hides
  // the row too, and claiming a live dataset was deleted would be its own lie.
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(screen.getByTestId(memberTestId('m-1'))).toBeInTheDocument());

  fireEvent.change(screen.getByTestId('dataset-search'), { target: { value: 'zzz' } });
  await screen.findByTestId('dataset-none-selected');
  expect(screen.queryByTestId('dataset-selection-gone')).not.toBeInTheDocument();
});

// ---- (b) a member is removed out of band ---------------------------------

test('E-19b: Remove on a membership deleted elsewhere reports the server refusal and converges', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [member('m-1', 'cap-a', 1), member('m-2', 'cap-b', 2)],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(screen.getByTestId(memberTestId('m-2'))).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(memberTestId('m-2')));
  await screen.findByTestId('remove-member-btn');

  // Removed in another terminal. This screen has not refetched, so the row is
  // still on screen and still armed — the honest starting point for the race.
  backend.members = backend.members.filter((m) => m.membership_id !== 'm-2');
  expect(screen.getByTestId(memberTestId('m-2'))).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('remove-member-btn'));

  // The refusal is surfaced in the server's own words, not swallowed.
  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent('No member m-2 in dataset ds-kitchen.');
  // ...and it is not homework: the screen reloaded rather than telling the
  // operator to do it.
  expect(toast).toHaveTextContent(/reloaded from the server/i);
  expect(
    backend.calls.filter((c) => c === 'DELETE /datasets/ds-kitchen/members/m-2'),
  ).toHaveLength(1);

  // Converged with no second click: the phantom row is gone, #1 is untouched,
  // and the counts follow the server.
  await waitFor(() =>
    expect(screen.queryByTestId(memberTestId('m-2'))).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId(memberTestId('m-1'))).toBeInTheDocument();
  expect(screen.getByTestId('dataset-scope-count')).toHaveTextContent('1 member');
  // A removal — theirs or ours — never touches a recording.
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a', 'cap-b']);
});

test('E-19b: Remove after the whole dataset went — the two sentences do not fuse', async () => {
  // The member DELETE answers `dataset_not_found` when the DATASET is what
  // went, and the store's messages are inconsistent about a trailing period:
  // "No member m-2 in dataset ds-kitchen." has one, "Dataset not found:
  // ds-kitchen" does not. Appending ours to the second produced "...ds-kitchen
  // The member list has been reloaded..." — one broken sentence, and the kind
  // of seam that makes an operator distrust the rest of the line.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(screen.getByTestId(memberTestId('m-1'))).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(memberTestId('m-1')));
  await screen.findByTestId('remove-member-btn');

  backend.datasets = [];
  backend.members = [];
  fireEvent.click(screen.getByTestId('remove-member-btn'));

  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent(
    'Dataset not found: ds-kitchen. The member list has been reloaded from the server.',
  );
  expect(toast.textContent).not.toMatch(/ds-kitchen The member list/);
});

// A `destructive` reading must not be shown as a note that fades. errors.ts
// reserves that severity for failures the operator has to acknowledge (§12),
// and the add path was rendering it into the 2.4s toast — long enough to blink
// through the only explanation of why the action could not be answered.
// Driven by SEVERITY, not by this code: the same holds for `ledger_unwritable`.
test('E-19b: a destructive refusal is held until dismissed, not flashed in a toast', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [],
  });
  backend.addMemberError = {
    status: 503,
    code: 'ledger_unreadable',
    message:
      'The lifecycle ledger (/data/lifecycle.jsonl) could not be read: invalid ' +
      'JSON on line 812. Repair or restore the file, then try again.',
  };
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('dataset-add-cap-a'));

  // Held, with the server's sentence AND the next step, and its own code.
  const held = await screen.findByTestId('dataset-blocking-failure');
  expect(held).toHaveTextContent('invalid JSON on line 812');
  expect(held).toHaveTextContent(/repair or restore/i);
  expect(held).toHaveAttribute('data-error-code', 'ledger_unreadable');
  // Not the fading pill.
  expect(screen.queryByTestId('toast')).not.toBeInTheDocument();

  // It is still there well after a toast would have gone (TOAST_MS = 2400).
  await new Promise((resolve) => setTimeout(resolve, 2600));
  expect(screen.getByTestId('dataset-blocking-failure')).toBeInTheDocument();

  // And it goes only when the operator says so.
  fireEvent.click(screen.getByTestId('dataset-blocking-failure-dismiss'));
  await waitFor(() =>
    expect(screen.queryByTestId('dataset-blocking-failure')).not.toBeInTheDocument(),
  );
  expect(backend.members).toHaveLength(0);
});

// The ordinary refusals stay in the toast: a warning the operator can act on
// without acknowledging does not deserve a modal-sized interruption.
test('E-19b: a warning-severity refusal still uses the toast', async () => {
  const backend = mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A], members: [] });
  backend.addMemberError = {
    status: 409,
    code: 'dataset_member_exists',
    message: 'cap-a is already in ds-kitchen.',
  };
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('dataset-add-cap-a'));

  expect(await screen.findByTestId('toast')).toHaveTextContent('already in ds-kitchen');
  expect(screen.queryByTestId('dataset-blocking-failure')).not.toBeInTheDocument();
});

// ---- (c) the target vanishes under an open dialog -------------------------

test('E-19c: the dataset deleted under an open Delete dialog — the dialog stays and says so', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('delete-dataset-btn'));
  expect(await screen.findByTestId('delete-dataset-dialog')).toBeInTheDocument();

  backend.datasets = [];
  backend.members = [];
  await nextRefetch(client);

  // The dialog must not evaporate with the row underneath it: it is holding a
  // destructive control the operator is one click from pressing, and a dialog
  // that disappears by itself is indistinguishable from one they dismissed.
  const dialog = await screen.findByTestId('delete-dataset-dialog');
  expect(within(dialog).getByTestId('delete-dataset-gone')).toHaveTextContent(
    /no longer in the catalog/i,
  );
  expect(screen.getByTestId('delete-dataset-confirm')).toBeDisabled();

  fireEvent.click(screen.getByTestId('delete-dataset-confirm'));
  expect(backend.calls.some((c) => c === 'DELETE /datasets/ds-kitchen')).toBe(false);
});

test('E-19c: Delete pressed before the refetch — the 404 is shown with its code, never a success toast', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('delete-dataset-btn'));
  await screen.findByTestId('delete-dataset-dialog');

  // Deleted elsewhere while the dialog sat open; this time the click wins the
  // race, so the server is the one that says no.
  backend.datasets = [];
  backend.members = [];
  fireEvent.click(screen.getByTestId('delete-dataset-confirm'));

  await waitFor(() =>
    expect(backend.calls.filter((c) => c === 'DELETE /datasets/ds-kitchen')).toHaveLength(1),
  );
  const dialog = await screen.findByTestId('delete-dataset-dialog');
  const alert = within(dialog).getByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'dataset_not_found');
  expect(alert).toHaveTextContent('Dataset not found: ds-kitchen');
  // Nothing claims the delete worked.
  expect(screen.queryByTestId('toast')).not.toBeInTheDocument();

  // And the failure still converges: the dialog ends up saying the dataset is
  // gone, with the refusal it got kept on screen beside it.
  await waitFor(() =>
    expect(within(dialog).getByTestId('delete-dataset-gone')).toBeInTheDocument(),
  );
  expect(screen.getByTestId('delete-dataset-confirm')).toBeDisabled();
  expect(screen.queryByTestId(datasetTestId('ds-kitchen'))).not.toBeInTheDocument();
});

test('E-19c: the dataset deleted under an open Edit dialog — the dialog stays and Save stands down', async () => {
  // The edit dialog is not destructive, but it is the fourth door onto the same
  // vanished row, and it now survives the deletion for the same reason the
  // other three do. A live "Save labels" that can only 404 is the same defect
  // one door down.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('edit-dataset-btn'));
  expect(await screen.findByTestId('edit-dataset-dialog')).toBeInTheDocument();

  backend.datasets = [];
  backend.members = [];
  await nextRefetch(client);

  const dialog = await screen.findByTestId('edit-dataset-dialog');
  expect(within(dialog).getByTestId('edit-dataset-gone')).toHaveTextContent(
    /no longer in the catalog/i,
  );
  expect(screen.getByTestId('edit-dataset-submit')).toBeDisabled();

  fireEvent.click(screen.getByTestId('edit-dataset-submit'));
  expect(backend.calls.some((c) => c === 'PATCH /datasets/ds-kitchen')).toBe(false);
});

test('E-19c: Save pressed before the refetch — the 404 is shown, and the dialog converges', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('edit-dataset-btn'));
  fireEvent.change(await screen.findByTestId('edit-dataset-name'), {
    target: { value: 'kitchen picks v2' },
  });

  // Deleted elsewhere while the operator was typing; the click wins the race.
  backend.datasets = [];
  backend.members = [];
  fireEvent.click(screen.getByTestId('edit-dataset-submit'));

  await waitFor(() =>
    expect(backend.calls.filter((c) => c === 'PATCH /datasets/ds-kitchen')).toHaveLength(1),
  );
  const dialog = await screen.findByTestId('edit-dataset-dialog');
  const alert = within(dialog).getByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'dataset_not_found');
  expect(alert).toHaveTextContent('Dataset not found: ds-kitchen');
  // No toast claims a rename that never happened.
  expect(screen.queryByTestId('toast')).not.toBeInTheDocument();

  // And the refusal converges like its siblings: the dialog ends up saying the
  // dataset is gone, with the server's reason kept beside it.
  await waitFor(() =>
    expect(within(dialog).getByTestId('edit-dataset-gone')).toBeInTheDocument(),
  );
  expect(screen.getByTestId('edit-dataset-submit')).toBeDisabled();
});

// The neighbouring state to `selectionGone`, and a different claim: the dataset
// still EXISTS, an external archive just moved it off the working shelf. The
// row leaves `rows` while staying in the unfiltered list, so the dialog is not
// "gone" and its control stays live.
//
// That is a CHOICE, not a limitation. The client can tell these apart without
// asking: `isDatasetFrozen` reads the unfiltered `datasetById`, and the header's
// own Delete button is already disabled on `status !== 'active'`
// (DatasetCenter.tsx). The dialog deliberately does not add a second gate —
// one authority. The server's 409 names the destination and why the record is
// kept, it costs one request that changes nothing, and a client-side copy of
// that rule is one more thing that can drift out of step with it. The header
// gate stays because it is a hint on a control the operator has not committed
// to yet; the dialog is the commitment, and commitments are settled by the
// server.
test('E-19c: a dataset archived under an open Delete dialog is refused by the server, with its reason', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('delete-dataset-btn'));
  await screen.findByTestId('delete-dataset-dialog');

  // Someone archived it from another terminal: still in the catalog, no longer
  // on the Active shelf this operator is looking at.
  backend.datasets[0]!.status = 'archived';
  backend.datasets[0]!.archive_destination = '/mnt/archive/op_a/pick_place/kitchen picks';
  await nextRefetch(client);

  const dialog = await screen.findByTestId('delete-dataset-dialog');
  // NOT the "gone" note: the dataset exists, and saying it was deleted would be
  // a different lie from the one we set out to fix.
  expect(within(dialog).queryByTestId('delete-dataset-gone')).not.toBeInTheDocument();
  // With no row in view there is no member count to state, so the dialog names
  // the identity it still has rather than inventing "0 memberships".
  expect(dialog).toHaveTextContent('ds-kitchen');
  expect(dialog).not.toHaveTextContent('0 membership');

  fireEvent.click(screen.getByTestId('delete-dataset-confirm'));

  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'dataset_archived');
  expect(alert).toHaveTextContent('/mnt/archive/op_a/pick_place/kitchen picks');
  // Quoted from dataset_service.py rather than paraphrased, so a mock that
  // drifts from the server's wording breaks here instead of in review.
  expect(alert).toHaveTextContent('its record is what remembers that and is kept');
  // The record survives — it is what remembers where the recordings went.
  expect(backend.datasets.map((d) => d.dataset_id)).toEqual(['ds-kitchen']);
});

test('E-19c: a dataset archived under an open Edit dialog — Save is refused, and says so', async () => {
  // The companion to the case above, and the one the dialog's own header now
  // describes: the button that OPENS the edit dialog is gated on `active`, but
  // that gate cannot hold once the dialog is open and the dataset changes
  // underneath it. The server settles it.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('edit-dataset-btn'));
  fireEvent.change(await screen.findByTestId('edit-dataset-name'), {
    target: { value: 'kitchen picks v2' },
  });

  backend.datasets[0]!.status = 'archived';
  backend.datasets[0]!.archive_destination = '/mnt/archive/op_a/pick_place/kitchen picks';
  await nextRefetch(client);

  // Not "gone" — the dataset exists — so the form stays and Save stays live.
  expect(screen.queryByTestId('edit-dataset-gone')).not.toBeInTheDocument();
  expect(screen.getByTestId('edit-dataset-submit')).toBeEnabled();

  fireEvent.click(screen.getByTestId('edit-dataset-submit'));

  const dialog = await screen.findByTestId('edit-dataset-dialog');
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'dataset_not_active');
  // The server's real sentence, quoted: `_require_active` is shared with the
  // membership path, so a refused LABEL edit answers about the member set.
  // That is the product's wording, and a mock that improved on it would hide
  // the mismatch an operator actually sees.
  expect(alert).toHaveTextContent('Dataset kitchen picks is archived; its member set is frozen.');
  // Nothing was renamed, and no toast says otherwise.
  expect(backend.datasets[0]!.name).toBe('kitchen picks');
  expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
});

test('E-19c: the dataset deleted under an open Archive dialog — no run is started', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [member('m-1', 'cap-a', 1)],
    archiveRoots: ['/mnt/archive'],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));
  await screen.findByTestId('dataset-archive-dialog');

  backend.datasets = [];
  backend.members = [];
  await nextRefetch(client);

  const dialog = await screen.findByTestId('dataset-archive-dialog');
  expect(within(dialog).getByTestId('dataset-archive-gone')).toHaveTextContent(
    /no longer in the catalog/i,
  );
  expect(screen.getByTestId('dataset-archive-confirm')).toBeDisabled();

  fireEvent.click(screen.getByTestId('dataset-archive-confirm'));
  expect(backend.calls.some((c) => c === 'POST /datasets/ds-kitchen/archive')).toBe(false);
});

// ---- (d) numbering after an out-of-band removal ---------------------------

test('E-19d: after an out-of-band removal the numbers are the server’s — #1 and #3, never a renumbering', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B, CAP_C],
    members: [
      member('m-1', 'cap-a', 1),
      member('m-2', 'cap-b', 2),
      member('m-3', 'cap-c', 3),
    ],
  });
  const { client } = renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => expect(memberRows()).toHaveLength(3));
  fireEvent.click(screen.getByTestId(memberTestId('m-3')));
  expect(await screen.findByTestId('dataset-member-number')).toHaveTextContent('#3');

  // #2 is removed from another terminal. §6: the number retires with it and no
  // survivor is renumbered — so the table must read #1, #3.
  backend.members = backend.members.filter((m) => m.membership_id !== 'm-2');
  await nextRefetch(client);

  await waitFor(() => expect(memberRows()).toHaveLength(2));
  expect(memberRows().map((row) => row.getAttribute('data-display-index'))).toEqual([
    '1',
    '3',
  ]);
  const scroll = screen.getByTestId('dataset-member-scroll');
  expect(within(scroll).getByText('#1')).toBeInTheDocument();
  expect(within(scroll).getByText('#3')).toBeInTheDocument();
  expect(within(scroll).queryByText('#2')).not.toBeInTheDocument();
  // The open detail keeps its own number rather than sliding down to #2.
  expect(screen.getByTestId('dataset-member-number')).toHaveTextContent('#3');

  // Both counts are the server's: two members, and the list row agrees.
  expect(screen.getByTestId('dataset-scope-count')).toHaveTextContent('2 members');
  expect(
    within(screen.getByTestId(datasetTestId('ds-kitchen'))).getByText('2 members'),
  ).toBeInTheDocument();
});
