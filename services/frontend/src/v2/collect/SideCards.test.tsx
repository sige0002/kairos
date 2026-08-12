// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import type { SystemInfo } from '../../api/types';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import type { CameraHealth } from './Cameras';
import { BatchStatsCard, CoverageCard, SystemStatusCard } from './SideCards';
import type { BatchMachine, BatchStats } from './useBatchMachine';

const GB = 1e9; // decimal — matches the shared formatBytes convention

// SystemStatusCard reads machine.arming, machine.recorderState and
// machine.liveCaptures; the rest of the (large) BatchMachine is irrelevant here.
function collectMachine(overrides: Partial<BatchMachine> = {}): BatchMachine {
  return {
    phase: 'ready',
    arming: null,
    recorderState: null,
    liveCaptures: null,
    ...overrides,
  } as unknown as BatchMachine;
}

const machine = collectMachine();

function mockSystem(body: SystemInfo) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

function renderCard(m: BatchMachine = machine) {
  return renderWithClient(
    <SystemStatusCard
      machine={m}
      sseStatus="closed"
      monitorBridge={null}
      cameraHealth={{
        streamFailed: false,
        streamsDown: 0,
        streamFault: null,
        streamsNoVideo: 0,
        framesStale: false,
        silentTopics: 0,
        unmonitoredTopics: 0,
        totalCameras: 1,
      }}
    />,
  );
}

// Only the camera facts a test cares about; the rest read "nothing wrong".
function renderCardWithCameras(cameraHealth: Partial<CameraHealth>) {
  return renderWithClient(
    <SystemStatusCard
      machine={machine}
      sseStatus="closed"
      monitorBridge={null}
      cameraHealth={{
        streamFailed: false,
        streamsDown: 0,
        streamFault: null,
        streamsNoVideo: 0,
        framesStale: false,
        silentTopics: 0,
        unmonitoredTopics: 0,
        totalCameras: 0,
        ...cameraHealth,
      }}
    />,
  );
}

/** The Storage row's container div (label + value + chip). */
function storageRow(): HTMLElement {
  return screen.getByText('Storage').parentElement as HTMLElement;
}

/** The Recorder row's container div (label + value + chip). */
function recorderRow(): HTMLElement {
  return screen.getByText('Recorder').parentElement as HTMLElement;
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

  await waitFor(() =>
    expect(within(storageRow()).getByText('300.0 GB free')).toBeInTheDocument(),
  );
  expect(within(storageRow()).getByText('OK')).toBeInTheDocument();
});

