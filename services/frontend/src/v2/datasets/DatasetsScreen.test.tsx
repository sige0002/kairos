import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type {
  CaptureListItem,
  Dataset,
  DatasetArchiveProgress,
  DatasetMember,
  ReplicaState,
} from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { DatasetsScreen } from './DatasetsScreen';
import { datasetTestId, memberTestId } from './data';
import {
  __resetCaptureArchivePollMs,
  __setCaptureArchivePollMs,
} from './useDatasetsState';
import { expectScreenHeadingOutline } from '../../test/headingOutline';

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
  captures: CaptureListItem[];
  /** Per-dataset next display_index; only ever increases. */
  highWater: Record<string, number>;
  /** What `GET /transfer/status` answers — true only on a split deploy. */
  transferAvailable: boolean;
  /** Configured KAIROS_ARCHIVE_ROOTS; empty means the feature is not offered. */
  archiveRoots: string[];
  /** Whether the copy verifies. `false` is the honesty case §6 cares about. */
  archiveVerifies: boolean;
  /** When true, every capture page reports another page after it, so the
   *  client's own MAX_PAGES cap is reached and the sweep comes back
   *  truncated — the real path, not a faked flag. */
  capturesNeverEnd: boolean;
  /** When true, a per-capture archive is refused because the destination
   *  already holds files (409 destination_not_empty, captures.py). */
  archiveDestinationNotEmpty: boolean;
  /** Hold POST /datasets open. The write has left and its answer has not come
   *  back — the window in which a dismissal must not be obeyed. */
  holdCreate: boolean;
  /** Let a held POST /datasets finish. */
  releaseCreate: () => void;
  archived: { captureId: string; destination: string; reason: string | null }[];
  /** In-flight per-capture archive runs (S2-1: 202 + progress poll). One
   *  `running` read, then the run completes — which is when the server
   *  removes the source and the list loses the capture, exactly like the
   *  real registry. */
  captureArchiveRuns: Record<
    string,
    { destination: string; source: string; reason: string | null; reads: number }
  >;
  // ---- the dataset archive run (§6.x) ------------------------------------
  /** The run `GET /datasets/{id}/archive` serves; null = derived from rows. */
  archiveRun: DatasetArchiveProgress | null;
  /** When true, the NEXT progress poll seals the run — dataset archived,
   *  members' bytes gone — modelling a run that finished between polls. */
  sealOnPoll: boolean;
  /** dataset_id of another dataset already holding the archive destination, or
   *  null. The store claims a folder against the dataset ROW (§6.x), so this
   *  refusal is not something clearing the folder can fix. */
  archiveClaimedBy: string | null;
  /** When true, every POST /jobs is lost on the way out — a rejected fetch,
   *  as a dead connection produces, not an error response. */
  jobsUnreachable: boolean;
  datasetArchiveCalls: {
    datasetId: string;
    destination: string | null;
    mode: string | null;
  }[];
  calls: string[];
}

