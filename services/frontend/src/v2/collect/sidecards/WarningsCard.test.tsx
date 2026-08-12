// #13 — the Active warnings card claimed "✓ No active warnings" while System
// status rows immediately above it read CHECK. These lock the rule that
// replaced it: the all-clear speaks for the checks too, so it may only appear
// when there is nothing open on either side.

import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../../api/client';
import { queryKeys } from '../../../api/queryKeys';
import type { AlertEvent, MetricsSnapshot, TopicStatus } from '../../../api/types';
import {
  jsonResponse,
  makeTestClient,
  renderWithClient,
} from '../../../test/renderWithClient';
import type { BatchMachine } from '../useBatchMachine';
import { needsAttentionItems } from './needsAttention';
import { SystemStatusCard } from './SystemStatusCard';
import { useSystemRowsStore } from './systemRowsStore';
import type { SysRow } from './useSystemRows';
import { WarningsCard } from './WarningsCard';

const GB = 1e9; // decimal — matches the shared formatBytes convention

// WarningsCard reads machine.arming and machine.goMonitor; the rest of the
// (large) BatchMachine is irrelevant here.
function warningsMachine(overrides: Partial<BatchMachine> = {}): BatchMachine {
  return { arming: null, goMonitor: vi.fn(), ...overrides } as unknown as BatchMachine;
}

function row(over: Partial<SysRow> & Pick<SysRow, 'label'>): SysRow {
  return { value: '—', chip: '—', tone: 'gray', ...over };
}

/** Publish rows the way SystemStatusCard does, without rendering it — for the
 *  cases that are about what the WARNINGS card does with a given set. */
function seedRows(rows: SysRow[]): void {
  useSystemRowsStore.setState({ rows });
}

function renderWarnings(machine: BatchMachine = warningsMachine()) {
  return renderWithClient(<WarningsCard machine={machine} defaultTopics={[]} />);
}

beforeEach(() => {
  setApiBase('/api/v1');
  // Anything the cards poll (topics, system, record status) answers emptily
  // unless a test overrides it.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(jsonResponse({})),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  useSystemRowsStore.setState({ rows: [] });
});

// ---- the disagreement: CHECK rows, zero alerts ------------------------------

test('CHECK rows with no alerts are surfaced instead of "No active warnings"', async () => {
  seedRows([
    row({
      label: 'Topic rates',
      value: '27 / 29 at expected',
      chip: 'CHECK',
      tone: 'amber',
    }),
    row({
      label: 'Build',
      value: 'robot abc1234 ≠ console def5678',
      chip: 'CHECK',
      tone: 'amber',
    }),
  ]);
  renderWarnings();

  const block = await screen.findByTestId('collect-needs-attention');
  // Both rows reach the operator, each with its own figure quoted from the row.
  expect(within(block).getByText('Topic rates')).toBeInTheDocument();
  expect(within(block).getByText('27 / 29 at expected')).toBeInTheDocument();
  expect(within(block).getByText('Build')).toBeInTheDocument();
  expect(
    within(block).getByText('robot abc1234 ≠ console def5678'),
  ).toBeInTheDocument();
  // …and what each means for the take, in words.
  expect(block).toHaveTextContent(/may hold less data/i);
  expect(block).toHaveTextContent(/different builds/i);

  // The claim that made this a bug is gone, and so is the bare "0" beside it.
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByText('2 to check')).toBeInTheDocument();
});

test('a row kind with no wording yet still reaches the card', async () => {
  // The guarantee is structural: a row added to useSystemRows later cannot let
  // the card go back to claiming an all-clear over a CHECK.
  seedRows([row({ label: 'Some future row', value: 'x', chip: 'CHECK', tone: 'amber' })]);
  renderWarnings();

  const block = await screen.findByTestId('collect-needs-attention');
  expect(within(block).getByText('Some future row')).toBeInTheDocument();
  expect(block).toHaveTextContent(/not passing/i);
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
});

// ---- the all-OK state, unchanged -------------------------------------------

test('nothing open anywhere still renders the checkmark and "No active warnings"', async () => {
  seedRows([
    row({ label: 'Topic rates', value: '29 / 29 at expected', chip: 'OK', tone: 'green' }),
    row({ label: 'Recorder', value: 'standby', chip: 'READY', tone: 'teal' }),
    row({ label: 'Cameras', value: 'none open' }), // gray "—" is not a CHECK
  ]);
  renderWarnings();

  await waitFor(() =>
    expect(screen.getByText('No active warnings')).toBeInTheDocument(),
  );
  expect(screen.getByText('✓')).toBeInTheDocument();
  expect(screen.getByText('0')).toBeInTheDocument();
  expect(screen.queryByTestId('collect-needs-attention')).not.toBeInTheDocument();
  expect(screen.queryByText(/to check/)).not.toBeInTheDocument();
});

// ---- alerts and checks together, kept apart ---------------------------------

function firingAlert(): AlertEvent {
  return {
    topic: '/camera/image_raw',
    metric: 'hz',
    op: 'lt',
    threshold: 15,
    value: 4.2,
    state: 'firing',
    since: '2026-08-12T09:00:00Z',
  } as AlertEvent;
}