test('flags low free space with an amber CHECK chip', async () => {
  mockSystem({
    cpu: { model: 'Test CPU', cores: 8 },
    gpu: null,
    disk: { path: '/data', total_bytes: 500 * GB, free_bytes: 10 * GB },
  });
  renderCard();

  await waitFor(() =>
    expect(within(storageRow()).getByText('10.0 GB free')).toBeInTheDocument(),
  );
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

// ---- Recorder row: an absent live_capture_ids is UNREACHABLE (§10 rev.2.4) --

test('the Recorder row reports a live recording from the recorder state', async () => {
  mockSystem({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null });
  renderCard(
    collectMachine({ recorderState: 'recording', liveCaptures: ['cap-live'] }),
  );

  expect(within(recorderRow()).getByText('recording')).toBeInTheDocument();
  expect(within(recorderRow()).getByText('REC')).toBeInTheDocument();
});

test('a status carrying no live_capture_ids reads as "no answer", never READY', async () => {
  mockSystem({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null });
  // The recorder answered with a state but WITHOUT the definitive live set:
  // §10 rev.2.4 calls that unreachable, not idle. Showing READY here would
  // invite a start while nothing can say what is already running.
  renderCard(collectMachine({ recorderState: 'created', liveCaptures: null }));

  expect(within(recorderRow()).getByText('no answer')).toBeInTheDocument();
  expect(within(recorderRow()).queryByText('READY')).not.toBeInTheDocument();
});

test('an answered-but-empty live set is standby, not "no answer"', async () => {
  mockSystem({ cpu: { model: 'Test CPU', cores: 8 }, gpu: null });
  // `[]` means the recorder answered and nothing is live — a real READY.
  renderCard(collectMachine({ recorderState: 'created', liveCaptures: [] }));

  expect(within(recorderRow()).getByText('standby')).toBeInTheDocument();
  expect(within(recorderRow()).getByText('READY')).toBeInTheDocument();
});

// ---- BatchStatsCard: post-delete divergence footnote ----------------------

function statsMachine(stats: Partial<BatchStats>): BatchMachine {
  const full: BatchStats = {
    nRecorded: 0,
    nGood: 0,
    nReview: 0,
    nTaskFailed: 0,
    nRemaining: 0,
    epNext: 1,
    ...stats,
  };
  return { stats: full } as unknown as BatchMachine;
}

test('BatchStatsCard shows no footnote while recorded matches the on-disk tallies', () => {
  // 4 recorded = 3 good + 1 review: nothing deleted, so no caption.
  renderWithClient(
    <BatchStatsCard machine={statsMachine({ nRecorded: 4, nGood: 3, nReview: 1 })} />,
  );
  expect(screen.queryByTestId('stats-footnote')).toBeNull();
});

test('BatchStatsCard footnote appears once recorded outruns the quality tallies', () => {
  // 5 recorded but only 3 good + 1 review remain on disk (one was deleted in
  // Review): surface the gap honestly.
  renderWithClient(
    <BatchStatsCard machine={statsMachine({ nRecorded: 5, nGood: 3, nReview: 1 })} />,
  );
  const note = screen.getByTestId('stats-footnote');
  expect(note).toBeInTheDocument();
  expect(note).toHaveTextContent(/recorded counts every take/i);
  expect(note).toHaveTextContent(/still on disk/i);
});

// ---------------------------------------------------------------------------
// CoverageCard: per-condition counts for the current task (2026-07-14).
// ---------------------------------------------------------------------------

function coverageMachine(): BatchMachine {
  return {
    project: 'Bin Picking',
    task: 'Bin to Tray',
    condition: 'Bin: full',
  } as unknown as BatchMachine;
}

function mockCoverageFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    // The per-condition SUM is the server's now (E-27: the card used to pull
    // every batch). These rows are what the endpoint returns for the batches
    // below: 3 + 2 for "Bin: full", 4 for "Bin: sparse", and the other task's
    // 9 scoped out server-side by `?task=`.
    if (url.includes('/batches/coverage')) {
      return Promise.resolve(
        jsonResponse({
          task: 'Bin to Tray',
          rows: [
            { condition: 'Bin: full', recorded: 5, is_floor: false },
            { condition: 'Bin: sparse', recorded: 4, is_floor: false },
          ],
        }),
      );
    }
    if (url.includes('/batches')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            // Two batches of the SAME task+condition: recorded counts add up
            // (episodes_recorded is monotone, so exported takes still count).
            {
              batch_id: 'b1',
              task: 'Bin to Tray',
              condition: 'Bin: full',
              episodes_recorded: 3,
              episodes: [],
            },
            {
              batch_id: 'b2',
              task: 'Bin to Tray',
              condition: 'Bin: full',
              episodes_recorded: 2,
              episodes: [],
            },
            // A different condition and a different task: separate row / ignored.
            {
              batch_id: 'b3',
              task: 'Bin to Tray',
              condition: 'Bin: sparse',
              episodes_recorded: 4,
              episodes: [],
            },
            {
              batch_id: 'b4',
              task: 'Other task',
              condition: 'Bin: full',
              episodes_recorded: 9,
              episodes: [],
            },
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

test('CoverageCard sums episodes_recorded per condition for the current task', async () => {
  mockCoverageFetch();
  renderWithClient(<CoverageCard machine={coverageMachine()} />);

  // Wait for the async batches query to land (the row itself renders
  // immediately from the plan's condition list, with zeros).
  await waitFor(() =>
    expect(screen.getByTestId('coverage-row-Bin: full').textContent).toContain('5'),
  );
  // 3 + 2 across two batches of the same task+condition.
  const sparse = screen.getByTestId('coverage-row-Bin: sparse');
  expect(sparse.textContent).toContain('4');
  // The other task's batches never leak into this card.
  expect(screen.queryByText('9')).toBeNull();
});

// A1: the Cameras row was scoped to "main stream", so a silent SUB camera had
// nothing on the screen accounting for it.
test('the Cameras row counts every pane, not just the main stream', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  renderCardWithCameras({
    streamFailed: false,
    framesStale: false,
    silentTopics: 2,
    totalCameras: 4,
  });
  expect(await screen.findByTestId('sys-cameras')).toHaveTextContent(
    '2 of 4 cameras: topic silent',
  );
  expect(screen.getByTestId('sys-cameras')).toHaveTextContent('CHECK');
});

test('all cameras healthy reports the count, not a bare OK', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  renderCardWithCameras({
    streamFailed: false,
    framesStale: false,
    silentTopics: 0,
    totalCameras: 3,
  });
  expect(await screen.findByTestId('sys-cameras')).toHaveTextContent('3 cameras OK');
});

test('no cameras open is stated honestly, not as OK', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  renderCardWithCameras({
    streamFailed: false,
    framesStale: false,
    silentTopics: 0,
    totalCameras: 0,
  });
  expect(await screen.findByTestId('sys-cameras')).toHaveTextContent('none open');
});