function capture(over: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    capture_id: over.capture_id ?? 'cap-1',
    state: over.state ?? 'completed',
    review_status: over.review_status ?? 'pending',
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

function withMemberships(backend: Backend, c: CaptureListItem): CaptureListItem {
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
  const createGate: { release: (() => void) | null } = { release: null };
  const backend: Backend = {
    // Copied, never adopted: the handlers mutate rows in place (a PATCH
    // renames, an archive seal flips status), and a shared module-level
    // fixture would leak one test's mutations into the next.
    datasets: (seed.datasets ?? []).map((d) => ({ ...d })),
    members: (seed.members ?? []).map((m) => ({ ...m })),
    captures: seed.captures ?? [],
    highWater: seed.highWater ?? {},
    transferAvailable: seed.transferAvailable ?? false,
    archiveRoots: seed.archiveRoots ?? [],
    archiveVerifies: seed.archiveVerifies ?? true,
    capturesNeverEnd: seed.capturesNeverEnd ?? false,
    archiveDestinationNotEmpty: seed.archiveDestinationNotEmpty ?? false,
    holdCreate: seed.holdCreate ?? false,
    releaseCreate: () => {
      createGate.release?.();
      createGate.release = null;
    },
    archived: [],
    captureArchiveRuns: {},
    archiveRun: seed.archiveRun ?? null,
    sealOnPoll: seed.sealOnPoll ?? false,
    archiveClaimedBy: seed.archiveClaimedBy ?? null,
    jobsUnreachable: seed.jobsUnreachable ?? false,
    datasetArchiveCalls: [],
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

    if (method === 'POST' && path === '/jobs' && backend.jobsUnreachable) {
      throw new TypeError('Failed to fetch');
    }

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

    // ---- the dataset archive run (§6.x) ----------------------------------
    const datasetArchiveMatch = path.match(/^\/datasets\/([^/]+)\/archive$/);
    if (datasetArchiveMatch) {
      const datasetId = decodeURIComponent(datasetArchiveMatch[1]!);
      const dataset = backend.datasets.find((d) => d.dataset_id === datasetId);
      if (!dataset) {
        return jsonResponse(
          { error: { code: 'dataset_not_found', message: 'gone' } },
          404,
        );
      }
      const memberIds = backend.members
        .filter((m) => m.dataset_id === datasetId)
        .map((m) => m.capture_id);
      const seal = () => {
        dataset.status = 'archived';
        dataset.archived_at = '2026-07-22T09:00:00Z';
        // A copy seals the record and takes nothing; only a move removes.
        if (dataset.archive_mode !== 'copy') {
          backend.captures = backend.captures.filter(
            (c) => !memberIds.includes(c.capture_id),
          );
        }
        backend.archiveRun = {
          dataset_id: datasetId,
          status: 'archived',
          destination: dataset.archive_destination ?? null,
          mode: dataset.archive_mode ?? 'move',
          member_total: memberIds.length,
          members_done: memberIds.length,
          running: false,
          error: null,
          archived_at: dataset.archived_at,
        };
      };
      if (method === 'POST') {
        backend.datasetArchiveCalls.push({
          datasetId,
          destination: (body.destination as string | null | undefined) ?? null,
          mode: (body.mode as string | null | undefined) ?? null,
        });
        // Someone else's folder. The real check runs inside the claiming
        // transaction (store.py begin_dataset_archive) and answers with the
        // holder's dataset_id, because the name in the message can be renamed
        // out from under a bug report.
        if (backend.archiveClaimedBy && body.destination) {
          const holder = backend.datasets.find(
            (d) => d.dataset_id === backend.archiveClaimedBy,
          );
          return jsonResponse(
            {
              error: {
                code: 'destination_claimed',
                message:
                  `${body.destination}/${body.path} belongs to dataset ` +
                  `${holder?.name ?? backend.archiveClaimedBy}, which is ` +
                  `${holder?.status ?? 'archiving'} there. Two datasets in one ` +
                  'folder would interleave their numbers under a single ' +
                  'manifest; choose another path.',
                details: {
                  dataset_id: datasetId,
                  destination: `${body.destination}/${body.path}`,
                  held_by: backend.archiveClaimedBy,
                },
              },
            },
            409,
          );
        }
        if (dataset.status === 'archiving') {
          // A resume: the fake finishes the run on the spot — the claim under
          // test is that the UI re-POSTS with no destination and follows the
          // run to its seal, not how long the copy takes.
          seal();
          return jsonResponse({ ...backend.archiveRun, status: 'archiving' }, 202);
        }
        // The server owns the shape: <destination>/<operator>/<task>/<name>.
        dataset.status = 'archiving';
        dataset.archive_mode = (body.mode as string | undefined) ?? 'move';
        dataset.archive_destination = `${body.destination}/${dataset.operator ?? 'unknown_operator'}/${dataset.task ?? 'unknown_task'}/${dataset.name}`;
        backend.archiveRun = {
          dataset_id: datasetId,
          status: 'archiving',
          destination: dataset.archive_destination,
          mode: dataset.archive_mode,
          member_total: memberIds.length,
          members_done: 0,
          running: true,
          error: null,
        };
        return jsonResponse(backend.archiveRun, 202);
      }
      if (backend.sealOnPoll && dataset.status === 'archiving') seal();
      return jsonResponse(
        backend.archiveRun ?? {
          dataset_id: datasetId,
          status: dataset.status,
          destination: dataset.archive_destination ?? null,
          member_total: memberIds.length,
          members_done: 0,
          running: false,
          error: null,
        },
      );
    }

    const datasetMatch = path.match(/^\/datasets\/([^/]+)$/);
    if (datasetMatch) {
      const datasetId = decodeURIComponent(datasetMatch[1]!);
      if (method === 'PATCH') {
        const found = backend.datasets.find((d) => d.dataset_id === datasetId);
        if (!found) {
          return jsonResponse(
            { error: { code: 'dataset_not_found', message: 'gone' } },
            404,
          );
        }
        // The real service freezes labels with the member set (§6.1).
        if (found.status !== 'active') {
          return jsonResponse(
            { error: { code: 'dataset_not_active', message: 'frozen' } },
            409,
          );
        }
        if (typeof body.name === 'string' && body.name) found.name = body.name;
        if ('operator' in body) found.operator = body.operator as string | null;
        if ('task' in body) found.task = body.task as string | null;
        return jsonResponse(datasetOut(found));
      }
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
        if (backend.holdCreate) {
          await new Promise<void>((resolve) => {
            createGate.release = resolve;
          });
        }
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
      // The folder already holds files. The copy has not started, so nothing
      // was archived and the capture stays exactly where it is.
      if (backend.archiveDestinationNotEmpty) {
        return jsonResponse(
          {
            error: {
              code: 'destination_not_empty',
              message:
                `${destination}/${captureId} already contains files — ` +
                'refusing to archive into it. Choose another path, or clear ' +
                'it if it is the debris of a failed archive.',
              details: { capture_id: captureId, destination: `${destination}/${captureId}` },
            },
          },
          409,
        );
      }
      // 202-accepted (S2-1): the copy runs server-side; the client polls.
      backend.captureArchiveRuns[captureId] = {
        destination: `${destination}/${captureId}`,
        source: destination,
        reason: (body.reason as string | null) ?? null,
        reads: 0,
      };
      return jsonResponse(
        {
          capture_id: captureId,
          destination: `${destination}/${captureId}`,
          state: 'running',
        },
        202,
      );
    }
    if (archiveMatch && method === 'GET') {
      const captureId = decodeURIComponent(archiveMatch[1]!);
      const run = backend.captureArchiveRuns[captureId];
      if (!run) {
        return jsonResponse(
          { error: { code: 'archive_not_found', message: 'no run' } },
          404,
        );
      }
      run.reads += 1;
      if (run.reads <= 1) {
        return jsonResponse({
          capture_id: captureId,
          destination: run.destination,
          state: 'running',
          bytes_done: 600_000_000,
          bytes_total: 1_200_000_000,
          error: null,
          result: null,
        });
      }
      // The run completed: this is the moment the server has removed the
      // source, so the list loses the capture NOW, not at the POST. A failed
      // verification never gets here — the source stays.
      if (backend.archiveVerifies && !backend.archived.some((a) => a.captureId === captureId)) {
        backend.archived.push({
          captureId,
          destination: run.source,
          reason: run.reason,
        });
        backend.captures = backend.captures.filter(
          (c) => c.capture_id !== captureId,
        );
      }
      return jsonResponse({
        capture_id: captureId,
        destination: run.destination,
        // Verification is not optional on this path: a hash mismatch fails
        // the RUN before the source is deleted, so "did not verify" is a
        // failed state — never a completed result with a flag on it.
        state: backend.archiveVerifies ? 'complete' : 'failed',
        bytes_done: 1_200_000_000,
        bytes_total: 1_200_000_000,
        error: backend.archiveVerifies
          ? null
          : {
              code: 'verification_failed',
              message:
                `${captureId} did not verify against its source; the source ` +
                'was NOT deleted.',
            },
        result: backend.archiveVerifies
          ? {
              capture_id: captureId,
              destination: run.destination,
              bytes: 1_200_000_000,
              file_count: 3,
              files: [],
            }
          : null,
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
        next_cursor: backend.capturesNeverEnd ? 'more' : null,
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
  // The archive watch is a real wall-clock poll (S2-1); run it fast here.
  __setCaptureArchivePollMs(5);
});
afterEach(() => {
  __resetCaptureArchivePollMs();
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
  // Blocked rows are folded by default now; the claim under test is the
  // per-row reason, so reveal them first — the toggle states the count.
  fireEvent.click(await screen.findByTestId('dataset-candidates-blocked-toggle'));

  for (const id of ['cap-a', 'cap-b', 'cap-adopted-away', 'cap-away']) {
    expect(await screen.findByTestId(`dataset-candidate-${id}`)).toBeInTheDocument();
  }

  // The row identifies the DATA, not just the directory: a run_id alone
  // cannot answer "which recording is this?" (2026-08-03 feedback).
  expect(screen.getByTestId('dataset-candidate-facts-cap-a')).toHaveTextContent(
    'pick_place · op_a · 00:01:00 · 1.2 GB',
  );

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
  fireEvent.click(screen.getByTestId('discard-reason-other'));
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
  // No whole-catalog scope any more: with nothing selected the center asks
  // for a selection instead of blending every dataset's numbering.
  await waitFor(() =>
    expect(screen.getByTestId('dataset-none-selected')).toBeInTheDocument(),
  );
});

// E-27's other half. `listAllCaptures` follows the cursor for at most 50 pages
// x 200 and then stops, returning what it has WITH the unfinished cursor —
// honest in the client, and silent on screen. An operator reads the rail,
// sees the recordings end, and concludes that is the catalog. That is the same
// family as "12 / 12 at expected" and "5 cameras OK": a confident answer that
// is wrong. No backend change is needed to say so — the signal is already in
// the response the screen throws away.
test('a catalog too large to sweep says so instead of ending quietly', { timeout: 20000 }, async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    capturesNeverEnd: true,
  });
  renderWithClient(<DatasetsScreen />);

  const note = await screen.findByTestId('catalog-truncated', undefined, { timeout: 10000 });
  expect(note).toHaveTextContent(/not the whole catalog|more recordings than/i);
  // It says what to do about it rather than only that something is wrong.
  expect(note).toHaveTextContent(/search/i);
});

test('a catalog that fits reports nothing — the note is not decoration', async () => {
  mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A, CAP_B] });
  renderWithClient(<DatasetsScreen />);

  await screen.findByTestId('dataset-candidate-cap-a');
  expect(screen.queryByTestId('catalog-truncated')).not.toBeInTheDocument();
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

