import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { renderWithClient, makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
import { LiveTab } from './LiveTab';
import { useUiStore } from '../../store/uiStore';
import type { RuntimeConfig } from '../../config';
import type { AlertEvent } from '../../api/types';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { default_topics: [] },
  schemas: {},
} as RuntimeConfig;

function mockStatus(status: Record<string, unknown>, runDetail?: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status')) return Promise.resolve(jsonResponse(status));
    if (url.match(/\/runs\/[^/]+$/) && runDetail)
      return Promise.resolve(jsonResponse(runDetail));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  setApiBase('/api/v1');
  // Reset the shared UI store so persisted draft state doesn't leak between tests.
  useUiStore.setState({
    recordOperator: '',
    recordTask: '',
    recordSelected: new Set(),
    recordCustomized: false,
    recordSeededKey: null,
    scopeOpen: false,
    scopeWindowId: '1m',
    scopePanels: [],
    scopePanelSeq: 0,
    recMarkers: [],
    recMarkersPrevActive: null,
  });
});
afterEach(() => vi.restoreAllMocks());

// Regression: a fresh recorder reports state="created" (run_id=null). That must
// render the IDLE hero (operator/task inputs + Start recording) — NOT a stuck
// Recording state.
test('fresh recorder (state=created) shows the idle hero, not Recording', async () => {
  mockStatus({ run_id: null, state: 'created' });
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('Idle')).toBeInTheDocument());
  expect(screen.queryByText('Recording')).not.toBeInTheDocument();
  expect(screen.getByLabelText('operator')).toBeInTheDocument();
  expect(screen.getByLabelText('task')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Start recording/ })).toBeInTheDocument();
});

test('active recording (state=recording) shows Recording + a stop button', async () => {
  mockStatus(
    { run_id: 'run_1', state: 'recording', message_count: 10, bytes: 2048 },
    {
      run_id: 'run_1',
      state: 'recording',
      operator: 'yuki',
      task: 'pick',
      started_at: '2026-06-26T00:00:00Z',
      topics: [{ name: '/a', type: 't' }],
    },
  );
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('Recording')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /Stop recording/ })).toBeInTheDocument();
  expect(screen.queryByText('Idle')).not.toBeInTheDocument();
});

// After Stop, a keep/discard prompt appears for the just-finished run; "Discard"
// deletes it via DELETE /runs/{id} so a bad take never lingers in the list.
test('stop shows a keep/discard prompt and Discard deletes the run', async () => {
  let deleted = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method;
    if (url.includes('/record/stop')) {
      return Promise.resolve(jsonResponse({ run_id: 'run_1', state: 'stopping' }));
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: 'run_1', state: 'recording', message_count: 5, bytes: 1024 }),
      );
    }
    if (url.match(/\/runs\/run_1$/) && method === 'DELETE') {
      deleted = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.match(/\/runs\/[^/]+$/)) {
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_1',
          state: 'recording',
          operator: 'yuki',
          task: 'pick',
          started_at: '2026-06-26T00:00:00Z',
          topics: [{ name: '/a', type: 't' }],
        }),
      );
    }
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<LiveTab config={CONFIG} />);
  await waitFor(() => expect(screen.getByText('Recording')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /Stop recording/ }));

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('run_1');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

  await waitFor(() => expect(deleted).toBe(true));
});

// A recorder-rejected start comes back as HTTP 200 with the run row in `failed`
// (the orchestrator keeps the row). The hero must surface that as an error
// banner — before this, the button just snapped back to Idle with no hint that
// the recording silently never started.
test('a start returned as failed (HTTP 200) surfaces the start-failed banner', async () => {
  let startCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start')) {
      startCalls += 1;
      // Second attempt stays in flight so the cleared-banner state is stable
      // to assert (a resolved retry would immediately re-set the banner).
      if (startCalls > 1) return new Promise<Response>(() => {});
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_f1',
          state: 'failed',
          topics: [],
          error: {
            code: 'record_arm_failed',
            message: 'Recording failed to arm (subscribe + resume).',
          },
        }),
      );
    }
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('record-state')).toHaveTextContent('Idle'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  const note = await screen.findByTestId('start-failed-note');
  expect(note).toHaveTextContent('Start failed');
  expect(note).toHaveTextContent('run_f1');
  expect(note).toHaveTextContent('record_arm_failed');
  // The hero is back to Idle — failed means capture never began.
  expect(screen.getByTestId('record-state')).toHaveTextContent('Idle');
  // A new start attempt clears the stale banner immediately.
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await waitFor(() =>
    expect(screen.queryByTestId('start-failed-note')).not.toBeInTheDocument(),
  );
});

