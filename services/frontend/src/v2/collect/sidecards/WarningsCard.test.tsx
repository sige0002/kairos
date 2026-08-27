// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// #13 — the Active warnings card claimed "✓ No active warnings" while System
// status rows immediately above it read CHECK. These lock the rule that
// replaced it: the all-clear speaks for the checks too, so it may only appear
// when there is nothing open on either side.

import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../../api/client';
import { queryKeys } from '../../../api/queryKeys';
import type { AlertEvent, MetricsSnapshot, TopicStatus } from '../../../api/types';
import type { RuntimeConfig } from '../../../config';
import { useUiStore } from '../../../store/uiStore';
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

const TEST_CONFIG: RuntimeConfig = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: '/webrtc' },
  tabs: [],
  defaults: { default_topics: [], expected_hz: {} },
  schemas: {},
};

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
  return renderWithClient(
    <WarningsCard machine={machine} defaultTopics={[]} config={TEST_CONFIG} />,
  );
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
  useUiStore.setState({ sseStatus: 'closed', monitorBridge: null });
});

// ---- the disagreement: CHECK rows, zero alerts ------------------------------

test('CHECK rows with no alerts are surfaced instead of "No active warnings"', async () => {
  seedRows([
    row({
      label: 'Topic rates',
      value: '27 / 29 at expected',
      chip: 'CHECK',
      tone: 'amber',
      cause: 'rates-shortfall',
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
  expect(block).toHaveTextContent(/live monitor readings/i);
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
  renderWithClient(
    <WarningsCard
      machine={warningsMachine()}
      defaultTopics={[]}
      config={TEST_CONFIG}
    />,
    { client },
  );

  const alerts = await screen.findByTestId('collect-firing-alerts');
  const checks = screen.getByTestId('collect-needs-attention');
  // Separate containers, so neither is dressed as the other: the alert keeps
  // the red alert styling, the check keeps the neutral one.
  expect(alerts).not.toContainElement(checks);
  expect(checks).not.toContainElement(alerts);
  expect(alerts.className).toContain('status-danger');
  expect(checks.className).not.toContain('status-danger');

  expect(alerts).toHaveTextContent(/image_raw/);
  expect(within(checks).getByText('Storage')).toBeInTheDocument();
  // Both counts are stated, and neither is folded into the other.
  expect(screen.getByText('1 needs attention')).toBeInTheDocument();
  expect(screen.getByText('1 to check')).toBeInTheDocument();
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
});

// ---- the wiring: the rows really come from the system card ------------------

function metrics(statuses: TopicStatus[], malformedDropped?: number): MetricsSnapshot {
  return {
    topics: statuses.map((status, i) => ({ name: `/t${i}`, status })),
    ...(malformedDropped === undefined ? {} : { malformed_dropped: malformedDropped }),
  };
}

/** The fetch shape both integration cases below share: a healthy disk, an idle
 *  recorder, and no topics on the graph. */
function mockHealthyBackend(over: { git_sha?: string; console_git_sha?: string } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({
          run_id: null,
          state: 'created',
          live_capture_ids: [],
          disk_free_bytes: 400 * GB,
          ...over,
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
}

function renderBothCards(
  client: ReturnType<typeof makeTestClient>,
  config: RuntimeConfig = TEST_CONFIG,
) {
  const machine = warningsMachine();
  return renderWithClient(
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
      <WarningsCard machine={machine} defaultTopics={[]} config={config} />
    </>,
    { client },
  );
}

test('a CHECK derived by the System status card reaches the warnings card', async () => {
  // The live repro from #13: topic rates short of expected and a build skew,
  // with no alert of any kind in the buffer.
  mockHealthyBackend({ git_sha: 'abc1234', console_git_sha: 'def5678' });
  const client = makeTestClient();
  client.setQueryData(queryKeys.metrics, metrics(['ok', 'ok', 'warning']));
  client.setQueryData(queryKeys.alerts, []);
  renderBothCards(client);

  const block = await screen.findByTestId('collect-needs-attention');
  await waitFor(() => expect(within(block).getByText('Build')).toBeInTheDocument());
  // The figures are the system card's own, not a second measurement.
  expect(within(block).getByText('2 / 3 at expected')).toBeInTheDocument();
  expect(within(block).getByText('robot abc1234 ≠ console def5678')).toBeInTheDocument();
  expect(screen.queryByText('No active warnings')).not.toBeInTheDocument();
});

test('every affected topic is shown in full with current and expected Hz', async () => {
  mockHealthyBackend();
  useUiStore.setState({ sseStatus: 'open', monitorBridge: 'up' });
  const client = makeTestClient();
  client.setQueryData(queryKeys.metrics, {
    topics: [
      {
        name: '/zeta/camera/very_long_namespace/image_raw/compressed',
        status: 'warning',
        hz: 12.3,
      },
      {
        name: '/alpha/joint_states/with_a_complete_topic_name',
        status: 'danger',
        hz: 4.2,
      },
      {
        name: '/middle/sensor/that_is_currently_silent',
        status: 'inactive',
        hz: null,
      },
      { name: '/healthy/topic', status: 'ok', hz: 20 },
    ],
  } satisfies MetricsSnapshot);
  client.setQueryData(queryKeys.alerts, []);
  const config: RuntimeConfig = {
    ...TEST_CONFIG,
    defaults: {
      default_topics: [],
      expected_hz: {
        '/alpha/joint_states/with_a_complete_topic_name': 15,
        '/middle/sensor/that_is_currently_silent': 10,
        '/zeta/camera/very_long_namespace/image_raw/compressed': 30,
        '/healthy/topic': 20,
      },
    },
  };
  renderBothCards(client, config);

  const list = await screen.findByTestId('collect-rate-topics');
  expect(screen.getByText('3 topics need attention')).toBeInTheDocument();
  const topicRows = within(list).getAllByTestId('collect-rate-topic');
  expect(topicRows).toHaveLength(3);
  expect(topicRows.map((topicRow) => topicRow.textContent)).toEqual([
    '/alpha/joint_states/with_a_complete_topic_nameCurrent 4.2 Hz · Expected 15.0 Hz',
    '/middle/sensor/that_is_currently_silentCurrent — · Expected 10.0 Hz',
    '/zeta/camera/very_long_namespace/image_raw/compressedCurrent 12.3 Hz · Expected 30.0 Hz',
  ]);
  for (const name of [
    '/alpha/joint_states/with_a_complete_topic_name',
    '/middle/sensor/that_is_currently_silent',
    '/zeta/camera/very_long_namespace/image_raw/compressed',
  ]) {
    expect(within(list).getByText(name)).not.toHaveClass('truncate');
  }
  expect(list).not.toHaveTextContent('%');
  expect(list).not.toHaveTextContent(/more/i);
  expect(list).not.toHaveTextContent('/healthy/topic');
});

test('the real unreadable-only row gets the unreadable sentence, end to end', async () => {
  // The blocker case, driven through the real useSystemRows rather than a
  // hand-written row: every judged topic at rate, three readings the SSE ingest
  // could not identify. The row goes CHECK, and the prose must not invent an
  // off-rate topic to explain it.
  mockHealthyBackend();
  const client = makeTestClient();
  client.setQueryData(queryKeys.metrics, metrics(['ok', 'ok', 'ok'], 3));
  client.setQueryData(queryKeys.alerts, []);
  renderBothCards(client);

  const block = await screen.findByTestId('collect-check-topic-rates');
  expect(within(block).getByText('3 / 3 at expected · 3 unreadable')).toBeInTheDocument();
  expect(block).toHaveTextContent(/could not parse/i);
  expect(block).not.toHaveTextContent(/below their expected rate/i);
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

// ---- Topic rates: one chip, four causes, four sentences --------------------
//
// useSystemRows.ts fires CHECK on this row for a genuine rate shortfall OR for
// readings the SSE ingest could not identify (E-23) OR both. Keyed on the label
// alone, "12 / 12 at expected · 3 unreadable" was described as "not every topic
// is arriving at its expected rate… may hold less data" and sent the operator
// off to find the off-rate topics — every clause of which was false.

function ratesRow(value: string, cause: string): SysRow {
  return row({ label: 'Topic rates', value, chip: 'CHECK', tone: 'amber', cause });
}

/** The whole sentence the operator reads for a row. */
function proseFor(r: SysRow): string {
  const [item] = needsAttentionItems([r]);
  return `${item!.impact} ${item!.action}`;
}

test('a rate shortfall reports what the MONITOR observed, and hedges the recording', () => {
  const text = proseFor(ratesRow('27 / 29 at expected', 'rates-shortfall'));
  expect(text).toMatch(/live monitor readings/i);
  expect(text).toMatch(/do not confirm loss in the recorded file/i);
  expect(text).toMatch(/inspect the topics/i);
  // A monitor shortfall must not be promoted into a claim about the bag.
  expect(text).not.toMatch(/recording (is|has) (missing|lost)/i);
});

test('unreadable readings alone never claim a rate shortfall', () => {
  // The probe case: 12 / 12 judged at rate, 3 readings unidentifiable.
  const text = proseFor(ratesRow('12 / 12 at expected · 3 unreadable', 'rates-unreadable'));
  expect(text).toMatch(/every topic the monitor could read is at its expected rate/i);
  expect(text).toMatch(/could not parse/i);
  expect(text).toMatch(/what was readable, not everything the robot published/i);
  // The two false clauses of the old single sentence, gone.
  expect(text).not.toMatch(/below (their|its) expected rate/i);
  expect(text).not.toMatch(/which topics are below rate/i);
});

test('a shortfall AND unreadable readings are both stated', () => {
  const text = proseFor(ratesRow('10 / 12 at expected · 3 unreadable', 'rates-mixed'));
  expect(text).toMatch(/below their expected rate/i);
  expect(text).toMatch(/could not parse/i);
  // …and the ratio is explicitly not the whole picture.
  expect(text).toMatch(/floor rather than the whole picture/i);
});

test('nothing readable at all is stated as nothing established', () => {
  const text = proseFor(ratesRow('none readable · 3 unreadable', 'rates-none-readable'));
  expect(text).toMatch(/no topic here is established either way/i);
  expect(text).not.toMatch(/below (their|its) expected rate/i);
});

test('a rates row with no cause takes the honest fallback, not a guessed cause', () => {
  // Keyed on the label there is no entry at all, deliberately: a rates CHECK
  // this file cannot classify must not borrow one of the four sentences.
  const text = proseFor(row({ label: 'Topic rates', value: '?', chip: 'CHECK', tone: 'amber' }));
  expect(text).toMatch(/not passing/i);
  expect(text).not.toMatch(/expected rate/i);
});

test('the cause outranks the label when both have wording', () => {
  const items = needsAttentionItems([
    ratesRow('12 / 12 at expected · 3 unreadable', 'rates-unreadable'),
  ]);
  // The item still presents itself as the "Topic rates" row — the cause selects
  // the prose, it does not rename the row the operator has to go and look at.
  expect(items[0]!.label).toBe('Topic rates');
  expect(items[0]!.impact).toMatch(/could not parse/i);
});