test('a per-capture archive refused for a full destination says what to do about it', async () => {
  // Parity with the dataset archive dialog: `<ErrorMessage>` alone gives the
  // server's sentence and the raw code, and neither says what an operator
  // should do next. Two archive dialogs that report a refusal differently is
  // the kind of asymmetry only an operator finds, and only at the worst moment.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    archiveRoots: ['/mnt/archive'],
    archiveDestinationNotEmpty: true,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('dataset-archive-cap-a'));
  fireEvent.click(await screen.findByTestId('archive-confirm'));

  const dialog = await screen.findByTestId('archive-dialog');
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'destination_not_empty');
  expect(alert).toHaveTextContent('already contains files');

  const guidance = within(dialog).getByTestId('archive-error-guidance');
  // The server offered two ways out — another path, or clearing the debris —
  // and guidance that repeats only the first silently withdraws the second.
  expect(guidance).toHaveTextContent(/empty path/i);
  expect(guidance).toHaveTextContent(/clear/i);
  // The same code serves the dataset archive, where what would be mixed is
  // datasets, so the wording may not say "captures" on either surface.
  expect(guidance.textContent).not.toMatch(/captures/i);
  // Nothing to tie here: this refusal names no holding dataset.
  expect(within(dialog).queryByTestId('archive-error-holder')).not.toBeInTheDocument();

  // The copy never started, so the recording is untouched — which is the whole
  // reason this refusal is a warning and not a loss.
  expect(backend.archived).toHaveLength(0);
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a']);
});

test('a copy that did not verify is reported as a failed run, never as archived', async () => {
  // A completed archive IS the verification claim: the server compares every
  // file's hash as it lands and a mismatch fails the RUN before the source is
  // deleted (there is no "copied but unverified" response any more — the old
  // always-True `verified` flag and its unreachable warning branch are gone).
  // What the operator must never read as success is therefore a failed run.
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    archiveRoots: ['/mnt/archive'],
    archiveVerifies: false,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('dataset-archive-cap-a'));
  fireEvent.click(await screen.findByTestId('archive-confirm'));

  await screen.findByText(/did not verify/i);
  expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
});

// ---- dataset archive (§6.x): the terminal transition ----------------------