test('a firing alert and an open check render as two distinct sections', async () => {
  seedRows([
    row({ label: 'Storage', value: '12.0 GB free', chip: 'CHECK', tone: 'amber' }),
  ]);
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, [firingAlert()]);
  renderWithClient(<WarningsCard machine={warningsMachine()} defaultTopics={[]} />, {
    client,
  });

  const alerts = await screen.findByTestId('collect-firing-alerts');
  const checks = screen.getByTestId('collect-needs-attention');
  // Separate containers, so neither is dressed as the other: the alert keeps
  // the red alert styling, the check keeps the neutral one.
  expect(alerts).not.toContainElement(checks);
  expect(checks).not.toContainElement(alerts);
  expect(alerts.className).toMatch(/red/);
  expect(checks.className).not.toMatch(/red/);

  expect(alerts).toHaveTextContent(/image_raw/);
  expect(within(checks).getByText('Storage')).toBeInTheDocument();
  // Both counts are stated, and neither is folded into the other.
  expect(screen.getByText('1 needs attention')).toBeInTheDocument();
  expect(screen.getByText('1 to check')).toBeInTheDocument();
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
});

// ---- the wiring: the rows really come from the system card ------------------

function metrics(statuses: TopicStatus[]): MetricsSnapshot {
  return {
    topics: statuses.map((status, i) => ({ name: `/t${i}`, status })),
  };
}

test('a CHECK derived by the System status card reaches the warnings card', async () => {
  // The live repro from #13: topic rates short of expected and a build skew,
  // with no alert of any kind in the buffer.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: null,
          state: 'created',
          live_capture_ids: [],
          disk_free_bytes: 400 * GB,
          git_sha: 'abc1234',
          console_git_sha: 'def5678',
        }),
      );
    }
    if (url.includes('/system')) {
      return Promise.resolve(
        jsonResponse({
          cpu: { model: 'Test CPU', cores: 8 },
          gpu: null,
          disk: { path: '/data', total_bytes: 900 * GB, free_bytes: 400 * GB },
        }),
      );
    }
    return Promise.resolve(jsonResponse({ topics: [] }));
  });

  const client = makeTestClient();
  client.setQueryData(queryKeys.metrics, metrics(['ok', 'ok', 'warning']));
  client.setQueryData(queryKeys.alerts, []);
  const machine = warningsMachine();
  renderWithClient(
    <>
      <SystemStatusCard
        machine={machine}
        sseStatus="open"
        monitorBridge="up"
        cameraHealth={{
          streamFailed: false,
          streamsDown: 0,
          streamFault: null,
          streamsNoVideo: 0,
          framesStale: false,
          silentTopics: 0,
          unmonitoredTopics: 0,
          totalCameras: 0,
        }}
      />
      <WarningsCard machine={machine} defaultTopics={[]} />
    </>,
    { client },
  );

  const block = await screen.findByTestId('collect-needs-attention');
  await waitFor(() =>
    expect(within(block).getByText('Build')).toBeInTheDocument(),
  );
  // The figures are the system card's own, not a second measurement.
  expect(within(block).getByText('2 / 3 at expected')).toBeInTheDocument();
  expect(within(block).getByText('robot abc1234 ≠ console def5678')).toBeInTheDocument();
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
});

// ---- needsAttentionItems: the pure mapping ---------------------------------

test('needsAttentionItems takes only the CHECK rows, and quotes them verbatim', () => {
  const items = needsAttentionItems([
    row({ label: 'Required data', value: '7 / 7 at start', chip: 'OK', tone: 'green' }),
    row({ label: 'Storage', value: '12.0 GB free', chip: 'CHECK', tone: 'amber' }),
    row({ label: 'Cameras', value: 'none open' }), // gray "—": no claim either way
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    label: 'Storage',
    value: '12.0 GB free',
    chip: 'CHECK',
    tone: 'amber',
  });
  expect(items[0]!.impact).toBeTruthy();
  expect(items[0]!.action).toBeTruthy();
});

test('the start-time gap is not repeated once the arming block already names it', () => {
  const rows = [
    row({ label: 'Required data', value: '5 / 7 at start', chip: 'CHECK', tone: 'amber' }),
    row({ label: 'Build', value: 'robot a ≠ console b', chip: 'CHECK', tone: 'amber' }),
  ];
  expect(needsAttentionItems(rows).map((i) => i.label)).toEqual([
    'Required data',
    'Build',
  ]);
  expect(
    needsAttentionItems(rows, { uncapturedShown: true }).map((i) => i.label),
  ).toEqual(['Build']);
});

test('a rate shortfall is worded as a shortfall, never as loss', () => {
  const [item] = needsAttentionItems([
    row({ label: 'Topic rates', value: '27 / 29 at expected', chip: 'CHECK', tone: 'amber' }),
  ]);
  const text = `${item!.impact} ${item!.action}`;
  expect(text).not.toMatch(/\blost\b|\bloss\b|\bdropped\b/i);
  expect(text).toMatch(/expected rate/i);
});