// A camera outside the monitored set gets NO answer about its source topic.
// Counting it among the healthy ones is the row asserting something nobody
// measured — the same lie as the tile's confident frame rate, one line up.
test('a camera nobody measures is named, not folded into the OK count', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  renderCardWithCameras({ unmonitoredTopics: 1, totalCameras: 3 });
  const row = await screen.findByTestId('sys-cameras');
  expect(row).toHaveTextContent('2 of 3 cameras OK · 1 not monitored');
  // Not a green OK — two of three is what we can vouch for, and the chip must
  // not certify the third. Gray "—" is this card's established no-claim mark.
  expect(within(row).getByText('—')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('CHECK');
});

test('a silent camera and an unmeasured one are both accounted for', async () => {
  mockSystem({ cpu: { model: null, cores: null }, gpu: null });
  renderCardWithCameras({ silentTopics: 2, unmonitoredTopics: 1, totalCameras: 4 });
  const row = await screen.findByTestId('sys-cameras');
  // The silent ones are the actionable fact and lead; the gap is still stated
  // rather than leaving the reader to assume the other two are fine.
  expect(row).toHaveTextContent('2 of 4 cameras: topic silent · 1 not monitored');
  expect(row).toHaveTextContent('CHECK');
});

// E-37 — 全滅なのに「5 cameras OK」. Each pane negotiates its own WebRTC
// stream, but only the MAIN pane's phase used to reach this card, so a wall of
// black tiles beside one working stream summarised as "5 cameras OK" in green.
test('the Cameras row will not read OK while panes have no video', () => {
  renderCardWithCameras({ totalCameras: 5, streamsDown: 4, streamFault: 'peer' });
  const row = screen.getByText(/cameras: no video/);
  expect(row).toHaveTextContent('4 of 5');
  // and the second half of the scenario — 理由が一言 — the row says WHICH of
  // the three problems it is, because they send the operator to three
  // different places.
  expect(row).toHaveTextContent(/the network connection dropped/);
  expect(screen.queryByText('5 cameras OK')).not.toBeInTheDocument();
});

test('a total blackout through the streamer names the service, not the network', () => {
  renderCardWithCameras({ totalCameras: 5, streamsDown: 5, streamFault: 'signaling' });
  const row = screen.getByText(/cameras: no video/);
  expect(row).toHaveTextContent('5 of 5');
  expect(row).toHaveTextContent(/the streamer did not answer/);
});