/** A kitchen dataset that already left: sealed, destination on record. */
const DS_SEALED: Dataset = {
  ...DS_KITCHEN,
  dataset_id: 'ds-sealed',
  name: 'sealed picks',
  status: 'archived',
  archive_destination: '/mnt/archive/exports/op_a/pick_place/sealed picks',
  archive_started_at: '2026-07-22T08:30:00Z',
  archived_at: '2026-07-22T09:00:00Z',
};

test('archiving a dataset: confirm echoes the final path, the run seals, the row says archived', async () => {
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    archiveRoots: ['/mnt/archive'],
    sealOnPoll: true,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));

  // Both paths are echoed: what is sent, and where the dataset actually lands
  // — the server appends <operator>/<task>/<name> itself.
  expect(await screen.findByTestId('dataset-archive-destination')).toHaveTextContent(
    '/mnt/archive',
  );
  expect(screen.getByTestId('dataset-archive-final-path')).toHaveTextContent(
    '/mnt/archive/op_a/pick_place/kitchen picks',
  );

  fireEvent.click(screen.getByTestId('dataset-archive-confirm'));

  // The 202 started a server-side run; the poll follows it to the seal.
  const toast = await screen.findByTestId('toast', undefined, { timeout: 5000 });
  expect(toast).toHaveTextContent(/2 recordings verified, then removed/);
  expect(backend.datasetArchiveCalls[0]).toEqual({
    datasetId: 'ds-kitchen',
    destination: '/mnt/archive',
    mode: 'move',
  });
  // Sealed, the dataset moves off the working shelf into the Archived view.
  await waitFor(() => {
    expect(screen.queryByTestId(datasetTestId('ds-kitchen'))).not.toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('dataset-view-archived'));
  await waitFor(() => {
    expect(screen.getByTestId('dataset-status-ds-kitchen')).toHaveTextContent('archived');
  });
  fireEvent.click(screen.getByTestId(datasetTestId('ds-kitchen')));
  expect(await screen.findByTestId('dataset-archived-banner')).toHaveTextContent(
    /read-only/,
  );
});

test('an archived dataset is read-only: no build, no removal, delete refused with the reason', async () => {
  mockApi({
    datasets: [DS_SEALED],
    captures: [],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-sealed', capture_id: 'cap-gone', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
  });
  renderWithClient(<DatasetsScreen />);

  // Sealed sets live under their own view; the working list no longer mixes
  // history into building.
  fireEvent.click(await screen.findByTestId('dataset-view-archived'));
  fireEvent.click(await screen.findByTestId(datasetTestId('ds-sealed')));

  // The state is part of the row's identity and the header's.
  expect(screen.getByTestId('dataset-status-ds-sealed')).toHaveTextContent('archived');
  expect(await screen.findByTestId('dataset-scope-status')).toHaveTextContent('archived');
  const banner = await screen.findByTestId('dataset-archived-banner');
  expect(banner).toHaveTextContent('/mnt/archive/exports/op_a/pick_place/sealed picks');

  // No new members, no new run, and the record itself is kept.
  expect(await screen.findByTestId('build-target-frozen')).toBeInTheDocument();
  expect(screen.queryByTestId('archive-dataset-btn')).not.toBeInTheDocument();
  expect(screen.getByTestId('delete-dataset-btn')).toBeDisabled();

  // A member of the sealed set gets no departure controls — the membership is
  // the record of what number the recording was.
  fireEvent.click(memberRowFor('cap-gone'));
  expect(await screen.findByTestId('dataset-member-frozen-note')).toBeInTheDocument();
  expect(screen.queryByTestId('remove-member-btn')).not.toBeInTheDocument();
});

test('a destination another dataset holds is refused with the reason AND the way out', async () => {
  // §6.x claims a destination against the dataset ROW, so this is the one
  // archive refusal an operator cannot clear by emptying the folder or by
  // waiting for the other run — and the server's sentence says neither. The
  // dialog has to carry the next step, or the operator retries the same path.
  const DS_SHELF: Dataset = {
    ...DS_KITCHEN,
    dataset_id: 'ds-shelf',
    name: 'shelf picks',
    status: 'archiving',
  };
  const backend = mockApi({
    datasets: [DS_KITCHEN, DS_SHELF],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
    archiveClaimedBy: 'ds-shelf',
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));
  fireEvent.click(await screen.findByTestId('dataset-archive-confirm'));

  const dialog = await screen.findByTestId('dataset-archive-dialog');
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveAttribute('data-error-code', 'destination_claimed');
  expect(alert).toHaveTextContent('belongs to dataset shelf picks');

  // The alert above names the holder "shelf picks"; the envelope carries only
  // `ds-shelf`. Shown adjacent and unlabelled those read as two different
  // datasets, so the dialog joins them into one identity — the name to
  // recognise it by, the id that survives a rename.
  const holder = within(dialog).getByTestId('dataset-archive-error-holder');
  expect(holder).toHaveTextContent('shelf picks (ds-shelf)');

  // The next step, which the server cannot know it needs to say.
  const guidance = within(dialog).getByTestId('dataset-archive-error-guidance');
  expect(guidance).toHaveTextContent(/emptying the folder does not release it/i);
  expect(guidance).toHaveTextContent(/neither does that dataset finishing its run/i);
  // Clearing the folder is a real fix for a FULL destination and a useless,
  // destructive one here; the two must never read the same.
  expect(guidance.textContent).not.toMatch(/\bclear\b/i);

  // Nothing started: the dataset is still active, still on the working shelf,
  // and one request was sent — the refusal is not retried behind the operator.
  expect(backend.datasets.find((d) => d.dataset_id === 'ds-kitchen')!.status).toBe(
    'active',
  );
  expect(screen.getByTestId(datasetTestId('ds-kitchen'))).toBeInTheDocument();
  expect(backend.datasetArchiveCalls).toHaveLength(1);
});