// While POST /record/start blocks through the recorder's arming gate (1–4+ s),
// the hero must show a distinct Starting state (amber, with the arming strip)
// instead of sitting on Idle as if the click did nothing.
test('a pending start shows the Starting hero state and the arming strip', async () => {
  let resolveStart: ((r: Response) => void) | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/start'))
      return new Promise<Response>((res) => {
        resolveStart = res;
      });
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/topics')) return Promise.resolve(jsonResponse([]));
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByTestId('record-state')).toHaveTextContent('Idle'));
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() =>
    expect(screen.getByTestId('record-state')).toHaveTextContent('Starting…'),
  );
  expect(screen.getByTestId('starting-note')).toBeInTheDocument();
  expect(screen.queryByTestId('start-failed-note')).not.toBeInTheDocument();

  // Settle the in-flight POST so nothing leaks into the next test.
  resolveStart!(jsonResponse({ run_id: 'r1', state: 'recording', topics: [] }));
  await waitFor(() =>
    expect(screen.queryByTestId('starting-note')).not.toBeInTheDocument(),
  );
});

// OL-①.4: when a --start-paused recording armed with topics still missing, the
// hero shows the arming strip (matched vs missing) so the operator sees the gap.
test('active recording shows the arming strip when topics were still missing', async () => {
  mockStatus(
    {
      run_id: 'run_1',
      state: 'recording',
      message_count: 10,
      bytes: 2048,
      arming: {
        active: false,
        matched_topics: ['/hsrb/joint_states'],
        missing_topics: ['/hsrb/head_rgbd/depth'],
        resume_at: '2026-06-27T00:00:00.000Z',
      },
    },
    {
      run_id: 'run_1',
      state: 'recording',
      operator: 'yuki',
      task: 'pick',
      started_at: '2026-06-26T00:00:00Z',
      topics: [{ name: '/hsrb/joint_states', type: 't' }],
    },
  );
  renderWithClient(<LiveTab config={CONFIG} />);

  const note = await screen.findByTestId('arming-note');
  expect(note).toHaveTextContent('1 matched');
  expect(note).toHaveTextContent('1 missing');
  expect(note).toHaveTextContent('/hsrb/head_rgbd/depth');
});

// The arming strip is absent for a plain (non-start-paused) recording: status
// carries no arming, so nothing extra renders in the hero.
test('no arming strip when the recorder reports no arming', async () => {
  mockStatus(
    { run_id: 'run_1', state: 'recording', message_count: 10, bytes: 2048 },
    {
      run_id: 'run_1',
      state: 'recording',
      started_at: '2026-06-26T00:00:00Z',
      topics: [{ name: '/a', type: 't' }],
    },
  );
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('Recording')).toBeInTheDocument());
  expect(screen.queryByTestId('arming-note')).not.toBeInTheDocument();
});