test('a claimed destination whose holder is not in the loaded catalog shows the bare id', async () => {
  // The join is best-effort by construction: `held_by` is resolved against the
  // catalog this screen happens to hold, and a list that has not caught up (or
  // a holder created since the last fetch) has no row to resolve. The fallback
  // is the id ALONE — never a name-shaped blank like " (ds-…)", which would
  // read as a dataset whose name is empty rather than one we cannot name.
  const backend = mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
    archiveClaimedBy: 'ds-not-in-this-list',
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));
  fireEvent.click(await screen.findByTestId('dataset-archive-confirm'));

  const dialog = await screen.findByTestId('dataset-archive-dialog');
  const holder = await within(dialog).findByTestId('dataset-archive-error-holder');
  expect(holder).toHaveTextContent('ds-not-in-this-list');
  // No parenthesised second label at all: nothing was invented to fill it.
  expect(holder.textContent).not.toMatch(/[()]/);
  expect(holder.textContent).not.toMatch(/undefined|null/);
  // The refusal itself still lands, and no run started.
  expect(within(dialog).getByRole('alert')).toHaveAttribute(
    'data-error-code',
    'destination_claimed',
  );
  expect(backend.datasets.find((d) => d.dataset_id === 'ds-kitchen')!.status).toBe(
    'active',
  );
});

test('a halted run carries the next step, not just the sentence it stopped on', async () => {
  // The runner's halt arrives as a plain {code, message} inside the progress
  // payload — no ApiError — so the dialog could reach the server's sentence but
  // not the catalog's guidance. On `ledger_unreadable` that difference is the
  // whole outcome: the run is SITTING halted, Resume is right there, and
  // pressing it changes nothing until a human repairs a file.
  mockApi({
    datasets: [
      {
        ...DS_KITCHEN,
        status: 'archiving',
        archive_destination: '/mnt/archive/op_a/pick_place/kitchen picks',
        archive_started_at: '2026-07-22T08:30:00Z',
      },
    ],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
    archiveRun: {
      dataset_id: 'ds-kitchen',
      status: 'archiving',
      destination: '/mnt/archive/op_a/pick_place/kitchen picks',
      member_total: 2,
      members_done: 1,
      running: false,
      error: {
        code: 'ledger_unreadable',
        message:
          'The lifecycle ledger could not be read: invalid JSON on line 812. ' +
          'The run stopped where it stands rather than act on a history it cannot see.',
      },
    },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));

  const halt = await screen.findByTestId('dataset-archive-halt', undefined, { timeout: 5000 });
  expect(halt).toHaveTextContent('invalid JSON on line 812');
  // The part the server's sentence does not carry: what has to happen.
  const guidance = within(halt).getByTestId('dataset-archive-halt-guidance');
  expect(guidance).toHaveTextContent(/repair or restore/i);
  expect(guidance.textContent).not.toMatch(/try again|in a moment|shortly/i);
});

test('a halt whose code the catalog does not know shows the sentence and no invented advice', async () => {
  mockApi({
    datasets: [
      { ...DS_KITCHEN, status: 'archiving', archive_destination: '/mnt/archive/x' },
    ],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
    archiveRun: {
      dataset_id: 'ds-kitchen',
      status: 'archiving',
      destination: '/mnt/archive/x',
      member_total: 2,
      members_done: 1,
      running: false,
      error: { code: 'some_future_runner_code', message: 'The run stopped: disk went away.' },
    },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));

  const halt = await screen.findByTestId('dataset-archive-halt', undefined, { timeout: 5000 });
  expect(halt).toHaveTextContent('disk went away');
  expect(within(halt).queryByTestId('dataset-archive-halt-guidance')).not.toBeInTheDocument();
});

test('a halted run reports why, stays archiving, and Resume continues it without a destination', async () => {
  const backend = mockApi({
    datasets: [
      {
        ...DS_KITCHEN,
        status: 'archiving',
        archive_destination: '/mnt/archive/op_a/pick_place/kitchen picks',
        archive_started_at: '2026-07-22T08:30:00Z',
      },
    ],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    archiveRoots: ['/mnt/archive'],
    archiveRun: {
      dataset_id: 'ds-kitchen',
      status: 'archiving',
      destination: '/mnt/archive/op_a/pick_place/kitchen picks',
      member_total: 2,
      members_done: 1,
      running: false,
      error: { capture_id: 'cap-b', code: 'capture_busy', message: 'A job holds this capture.' },
    },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  expect(screen.getByTestId('dataset-status-ds-kitchen')).toHaveTextContent('archiving');

  // The header offers the run, not a second archive.
  const button = await screen.findByTestId('archive-dataset-btn');
  expect(button).toHaveTextContent('Archive run…');
  fireEvent.click(button);

  // The halt says what stopped it and that nothing rolled back.
  const halt = await screen.findByTestId('dataset-archive-halt', undefined, {
    timeout: 5000,
  });
  expect(halt).toHaveTextContent('A job holds this capture.');
  expect(screen.getByTestId('dataset-archive-progress-count')).toHaveTextContent('1 / 2');

  fireEvent.click(screen.getByTestId('dataset-archive-resume'));

  // Resume re-POSTs with NO destination: the run continues to the destination
  // its ledger event froze, and a different one is a different archive.
  await waitFor(() => expect(backend.datasetArchiveCalls).toHaveLength(1));
  expect(backend.datasetArchiveCalls[0]).toEqual({
    datasetId: 'ds-kitchen',
    destination: null,
    // Resume names neither destination nor mode: the run the ledger froze is
    // the run that continues.
    mode: null,
  });
  const toast = await screen.findByTestId('toast', undefined, { timeout: 5000 });
  expect(toast).toHaveTextContent(/verified, then removed/);
});

// ---- label edits (identity is dataset_id; names move) ----------------------

test('editing the labels renames the dataset without touching its members', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('edit-dataset-btn'));

  const name = await screen.findByTestId('edit-dataset-name');
  fireEvent.change(name, { target: { value: 'kitchen picks v2' } });
  // Clearing operator is a statement, not an omission — several people may
  // have recorded the members, and each recording keeps its own operator.
  fireEvent.change(screen.getByTestId('edit-dataset-operator'), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByTestId('edit-dataset-submit'));

  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent(/same dataset, same members, same numbers/);
  const row = await screen.findByTestId(datasetTestId('ds-kitchen'));
  await waitFor(() => expect(within(row).getByText('kitchen picks v2')).toBeInTheDocument());
  // Same identity, same membership — only the labels moved.
  expect(within(row).getByText('1 member')).toBeInTheDocument();
});

test('an archived dataset offers no label editing', async () => {
  mockApi({ datasets: [DS_SEALED], captures: [] });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('dataset-view-archived'));
  fireEvent.click(await screen.findByTestId(datasetTestId('ds-sealed')));
  await screen.findByTestId('dataset-archived-banner');
  expect(screen.queryByTestId('edit-dataset-btn')).not.toBeInTheDocument();
});

// ---- combining datasets ----------------------------------------------------

test('combining datasets builds a third; the sources and shared members are handled honestly', async () => {
  const DS_B: Dataset = {
    ...DS_KITCHEN,
    dataset_id: 'ds-b',
    name: 'shelf picks',
    member_count: 0,
  };
  const backend = mockApi({
    datasets: [DS_KITCHEN, DS_B],
    captures: [CAP_A, CAP_B, CAP_AWAY],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
      // cap-b is in BOTH sources: it must join the new set exactly once.
      { membership_id: 'm-3', dataset_id: 'ds-b', capture_id: 'cap-b', display_index: 1 },
      { membership_id: 'm-4', dataset_id: 'ds-b', capture_id: 'cap-away', display_index: 2 },
    ],
    highWater: { 'ds-kitchen': 3, 'ds-b': 3 },
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId('combine-datasets-btn'));
  const dialog = await screen.findByTestId('combine-datasets-dialog');
  fireEvent.change(screen.getByTestId('combine-datasets-name'), {
    target: { value: 'all picks' },
  });
  // findBy: the dialog opens on first paint, possibly before the dataset
  // list has resolved into choices.
  fireEvent.click(await within(dialog).findByTestId('combine-source-ds-kitchen'));
  fireEvent.click(within(dialog).getByTestId('combine-source-ds-b'));
  fireEvent.click(screen.getByTestId('combine-datasets-submit'));

  const toast = await screen.findByTestId('toast');
  expect(toast).toHaveTextContent(/Combined 3 recordings/);
  expect(toast).toHaveTextContent(/source datasets are untouched/);

  // The new dataset lists the union (shared member once), and the sources
  // kept every membership they had.
  const combined = backend.datasets.find((d) => d.name === 'all picks')!;
  const newMembers = backend.members.filter((m) => m.dataset_id === combined.dataset_id);
  expect(newMembers.map((m) => m.capture_id)).toEqual(['cap-a', 'cap-b', 'cap-away']);
  expect(
    backend.members.filter((m) => m.dataset_id === 'ds-kitchen'),
  ).toHaveLength(2);
  expect(backend.members.filter((m) => m.dataset_id === 'ds-b')).toHaveLength(2);
});