// OL-①: a finished run that lost messages to the in-recorder cache surfaces an
// integrity badge with the dropped count (the bag is missing data even though
// the run "completed"). OpenLUTRA reports no such signal.
test('integrity badge shows dropped count after a run with cache drops', async () => {
  mockStatus({
    run_id: 'run_1',
    state: 'completed',
    message_count: 1800,
    bytes: 2048,
    integrity: 'dropped',
    dropped_messages: 17,
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  const note = await screen.findByTestId('integrity-note');
  expect(note).toHaveTextContent('Data dropped');
  expect(note).toHaveTextContent('17 messages lost');
});

// A clean finished run (integrity ok) renders no integrity badge — it is a
// problem banner, not a status line.
test('no integrity badge for a clean (integrity=ok) run', async () => {
  mockStatus({
    run_id: 'run_1',
    state: 'completed',
    message_count: 1800,
    bytes: 2048,
    integrity: 'ok',
    dropped_messages: 0,
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('Idle')).toBeInTheDocument());
  expect(screen.queryByTestId('integrity-note')).not.toBeInTheDocument();
});

// The Live page shows the active robot/config and lets you switch it via a
// dropdown (reusing /config/options + /config/select).
test('robot dropdown lists robots and switching posts /config/select', async () => {
  const options = {
    active_robot: 'airoa_hsr',
    robots: [
      { id: 'airoa_hsr', local: false },
      { id: 'myrobot', local: true },
    ],
    aspects: {
      recording: { active: 'default', options: [] },
      stream: { active: 'default', options: [] },
      validation: { active: 'default', options: [] },
      validators: { active: 'default', options: [] },
    },
  };
  const posted: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/config/options')) return Promise.resolve(jsonResponse(options));
    if (url.includes('/config/select')) {
      posted.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      return Promise.resolve(jsonResponse({ ...options, active_robot: 'myrobot' }));
    }
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  const select = (await screen.findByLabelText('active robot')) as HTMLSelectElement;
  expect(select.value).toBe('airoa_hsr');
  expect(screen.getByText(/config: airoa_hsr/)).toBeInTheDocument();

  fireEvent.change(select, { target: { value: 'myrobot' } });
  await waitFor(() =>
    expect(posted).toContainEqual({ category: 'robot', id: 'myrobot' }),
  );
});

// Regression: typing operator/task then navigating away (Live tab unmounts)
// and back must NOT reset them — they live in the persistent UI store.
test('operator/task survive a remount (tab switch away and back)', async () => {
  mockStatus({ run_id: null, state: 'created' });
  const { unmount } = renderWithClient(<LiveTab config={CONFIG} />);

  await waitFor(() => expect(screen.getByText('Idle')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('operator'), { target: { value: 'yuki' } });
  fireEvent.change(screen.getByLabelText('task'), { target: { value: 'pick' } });

  unmount(); // leave the Live tab
  renderWithClient(<LiveTab config={CONFIG} />); // come back

  await waitFor(() => expect(screen.getByLabelText('operator')).toHaveValue('yuki'));
  expect(screen.getByLabelText('task')).toHaveValue('pick');
});

// T-L3: the Monitor doubles as the next-recording topic picker. Configured
// topics seed checked; the operator can add others; Start recording captures
// exactly the checked set.
test('record checkboxes seed from configured topics and drive the next start', async () => {
  let startBody: { topics?: unknown } | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/record/start')) {
      startBody = JSON.parse(String((init as RequestInit).body));
      return Promise.resolve(jsonResponse({ run_id: 'r1', state: 'recording' }));
    }
    if (url.includes('/topics'))
      return Promise.resolve(
        jsonResponse([
          { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState', publisher_count: 1 },
          { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 },
        ]),
      );
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  const cfg = {
    ...CONFIG,
    defaults: { default_topics: ['/hsrb/joint_states'] },
  } as RuntimeConfig;
  renderWithClient(<LiveTab config={cfg} />);

  // Configured topic seeds checked; the discovered-but-unconfigured one does not.
  const joint = await screen.findByLabelText('record /hsrb/joint_states');
  const odom = screen.getByLabelText('record /hsrb/odom');
  await waitFor(() => expect(joint).toBeChecked());
  expect(odom).not.toBeChecked();

  // Add odom, then start: the body carries exactly the checked set.
  fireEvent.click(odom);
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));

  await waitFor(() => expect(startBody).not.toBeNull());
  expect(new Set(startBody!.topics as string[])).toEqual(
    new Set(['/hsrb/joint_states', '/hsrb/odom']),
  );
});

// MON-C1 counterpart: the Monitor panel surfaces SSE alerts as a collapsed
// active-count badge that expands a short list. Collapsed by default (no space);
// nothing renders when the alert buffer is empty.
test('monitor alerts show an active-count badge that expands a list', async () => {
  mockStatus({ run_id: null, state: 'created' });
  const client = makeTestClient();
  client.setQueryData(queryKeys.alerts, [
    {
      topic: '/hsrb/odom',
      metric: 'hz',
      op: 'lt',
      threshold: 10,
      value: 3,
      state: 'firing',
      since: '2026-07-02T00:00:00Z',
    },
  ] satisfies AlertEvent[]);
  renderWithClient(<LiveTab config={CONFIG} />, { client });

  const badge = await screen.findByLabelText('alerts');
  expect(badge).toHaveTextContent('1 alert');
  // Collapsed by default.
  expect(screen.queryByTestId('alert-list')).not.toBeInTheDocument();

  fireEvent.click(badge);
  const list = await screen.findByTestId('alert-list');
  expect(list).toHaveTextContent('/hsrb/odom');
  expect(list).toHaveTextContent('firing');
});

// With no alerts buffered, the badge is absent entirely (takes no space).
test('no alert badge when the alert buffer is empty', async () => {
  mockStatus({ run_id: null, state: 'created' });
  renderWithClient(<LiveTab config={CONFIG} />);
  await waitFor(() => expect(screen.getByText('Idle')).toBeInTheDocument());
  expect(screen.queryByLabelText('alerts')).not.toBeInTheDocument();
});

// OL-③.2: clicking a topic name in the Monitor panel adds a Health panel for
// it in the Scope band (replaces the old fixed-bottom LiveHealthGraph overlay).
test('clicking a topic name adds a Health panel for it in the Scope band', async () => {
  mockStatus({ run_id: null, state: 'created' });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/topics'))
      return Promise.resolve(
        jsonResponse([{ name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 }]),
      );
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  renderWithClient(<LiveTab config={CONFIG} />);

  const nameButton = await screen.findByLabelText('graph /hsrb/odom health');
  // Collapsed by default: no panel content rendered yet.
  expect(screen.queryByTestId('scope-panel')).not.toBeInTheDocument();

  fireEvent.click(nameButton);

  const panel = await screen.findByTestId('scope-panel');
  expect(within(panel).getByText('odom')).toBeInTheDocument(); // topic chip (short name)

  fireEvent.click(screen.getByLabelText('remove panel'));
  await waitFor(() => expect(screen.queryByTestId('scope-panel')).not.toBeInTheDocument());
});

// Regression (L-04): a customized record-topic selection must survive the Live
// tab unmounting on navigation. It lives in the persistent UI store, so a tab
// round-trip can't silently revert it to the configured defaults (which would
// start the next recording with an unintended topic set).
test('customized record-topic selection survives a remount', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/topics'))
      return Promise.resolve(
        jsonResponse([
          { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState', publisher_count: 1 },
          { name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 },
        ]),
      );
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  const cfg = { ...CONFIG, defaults: { default_topics: ['/hsrb/joint_states'] } } as RuntimeConfig;
  const { unmount } = renderWithClient(<LiveTab config={cfg} />);

  const odom = await screen.findByLabelText('record /hsrb/odom');
  await waitFor(() =>
    expect(screen.getByLabelText('record /hsrb/joint_states')).toBeChecked(),
  );
  expect(odom).not.toBeChecked();
  fireEvent.click(odom); // customize: add odom to the next-recording set

  unmount(); // leave the Live tab
  renderWithClient(<LiveTab config={cfg} />); // come back

  await waitFor(() => expect(screen.getByLabelText('record /hsrb/odom')).toBeChecked());
  expect(screen.getByLabelText('record /hsrb/joint_states')).toBeChecked();
});

// Regression (L-14): the open Scope Health panel (and its topic selection)
// survives a remount — scopePanels/scopeOpen live in the persistent UI store,
// so a tab round-trip no longer collapses the band or drops the panel.
test('the open Scope Health panel survives a remount', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/record/status'))
      return Promise.resolve(jsonResponse({ run_id: null, state: 'created' }));
    if (url.includes('/topics'))
      return Promise.resolve(
        jsonResponse([{ name: '/hsrb/odom', type: 'nav_msgs/msg/Odometry', publisher_count: 1 }]),
      );
    if (url.includes('/runs'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
  const { unmount } = renderWithClient(<LiveTab config={CONFIG} />);

  fireEvent.click(await screen.findByLabelText('graph /hsrb/odom health'));
  expect(await screen.findByTestId('scope-panel')).toBeInTheDocument();

  unmount(); // leave the Live tab
  renderWithClient(<LiveTab config={CONFIG} />); // come back

  // The band is still expanded with its panel, without re-clicking — the
  // selection persisted in the UI store.
  expect(await screen.findByTestId('scope-panel')).toBeInTheDocument();
});