test('a combined set defaults to Copy out, and the seal takes nothing with it', async () => {
  const DS_SOURCE: Dataset = {
    ...DS_KITCHEN,
    dataset_id: 'ds-source',
    name: 'source picks',
    member_count: 0,
  };
  const backend = mockApi({
    datasets: [DS_KITCHEN, DS_SOURCE],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
      // cap-a is shared with an ACTIVE dataset — a Move would refuse it.
      { membership_id: 'm-3', dataset_id: 'ds-source', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
    sealOnPoll: true,
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));

  // Shared members make Copy the default, and the dialog says why.
  const copyRadio = await screen.findByTestId('dataset-archive-mode-copy');
  expect(copyRadio).toBeChecked();
  expect(screen.getByTestId('dataset-archive-shared-note')).toHaveTextContent(
    /1 member also belong/,
  );
  expect(screen.getByTestId('dataset-archive-confirm')).toHaveTextContent(
    'Copy, verify, then seal',
  );

  fireEvent.click(screen.getByTestId('dataset-archive-confirm'));

  const toast = await screen.findByTestId('toast', undefined, { timeout: 5000 });
  expect(toast).toHaveTextContent(/verified and sealed/);
  expect(backend.datasetArchiveCalls[0]!.mode).toBe('copy');
  // The seal took nothing: both recordings still in the catalog, the sharing
  // dataset intact, and the banner says the recordings stayed.
  expect(backend.captures.map((c) => c.capture_id)).toEqual(['cap-a', 'cap-b']);
  expect(backend.members.filter((m) => m.dataset_id === 'ds-source')).toHaveLength(1);
  fireEvent.click(screen.getByTestId('dataset-view-archived'));
  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  await waitFor(() => {
    expect(screen.getByTestId('dataset-archived-banner')).toHaveTextContent(/Copied to/);
  });
  expect(screen.getByTestId('dataset-archived-banner')).toHaveTextContent(
    /stays on this machine/,
  );
});

// The archive prefill mirrors `views.sanitize_component` so the operator is
// shown the path the server will actually create. A mirror only helps while it
// matches: views.py now scrubs the whole C0 range plus DEL
// (`[/\\\x00-\x1f\x7f]`, added because a folder whose name holds a newline or a
// tab breaks every reader of this tree that is not this program — a file
// manager, a glob, a listing piped into `while read`), and the copy here still
// only scrubbed `/`, `\` and NUL.
//
// The consequence is small and specific, which is why it is worth pinning: the
// server is not relying on this (the archive path is scrubbed server-side and
// has its own test), so nothing breaks — the prefill just promises a path the
// server will spell differently, and the operator only finds out afterwards.
test('the archive prefill scrubs the same characters the server does', async () => {
  mockApi({
    datasets: [
      {
        ...DS_KITCHEN,
        // One from each half of the drift: a newline (C0) and DEL.
        operator: 'op\na',
        name: 'kitchen\x7fpicks',
      },
    ],
    captures: [CAP_A],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
    ],
    archiveRoots: ['/mnt/archive'],
  });
  renderWithClient(<DatasetsScreen />);

  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));
  fireEvent.click(await screen.findByTestId('archive-dataset-btn'));

  const finalPath = await screen.findByTestId('dataset-archive-final-path');
  // Control: the component with nothing to scrub comes through verbatim, so
  // this is a scrub and not a blanket rewrite.
  expect(finalPath).toHaveTextContent('pick_place');
  // The claims. Before the mirror was fixed this read
  // `/mnt/archive/op a/pick_place/kitchenpicks` — note that the operator could
  // not SEE the problem: the newline renders as a space and DEL as nothing, so
  // the prefill quietly promised a path the server would spell differently.
  expect(finalPath).toHaveTextContent('op_a');
  expect(finalPath).toHaveTextContent('kitchen_picks');
  // And nothing raw survives into the path the operator is shown.
  // eslint-disable-next-line no-control-regex -- asserting their ABSENCE.
  expect(finalPath.textContent ?? '').not.toMatch(/[\x00-\x1f\x7f]/);
});

// ---- accessible names, and the create form's dismissal (#10) --------------
//
// Every one of these controls used to carry its purpose in a placeholder only,
// which the accessibility tree does not read as a name — the screen offered a
// keyboard operator half a dozen unlabelled "edit" fields and an unlabelled
// combo box. The queries below go through the accessible name deliberately: a
// `data-testid` would still pass with every label stripped back off.

test('the list toolbar names its search field and its operator filter', async () => {
  mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A, CAP_B] });
  renderWithClient(<DatasetsScreen />);

  await screen.findByTestId(datasetTestId('ds-kitchen'));
  expect(screen.getByRole('searchbox', { name: 'Search datasets' })).toBe(
    screen.getByTestId('dataset-search'),
  );
  expect(
    screen.getByRole('combobox', { name: 'Filter datasets by operator' }),
  ).toBe(screen.getByTestId('dataset-operator-filter'));
});

test('the member search and the candidate search are named too', async () => {
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
  expect(
    screen.getByRole('searchbox', { name: 'Search members of this dataset' }),
  ).toBe(screen.getByTestId('dataset-member-search'));
  // The build rail's own search — same defect, same screen.
  expect(screen.getByRole('searchbox', { name: 'Search recordings to add' })).toBe(
    screen.getByTestId('dataset-candidate-search'),
  );
});

test('the combine dialog names the fields of the dataset it builds', async () => {
  mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);

  await screen.findByTestId(datasetTestId('ds-kitchen'));
  fireEvent.click(screen.getByTestId('combine-datasets-btn'));

  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByLabelText('New dataset operator (optional)'),
  ).toBe(screen.getByTestId('combine-datasets-operator'));
  expect(within(dialog).getByLabelText('New dataset task (optional)')).toBe(
    screen.getByTestId('combine-datasets-task'),
  );
});

test('the create form is a named form landmark whose three fields are named', async () => {
  mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  const form = screen.getByRole('form', { name: 'New dataset' });
  expect(form).toBe(screen.getByTestId('new-dataset-form'));
  // Not a dialog: it has no overlay, traps no focus, and leaves the list beside
  // it live — and `role="dialog"` is not a role a <form> may carry anyway. The
  // absence is the assertion; a role put back here would be both claims wrong.
  expect(form).not.toHaveAttribute('role');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  expect(within(form).getByLabelText('Dataset name')).toBe(
    screen.getByTestId('new-dataset-name'),
  );
  expect(within(form).getByLabelText('Operator (optional)')).toBe(
    screen.getByTestId('new-dataset-operator'),
  );
  expect(within(form).getByLabelText('Task (optional)')).toBe(
    screen.getByTestId('new-dataset-task'),
  );
});

test('Escape closes the create form without creating, and hands the cursor back', async () => {
  const backend = mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  // A typed-in name is the case that matters: Escape must dismiss, not submit.
  fireEvent.change(screen.getByTestId('new-dataset-name'), {
    target: { value: 'shelf restock' },
  });
  fireEvent.keyDown(screen.getByTestId('new-dataset-form'), { key: 'Escape' });

  await waitFor(() =>
    expect(screen.queryByTestId('new-dataset-form')).not.toBeInTheDocument(),
  );
  expect(backend.calls.filter((c) => c === 'POST /datasets')).toHaveLength(0);
  expect(backend.datasets).toHaveLength(0);
  // The field the cursor was in has just unmounted. Without the restore it
  // falls to <body> and the next Tab restarts at the top of the document.
  expect(screen.getByTestId('new-dataset-btn')).toHaveFocus();
});

test('Cancel hands the cursor back the same way, and discards what was typed', async () => {
  mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  fireEvent.change(screen.getByTestId('new-dataset-name'), {
    target: { value: 'shelf restock' },
  });
  fireEvent.click(screen.getByTestId('new-dataset-cancel'));

  await waitFor(() =>
    expect(screen.queryByTestId('new-dataset-form')).not.toBeInTheDocument(),
  );
  expect(screen.getByTestId('new-dataset-btn')).toHaveFocus();
  // Reopening gives an empty form, not the abandoned attempt — which is also
  // what keeps a failed create's error banner from coming back with it.
  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  expect(screen.getByTestId('new-dataset-name')).toHaveValue('');
});

test('Escape is ignored while the create POST is still in flight', async () => {
  const backend = mockApi({ captures: [CAP_A], holdCreate: true });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  fireEvent.change(screen.getByTestId('new-dataset-name'), {
    target: { value: 'shelf restock' },
  });
  fireEvent.click(screen.getByTestId('new-dataset-submit'));
  await waitFor(() =>
    expect(screen.getByTestId('new-dataset-submit')).toHaveTextContent('Creating…'),
  );

  fireEvent.keyDown(screen.getByTestId('new-dataset-form'), { key: 'Escape' });

  // The write is already out. Closing now would only hide the result of
  // something that is going to land regardless — so the form stays, exactly as
  // Cancel stays disabled.
  expect(screen.getByTestId('new-dataset-form')).toBeInTheDocument();
  backend.releaseCreate();
  await waitFor(() => expect(backend.datasets).toHaveLength(1));
});

test('the Escape an IME is closing its candidate window with is not a dismissal', async () => {
  mockApi({ captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId('dataset-list-empty');

  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  // Mid-conversion. This Escape belongs to the IME; taking it as a dismissal
  // throws away both the text being converted and the form around it.
  fireEvent.keyDown(screen.getByTestId('new-dataset-form'), {
    key: 'Escape',
    isComposing: true,
  });

  expect(screen.getByTestId('new-dataset-form')).toBeInTheDocument();
});

test('the form’s Escape does not travel on to a dialog listening on the document', async () => {
  mockApi({ datasets: [DS_KITCHEN], captures: [CAP_A] });
  renderWithClient(<DatasetsScreen />);
  await screen.findByTestId(datasetTestId('ds-kitchen'));

  // Both open at once: the panel is inline, so opening the shared Modal over it
  // does not close it.
  fireEvent.click(screen.getByTestId('new-dataset-btn'));
  fireEvent.click(screen.getByTestId('combine-datasets-btn'));
  await screen.findByRole('dialog');

  fireEvent.keyDown(screen.getByTestId('new-dataset-form'), { key: 'Escape' });

  await waitFor(() =>
    expect(screen.queryByTestId('new-dataset-form')).not.toBeInTheDocument(),
  );
  // The Modal's Escape handler is on the DOCUMENT, which the form's keystroke
  // bubbles through. One press, one dismissal — not two.
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

// M1: the same leak Review had, in the bottom pane. DatasetDetail was rendered
// unkeyed, so selecting another member re-rendered the SAME instance against a
// different recording — and with the capture detail already cached there was no
// loading state to hide it. A failed loss run then kept its note over the wrong
// member, with a Retry aimed at the wrong capture_id.
test('a failed loss run does not follow the operator to the next member', async () => {
  mockApi({
    datasets: [DS_KITCHEN],
    captures: [CAP_A, CAP_B],
    members: [
      { membership_id: 'm-1', dataset_id: 'ds-kitchen', capture_id: 'cap-a', display_index: 1 },
      { membership_id: 'm-2', dataset_id: 'ds-kitchen', capture_id: 'cap-b', display_index: 2 },
    ],
    jobsUnreachable: true,
  });
  renderWithClient(<DatasetsScreen />);
  fireEvent.click(await screen.findByTestId(datasetTestId('ds-kitchen')));

  // Visit member 1 first, so its detail is CACHED — without that, coming back
  // to it would show a loading state and hide the leak behind it.
  fireEvent.click(await screen.findByTestId(memberTestId('m-1')));
  await screen.findByTestId('run-loss-report-btn', undefined, { timeout: 3000 });

  // Fail a loss run on member 2.
  fireEvent.click(screen.getByTestId(memberTestId('m-2')));
  await waitFor(() =>
    expect(screen.getByTestId('dataset-member-number')).toHaveTextContent('#2'),
  );
  fireEvent.click(await screen.findByTestId('run-loss-report-btn', undefined, { timeout: 3000 }));
  const err = await screen.findByTestId('dataset-loss-error');
  expect(err).toHaveAttribute('data-error-code', 'network_unreachable');

  // Back to the cached member 1, which was never asked to do anything.
  fireEvent.click(screen.getByTestId(memberTestId('m-1')));
  await waitFor(() =>
    expect(screen.getByTestId('dataset-member-number')).toHaveTextContent('#1'),
  );
  await screen.findByTestId('run-loss-report-btn', undefined, { timeout: 3000 });

  // No note about an attempt that never touched this recording — and so no
  // Retry that would submit loss_report against the wrong capture.
  expect(screen.queryByTestId('dataset-loss-error')).toBeNull();
  expect(screen.queryByTestId('dataset-loss-error-stale')).toBeNull();
  expect(screen.queryByTestId('dataset-loss-error-retry')).toBeNull();
});

// #14 — heading structure. This screen must title itself exactly once and
// descend one heading level at a time, so a screen-reader user can navigate it
// by heading instead of reading it as one flat run of text.
test('titles itself with a single h1 and skips no heading level', async () => {
  renderWithClient(<DatasetsScreen />);
  await expectScreenHeadingOutline('Datasets');
}, 20000);
