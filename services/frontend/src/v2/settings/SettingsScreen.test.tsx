// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SettingsScreen } from './SettingsScreen';
import {
  __rehydratePlansStore,
  __resetPlansStore,
  getExternalControls,
  getFailReasons,
  getPlans,
  setPlans,
} from '../plans';
import { DEFAULT_EXTERNAL_CONTROLS } from '../collect/machine/externalControlConfig';
import { __resetStopConfirmMs, __setStopConfirmMs } from '../captures/stopConfirm';
import { expectScreenHeadingOutline } from '../../test/headingOutline';

// Runtime config (GET /api/v1/config): the ACTIVE robot's read-only values that
// the Robots form surfaces (ROS_DOMAIN_ID + recorded topics).
const CONFIG_WITH_ROBOT = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: {
    robot_name: 'hsr',
    ros_domain_id: 42,
    default_topics: ['/tf', '/joint_states', '/camera/top/image_raw'],
  },
  schemas: {},
};

// GET /api/v1/config/options — the real robot-first catalog (mirrors the live
// backend: airoa_hsr active, a committed `template`, two local robots).
const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [
    { id: 'airoa_hsr', local: false },
    { id: 'template', local: false },
    { id: 'isaac_sim', local: true },
    { id: 'myrobot', local: true },
  ],
  aspects: {
    recording: {
      active: 'default',
      options: [
        {
          id: 'default',
          path: '/config/airoa_hsr/recording/default.yaml',
          local: false,
          meta: { default_topics: 7 },
        },
      ],
    },
    stream: {
      active: 'default',
      options: [
        {
          id: 'default',
          path: '/config/airoa_hsr/stream/default.yaml',
          local: false,
          meta: { columns: 2, panes: 2 },
        },
      ],
    },
    validation: {
      active: 'default',
      options: [
        {
          id: 'default',
          path: '/config/airoa_hsr/validation/default.yaml',
          local: false,
          meta: {
            name: 'airoa_hsr',
            version: 1,
            required_topics: [
              { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
            ],
          },
        },
        {
          id: 'strict',
          path: '/config/airoa_hsr/validation/strict.yaml',
          local: false,
          meta: { name: 'strict', version: 2, required_topics: [{ name: '/a' }] },
        },
      ],
    },
    validators: {
      active: 'loss_report',
      options: [
        {
          id: 'loss_report',
          path: '/config/airoa_hsr/validators/loss_report.yaml',
          local: false,
          meta: {},
        },
      ],
    },
  },
};

const RECORDING = {
  config: {
    robot_name: 'hsr',
    default_topics: ['/hsrb/odom'],
    expected_hz_patterns: [],
  },
  path: '/config/airoa_hsr/recording/default.yaml',
};

// GET /api/v1/config/stream — the Collect camera-pane layout editor's source.
// `path: null` (a robot without a config dir) and `error` (a present-but-
// broken file) are flipped per-test.
let streamPayload: {
  config: Record<string, unknown> | null;
  path: string | null;
  error: string | null;
} = {
  config: { columns: 2, panes: [{ topic: '/cam/a' }, { topic: '/cam/b' }] },
  path: '/config/airoa_hsr/stream/default.yaml',
  error: null,
};

// GET /api/v1/config/robots/{robot} — read-only view of a non-active robot.
const ROBOT_CONFIG_TEMPLATE = {
  robot: 'template',
  local: false,
  active: false,
  summary: {
    robot_name: 'template',
    default_topics: ['/tmpl/a', '/tmpl/b'],
    ros_domain_id: null,
  },
  aspects: {
    recording: {
      id: 'default',
      path: '/config/template/recording/default.yaml',
      local: false,
      content: { robot_name: 'template', default_topics: ['/tmpl/a', '/tmpl/b'] },
    },
    stream: null,
    validation: null,
    validators: null,
  },
};

// GET /api/v1/plans — the SHARED catalog this browser reconciles against on
// mount. Default is a never-set server (this browser seeds it), which is what
// every pre-existing test assumed; the empty-catalog tests flip it.
let serverPlans: unknown = {
  projects: null,
  failure_reasons: null,
  operators: null,
  updated_at: null,
};

// Optionally hold that GET open. The reconcile runs once per page load and is
// asynchronous, so the operator can already be deep in the Plans editor when the
// response lands — the sequence where a stale cursor meets a shorter catalog.
let plansGate: { promise: Promise<void>; release: () => void } | null = null;

// Make PUT /plans fail, as a flaky or offline link does.
let plansPutFails = false;

function holdPlansResponse() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  plansGate = { promise, release };
  return plansGate;
}

// The recorder state served by GET /record/status; tests flip it to exercise the
// recording-aware guards.
let recordState: 'created' | 'recording' = 'created';
// Whether that response carries `live_capture_ids` at all. §10 rev.2.4: a
// response without it is an unreachable recorder, not an idle one — a distinct
// case the guards have to handle, so it is switchable here.
let liveReported = true;

// The robot the server currently considers active. `/config/select` moves it,
// and the per-robot files below are served accordingly — alerts.yaml lives at
// config/<robot>/monitoring/alerts.yaml, so its contents and path are the
// ACTIVE robot's, not a global.
let activeRobot = 'airoa_hsr';

/** GET /config/alerts for whichever robot is active right now. */
function alertsFor(robot: string) {
  return {
    path: `/config/${robot}/monitoring/alerts.yaml`,
    raw: `rules:\n  - topic: /${robot}/joint_states\n    metric: hz\n    op: lt\n    threshold: 15\n`,
    warnings: [],
    config: {
      rules: [
        {
          topic: `/${robot}/joint_states`,
          metric: 'hz',
          op: 'lt',
          threshold: 15,
          clear_after_s: 3,
          cooldown_s: 10,
        },
      ],
      derived_rules: null,
    },
  };
}

/** Build the /config/select echo: active follows the posted selection. */
function echoSelect(body: { category: string; id: string }) {
  const next = structuredClone(OPTIONS);
  if (body.category === 'robot') {
    next.active_robot = body.id;
    activeRobot = body.id;
  } else {
    const aspect = next.aspects[body.category as keyof typeof next.aspects];
    if (aspect) aspect.active = body.id;
  }
  return next;
}

/** Wire fetch for the runtime config + the three /config endpoints the Robots
 *  section talks to. Specific paths are matched before the bare /config. */
function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse({ ...OPTIONS, active_robot: activeRobot }));
    }
    if (url.includes('/config/alerts')) {
      return Promise.resolve(jsonResponse(alertsFor(activeRobot)));
    }
    if (url.includes('/config/recording')) {
      if (method === 'PUT') {
        const body = JSON.parse(String((init as RequestInit).body));
        return Promise.resolve(
          jsonResponse({ config: body.config, path: RECORDING.path }),
        );
      }
      return Promise.resolve(jsonResponse(RECORDING));
    }
    if (url.includes('/config/stream')) {
      if (method === 'PUT') {
        const body = JSON.parse(String((init as RequestInit).body));
        return Promise.resolve(
          jsonResponse({ config: body.config, path: streamPayload.path, error: null }),
        );
      }
      return Promise.resolve(jsonResponse(streamPayload));
    }
    if (url.includes('/config/select')) {
      const body = JSON.parse(String((init as RequestInit).body));
      return Promise.resolve(jsonResponse(echoSelect(body)));
    }
    if (url.includes('/config/robots/')) {
      return Promise.resolve(jsonResponse(ROBOT_CONFIG_TEMPLATE));
    }
    if (url.includes('/record/stop')) {
      recordState = 'created';
      return Promise.resolve(jsonResponse({ run_id: 'run_x', state: 'completed' }));
    }
    if (url.includes('/record/status')) {
      const live = recordState === 'recording' ? ['cap_x'] : [];
      return Promise.resolve(
        jsonResponse({
          run_id: recordState === 'recording' ? 'run_x' : null,
          capture_id: recordState === 'recording' ? 'cap_x' : null,
          state: recordState,
          ...(liveReported ? { live_capture_ids: live } : {}),
        }),
      );
    }
    if (url.includes('/plans')) {
      if (method === 'PUT') {
        if (plansPutFails) {
          return Promise.resolve(
            jsonResponse({ error: { code: 'io', message: 'down' } }, 503),
          );
        }
        const body = JSON.parse(String((init as RequestInit).body));
        return Promise.resolve(jsonResponse({ ...body, updated_at: 't1' }));
      }
      const gate = plansGate;
      if (gate) return gate.promise.then(() => jsonResponse(serverPlans));
      return Promise.resolve(jsonResponse(serverPlans));
    }
    if (url.includes('/config')) {
      return Promise.resolve(jsonResponse(CONFIG_WITH_ROBOT));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

/** The POST bodies fetch has seen for a given path substring. */
function postsTo(pathPart: string) {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls.filter((c) => String(c[0]).includes(pathPart));
}

/** The /config/select POST bodies fetch has seen so far. */
function selectPosts() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .filter((c) => String(c[0]).includes('/config/select'))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

beforeEach(() => {
  setApiBase('/api/v1');
  window.localStorage.removeItem('kairos.appearance');
  document.documentElement.dataset.theme = 'light';
  recordState = 'created';
  liveReported = true;
  streamPayload = {
    config: { columns: 2, panes: [{ topic: '/cam/a' }, { topic: '/cam/b' }] },
    path: '/config/airoa_hsr/stream/default.yaml',
    error: null,
  };
  serverPlans = {
    projects: null,
    failure_reasons: null,
    operators: null,
    updated_at: null,
  };
  plansGate = null;
  plansPutFails = false;
  activeRobot = 'airoa_hsr';
  // Plans live in the shared v2/plans store now; reset it so a project added in
  // one test can't leak into the next.
  __resetPlansStore();
  mockFetch();
});
afterEach(() => {
  __resetStopConfirmMs();
  vi.restoreAllMocks();
});

test('lists the real robots and marks the active one', async () => {
  renderWithClient(<SettingsScreen />);

  const row0 = await screen.findByTestId('robot-row-0');
  expect(within(row0).getByText('airoa_hsr')).toBeInTheDocument();
  expect(within(row0).getByText('active')).toBeInTheDocument();
  // Local robots are badged.
  const localRow = screen.getByTestId('robot-row-2');
  expect(within(localRow).getByText('isaac_sim')).toBeInTheDocument();
  expect(within(localRow).getByText('local')).toBeInTheDocument();
});

test('Appearance applies immediately in Settings and is browser-local', () => {
  renderWithClient(<SettingsScreen />);

  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  expect(screen.getByTestId('settings-appearance')).toBeInTheDocument();
  expect(screen.getByTestId('appearance-system')).toBeChecked();

  const fetchCallsBeforeSelection = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    .length;
  fireEvent.click(screen.getByTestId('appearance-dark'));
  expect(screen.getByTestId('appearance-dark')).toBeChecked();
  expect(screen.getByTestId('appearance-status')).toHaveTextContent('Using dark');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(window.localStorage.getItem('kairos.appearance')).toBe('dark');
  expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
    fetchCallsBeforeSelection,
  );
});

test('Appearance explains when the browser cannot persist the selection', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  renderWithClient(<SettingsScreen />);

  fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
  fireEvent.click(screen.getByTestId('appearance-dark'));

  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(screen.getByTestId('appearance-status')).toHaveTextContent(
    'Browser storage is unavailable',
  );
  expect(screen.getByTestId('appearance-status')).toHaveTextContent(
    'choose it again after reload',
  );
});

test('the active robot form shows real read-only runtime values + the recording editor', async () => {
  renderWithClient(<SettingsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('robot-form-name')).toHaveTextContent('airoa_hsr'),
  );
  expect(screen.getByTestId('robot-topics-summary')).toHaveTextContent(
    '3 recorded topics',
  );
  const chips = screen.getByTestId('robot-topic-chips');
  expect(within(chips).getByText('/tf')).toBeInTheDocument();
  expect(within(chips).getByText('/camera/top/image_raw')).toBeInTheDocument();

  // The embedded ConfigTab RecordingConfigEditor, seeded from GET /config/recording.
  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));
});

test('selecting a non-active robot shows its config read-only, without switching', async () => {
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1'));

  expect(screen.getByTestId('robot-form-name')).toHaveTextContent('template');
  // Read-only banner names the robot and says how to edit.
  const banner = await screen.findByTestId('robot-readonly-banner');
  expect(banner).toHaveTextContent('Read-only');
  expect(banner).toHaveTextContent('template');
  expect(banner).toHaveTextContent('Activate it to edit');
  // Its recording config is visible as a disabled template (a different editor
  // from the active robot's editable one).
  const readonly = (await screen.findByLabelText(
    'recording config json (read-only)',
  )) as HTMLTextAreaElement;
  expect(readonly).toBeDisabled();
  expect(readonly.value).toContain('/tmpl/a');
  expect(screen.queryByLabelText('recording config json')).not.toBeInTheDocument();
  // Merely selecting a row must NOT POST a switch.
  expect(selectPosts()).toHaveLength(0);
});

test('+ Add robot opens a persistent explainer panel (not a toast)', async () => {
  renderWithClient(<SettingsScreen />);
  await screen.findByTestId('robot-row-0');

  fireEvent.click(screen.getByTestId('add-robot'));
  const explainer = screen.getByTestId('robot-add-explainer');
  expect(explainer).toHaveTextContent('config/<robot>/');
  expect(explainer).toHaveTextContent('no in-console create yet');
  expect(explainer).toHaveTextContent('inspect its config as a template');
  // Selecting a robot dismisses the explainer.
  fireEvent.click(screen.getByTestId('robot-row-1'));
  expect(screen.queryByTestId('robot-add-explainer')).not.toBeInTheDocument();
});

test('the menu rail footer shows the real active robot (not a fabricated version)', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('settings-active-robot')).toHaveTextContent('airoa_hsr'),
  );
  expect(screen.queryByText(/v2\.4\.1/)).not.toBeInTheDocument();
});

test('activating a robot while recording confirms first, then stops and switches', async () => {
  recordState = 'recording';
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1')); // template (non-active)

  // The activate action opens a confirm modal, not an immediate switch.
  fireEvent.click(screen.getByTestId('activate-robot'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('A capture is live');
  expect(dialog).toHaveTextContent('Switching robots will stop it');
  expect(selectPosts()).toHaveLength(0);
  expect(postsTo('/record/stop')).toHaveLength(0);

  // Stop & switch: POST /record/stop, then POST /config/select {robot}.
  fireEvent.click(screen.getByRole('button', { name: 'Stop & switch' }));
  await waitFor(() => expect(postsTo('/record/stop')).toHaveLength(1));
  await waitFor(() =>
    expect(selectPosts()).toContainEqual({ category: 'robot', id: 'template' }),
  );
  // The switch is disclosed as PARTIAL: the ROS services keep their startup
  // configs until restarted (S1-3) — pretending otherwise is how a
  // mixed-config recording gets made.
  const note = await screen.findByTestId('robot-switch-note');
  expect(note).toHaveTextContent(/until they are restarted/);
  expect(note).toHaveTextContent('make restart monitor streamer probe');
});

// S2-5 (timing sweep 2026-08-07): "stop answered 200" is not "stopped". A
// recorder that is still flushing keeps the config out of reach — switching
// while it drains would hot-swap the recording's config mid-write. The switch
// must ride the same confirmation poll Collect's SAVING gate uses.
test('stop & switch waits out a flushing recorder before selecting', async () => {
  __setStopConfirmMs(5000, 5);
  recordState = 'recording';
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1'));
  fireEvent.click(screen.getByTestId('activate-robot'));
  await screen.findByRole('dialog');

  // From here the recorder acknowledges the stop but keeps flushing for two
  // more status reads; everything else falls through to the standard mock.
  const base = globalThis.fetch;
  let stopped = false;
  let statusAfterStop = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/record/stop')) {
      stopped = true;
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_x',
          capture_id: 'cap_x',
          state: 'stopping',
          live_capture_ids: ['cap_x'],
        }),
      );
    }
    if (stopped && url.includes('/record/status')) {
      statusAfterStop += 1;
      if (statusAfterStop <= 2) {
        return Promise.resolve(
          jsonResponse({
            run_id: 'run_x',
            capture_id: 'cap_x',
            state: 'stopping',
            live_capture_ids: ['cap_x'],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          run_id: 'run_x',
          capture_id: 'cap_x',
          state: 'completed',
          live_capture_ids: [],
        }),
      );
    }
    return (base as typeof fetch)(input as RequestInfo, init);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Stop & switch' }));
  // While the recorder still reports the flush, the select must not have fired.
  await waitFor(() => expect(statusAfterStop).toBeGreaterThanOrEqual(1));
  expect(selectPosts()).toHaveLength(0);
  // Once the recorder settles, the switch goes through.
  await waitFor(() =>
    expect(selectPosts()).toContainEqual({ category: 'robot', id: 'template' }),
  );
  expect(statusAfterStop).toBeGreaterThanOrEqual(3);
});

// §10 rev.2.4: a status response with no live_capture_ids means the recorder
// could not be asked. Switching robots stops whatever is running, so "we cannot
// tell" must confirm first — treating the absent array as "nothing is live"
// would kill a recording without asking.
test('a status response without live_capture_ids confirms before switching', async () => {
  liveReported = false;
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1'));

  fireEvent.click(screen.getByTestId('activate-robot'));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('did not report its live captures');
  expect(selectPosts()).toHaveLength(0);
});

test('cancelling the switch-while-recording confirm leaves the recording alone', async () => {
  recordState = 'recording';
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1'));

  fireEvent.click(screen.getByTestId('activate-robot'));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(postsTo('/record/stop')).toHaveLength(0);
  expect(selectPosts()).toHaveLength(0);
});

test('the recording-config editor warns that a save applies to the next recording', async () => {
  recordState = 'recording';
  renderWithClient(<SettingsScreen />);
  // Active robot (airoa_hsr) renders the editable editor.
  await screen.findByLabelText('recording config json');
  expect(
    await screen.findByText(
      /saving recording config won.t change the current one; it applies to the next/i,
    ),
  ).toBeInTheDocument();
});

test('"Use this robot" POSTs {category: robot} for the previewed robot', async () => {
  renderWithClient(<SettingsScreen />);
  fireEvent.click(await screen.findByTestId('robot-row-1'));
  fireEvent.click(screen.getByTestId('activate-robot'));

  await waitFor(() =>
    expect(selectPosts()).toContainEqual({ category: 'robot', id: 'template' }),
  );
});

test('the activate action is disabled for the already-active robot', async () => {
  renderWithClient(<SettingsScreen />);
  // Default selection is the active robot (airoa_hsr).
  await waitFor(() =>
    expect(screen.getByTestId('robot-form-name')).toHaveTextContent('airoa_hsr'),
  );
  const activate = screen.getByTestId('activate-robot');
  expect(activate).toBeDisabled();
  expect(activate).toHaveTextContent('Active');
});

test('aspect pickers select an option and POST {category: <aspect>}', async () => {
  renderWithClient(<SettingsScreen />);
  const validation = (await screen.findByLabelText(
    'validation option',
  )) as HTMLSelectElement;
  expect(validation.value).toBe('default');
  // All four aspect pickers are present.
  expect(screen.getByLabelText('recording option')).toBeInTheDocument();
  expect(screen.getByLabelText('stream option')).toBeInTheDocument();
  expect(screen.getByLabelText('validators option')).toBeInTheDocument();

  fireEvent.change(validation, { target: { value: 'strict' } });
  await waitFor(() =>
    expect(selectPosts()).toContainEqual({ category: 'validation', id: 'strict' }),
  );
});

test('saving the recording editor PUTs the edited config', async () => {
  renderWithClient(<SettingsScreen />);
  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));

  const edited = {
    robot_name: 'tiago',
    default_topics: ['/a'],
    expected_hz_patterns: [],
  };
  fireEvent.change(editor, { target: { value: JSON.stringify(edited, null, 2) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const put = calls.find(
      (c) =>
        String(c[0]).includes('/config/recording') &&
        ((c[1] as RequestInit)?.method ?? 'GET') === 'PUT',
    );
    expect(put).toBeDefined();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
      config: edited,
    });
  });
  expect(await screen.findByText('Saved')).toBeInTheDocument();
});

test('saving the stream editor PUTs the edited layout and reports immediate apply', async () => {
  renderWithClient(<SettingsScreen />);
  const editor = (await screen.findByLabelText(
    'stream config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"/cam/a"'));

  const edited = { columns: 3, panes: [{ topic: '/cam/a' }] };
  fireEvent.change(editor, { target: { value: JSON.stringify(edited, null, 2) } });
  fireEvent.click(screen.getByTestId('stream-config-save'));

  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const put = calls.find(
      (c) =>
        String(c[0]).includes('/config/stream') &&
        ((c[1] as RequestInit)?.method ?? 'GET') === 'PUT',
    );
    expect(put).toBeDefined();
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
      config: edited,
    });
  });
  // The saved note states the immediate apply (no restart caveat — honest:
  // the layout is served per-request by GET /api/v1/config).
  expect(await screen.findByTestId('stream-saved-note')).toHaveTextContent(
    /applies immediately/i,
  );
});

test('invalid JSON in the stream editor disables Save before the server sees it', async () => {
  renderWithClient(<SettingsScreen />);
  const editor = (await screen.findByLabelText(
    'stream config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"/cam/a"'));

  fireEvent.change(editor, { target: { value: '{ not json' } });
  expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
  expect(screen.getByTestId('stream-config-save')).toBeDisabled();
  // No PUT went out.
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const put = calls.find(
    (c) =>
      String(c[0]).includes('/config/stream') &&
      ((c[1] as RequestInit)?.method ?? 'GET') === 'PUT',
  );
  expect(put).toBeUndefined();
});

test('a robot without a config dir gets an explanation, not an editor', async () => {
  streamPayload = { config: null, path: null, error: null };
  renderWithClient(<SettingsScreen />);
  expect(await screen.findByTestId('stream-config-absent')).toHaveTextContent(
    /has no stream config to edit/i,
  );
  expect(screen.queryByLabelText('stream config json')).not.toBeInTheDocument();
});

test('a present-but-broken stream file is disclosed before a save can replace it', async () => {
  streamPayload = {
    config: null,
    path: '/config/airoa_hsr/stream/default.yaml',
    error: 'Stream config is not valid YAML: mapping values are not allowed here',
  };
  renderWithClient(<SettingsScreen />);
  const warning = await screen.findByTestId('stream-load-error');
  expect(warning).toHaveTextContent(/exists but failed to load/i);
  expect(warning).toHaveTextContent(/saving REPLACES the broken file/i);
  // The editor stays usable as the recovery path, seeded empty.
  const editor = (await screen.findByLabelText(
    'stream config json',
  )) as HTMLTextAreaElement;
  expect(editor.value).toBe('{}');
});

test('the read-only robot view explains an absent stream config', async () => {
  renderWithClient(<SettingsScreen />);
  // Preview the non-active `template` robot (aspects.stream is null there).
  fireEvent.click(await screen.findByTestId('robot-row-1'));
  await screen.findByTestId('robot-readonly-banner');
  expect(await screen.findByText(/has no stream config/i)).toBeInTheDocument();
  expect(screen.queryByTestId('robot-readonly-stream-config')).not.toBeInTheDocument();
});

test('menu switches Robots → Plans → Recording (real, not a placeholder) → back', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  expect(screen.getByTestId('plan-projects')).toBeInTheDocument();
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent(
    'Tabletop Manipulation',
  );

  // Recording is now a real form-first section, not a §12 placeholder.
  fireEvent.click(screen.getByTestId('settings-menu-item-5'));
  expect(screen.getByTestId('settings-recording')).toBeInTheDocument();
  expect(screen.queryByTestId('settings-other-placeholder')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('settings-menu-item-0'));
  expect(screen.getByTestId('robot-form')).toBeInTheDocument();
});

test('External controls exposes only state-safe actions and persists a rearrangement', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-3'));

  const readyLeft = screen.getByTestId('ext-control-ready-left');
  expect(within(readyLeft).getByRole('option', { name: 'Start' })).toBeInTheDocument();
  expect(within(readyLeft).queryByRole('option', { name: 'Retake' })).toBeNull();

  const resultCenter = screen.getByTestId('ext-control-result-center');
  expect(within(resultCenter).getByRole('option', { name: 'Failure' })).toBeDisabled();
  fireEvent.change(resultCenter, { target: { value: 'none' } });

  await waitFor(() =>
    expect(getExternalControls().result).toEqual({
      left: 'failure',
      center: 'none',
      right: 'success_save',
    }),
  );
  await waitFor(() => {
    const bodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(
        (call) =>
          String(call[0]).includes('/plans') &&
          ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'PUT',
      )
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies.some((body) => body.external_controls.result.center === 'none')).toBe(
      true,
    );
  });

  fireEvent.click(screen.getByTestId('ext-controls-reset'));
  expect(getExternalControls()).toEqual(DEFAULT_EXTERNAL_CONTROLS);
  expect(await screen.findByTestId('ext-controls-toast')).toHaveTextContent(
    /reset to the default layout/i,
  );
});

test('External controls explains recovery when stored mapping is invalid', async () => {
  window.localStorage.setItem(
    'kairos.v2.external-controls.v1',
    JSON.stringify({ schema_version: 1, ready: { left: 'retake' } }),
  );
  __rehydratePlansStore();
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-3'));

  const warning = screen.getByTestId('ext-controls-invalid');
  expect(warning).toHaveTextContent(/default layout is active/i);
  expect(warning).toHaveTextContent(/Change any channel/i);
  expect(screen.getByTestId('ext-control-ready-center')).toHaveValue('start');
});

test('only Dataset profiles + Users & permissions stay honest placeholders', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('settings-menu-item-8'));
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(
    'Dataset profiles',
  );
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(
    /Phase 3 recipe/,
  );

  fireEvent.click(screen.getByTestId('settings-menu-item-9'));
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(
    'Users & permissions',
  );
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(
    /single-team/,
  );
});

test('Plans: adding and removing a task updates the task list and condition count', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('New Task');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Tabletop Manipulation starts with 2 tasks (Pick and Place, Stacking).
  expect(screen.getByTestId('plan-project-0')).toHaveTextContent('2 tasks');

  fireEvent.click(screen.getByText('+ Add task'));
  expect(promptSpy).toHaveBeenCalled();
  expect(screen.getByTestId('plan-project-0')).toHaveTextContent('3 tasks');
  expect(screen.getByTestId('plan-task-2')).toHaveTextContent('New Task');

  fireEvent.click(within(screen.getByTestId('plan-task-2')).getByTitle('Remove task'));
  expect(screen.getByTestId('plan-project-0')).toHaveTextContent('2 tasks');
});

test('Plans: adding and removing a condition updates the condition count', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const promptSpy = vi
    .spyOn(window, 'prompt')
    .mockReturnValue('Object: Top → Tray: Left');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // "Pick and Place" (task 0) starts with 3 conditions.
  expect(screen.getByTestId('plan-task-0')).toHaveTextContent('3 cond');

  fireEvent.click(screen.getByText('+ Add condition'));
  expect(promptSpy).toHaveBeenCalled();
  expect(screen.getByTestId('plan-task-0')).toHaveTextContent('4 cond');
  expect(screen.getByTestId('plan-condition-3')).toHaveTextContent(
    'Object: Top → Tray: Left',
  );

  fireEvent.click(
    within(screen.getByTestId('plan-condition-3')).getByTitle('Remove condition'),
  );
  expect(screen.getByTestId('plan-task-0')).toHaveTextContent('3 cond');
});

test('Plans: adding a project writes the SHARED store (so Collect sees it)', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('Warehouse Sort');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  fireEvent.click(screen.getByText('+ Add project'));

  // The UI shows it AND it landed in the shared store (what Collect reads).
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Warehouse Sort');
  expect(getPlans().some((p) => p.name === 'Warehouse Sort')).toBe(true);
});

test('Plans: removing a project (confirmed) drops it from the list and the shared store', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Default catalog has three projects; remove "Bin Picking" (row 1).
  expect(
    within(screen.getByTestId('plan-project-1')).getByText('Bin Picking'),
  ).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByTestId('plan-project-1')).getByTitle('Remove project'),
  );

  // Gone from the list AND from the shared store the Collect pickers read.
  expect(screen.queryByText('Bin Picking')).not.toBeInTheDocument();
  expect(getPlans().some((p) => p.name === 'Bin Picking')).toBe(false);
});

test('Plans: cancelling the remove confirmation keeps the project', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  fireEvent.click(
    within(screen.getByTestId('plan-project-1')).getByTitle('Remove project'),
  );

  expect(
    within(screen.getByTestId('plan-project-1')).getByText('Bin Picking'),
  ).toBeInTheDocument();
  expect(getPlans().some((p) => p.name === 'Bin Picking')).toBe(true);
});

test('Failure reasons: adding and removing writes the SHARED store (so Collect sees it)', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('Cable snagged');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-2'));

  // Seed vocabulary renders (6 defaults), then the added reason appears and
  // lands in the shared store Collect's "What failed?" chips read.
  expect(screen.getByTestId('settings-fail-reasons')).toBeInTheDocument();
  expect(screen.getByTestId('fail-reason-0')).toHaveTextContent('Grasp missed');
  fireEvent.click(screen.getByTestId('fail-reason-add'));
  expect(screen.getByTestId('fail-reason-6')).toHaveTextContent('Cable snagged');
  expect(getFailReasons()).toContain('Cable snagged');

  fireEvent.click(
    within(screen.getByTestId('fail-reason-6')).getByTitle('Remove reason'),
  );
  expect(screen.queryByText('Cable snagged')).not.toBeInTheDocument();
  expect(getFailReasons()).not.toContain('Cable snagged');
});

test('Failure reasons: renaming replaces the entry in place', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('Grasp slipped');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-2'));

  fireEvent.click(within(screen.getByTestId('fail-reason-0')).getByTitle('Rename'));
  expect(screen.getByTestId('fail-reason-0')).toHaveTextContent('Grasp slipped');
  expect(getFailReasons()[0]).toBe('Grasp slipped');
  expect(getFailReasons()).not.toContain('Grasp missed');
});

test('Failure reasons: the last remaining reason cannot be removed', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-2'));

  // Remove all but one — the final ✕ is disabled (a Failure REQUIRES a reason).
  for (let i = 0; i < 5; i += 1) {
    fireEvent.click(
      within(screen.getByTestId('fail-reason-0')).getByTitle('Remove reason'),
    );
  }
  expect(getFailReasons()).toHaveLength(1);
  const last = within(screen.getByTestId('fail-reason-0')).getByTitle(
    /last reason cannot be removed/,
  );
  expect(last).toBeDisabled();
  fireEvent.click(last);
  expect(getFailReasons()).toHaveLength(1);
});

test('Plans: the last project cannot be removed (honest note, no confirm dialog)', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  setPlans([
    { name: 'Only Project', tasks: [{ name: 'Only Task', conditions: ['Only Cond'] }] },
  ]);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  fireEvent.click(
    within(screen.getByTestId('plan-project-0')).getByTitle('Remove project'),
  );

  // Blocked before any confirm dialog; the project survives and we say why.
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(getPlans().map((p) => p.name)).toEqual(['Only Project']);
  expect(screen.getByTestId('settings-toast')).toHaveTextContent(
    /Keep at least one project/i,
  );
});

test('Plans: removing the selected project falls back to a surviving one (no crash)', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Tabletop Manipulation (row 0) is the default selection; remove it.
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent(
    'Tabletop Manipulation',
  );
  fireEvent.click(
    within(screen.getByTestId('plan-project-0')).getByTitle('Remove project'),
  );

  // The detail panel shows the neighbour that slid into slot 0 — no crash.
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Bin Picking');
  expect(getPlans().some((p) => p.name === 'Tabletop Manipulation')).toBe(false);
});

// ---------------------------------------------------------------------------
// Per-task failure-reason shortcuts (#35): the Settings editor for the three
// LEFT / CENTER / RIGHT slots, the duplicate prevention, and the rename/delete
// integrity rules (a shortcut must never silently point at a stale label).
// ---------------------------------------------------------------------------

function openPlansSection() {
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
}
function openTaskShortcuts() {
  openPlansSection();
  // The first task of the first project is the default selection; clicking its
  // NAME (the row's selector — the same pattern the selection-lost tests use)
  // keeps the selection explicit (and re-arms the editor after a task swap).
  // Clicking the row's padding does nothing.
  fireEvent.click(
    within(screen.getByTestId('plan-task-0')).getByText('Pick and Place'),
  );
  return screen.getByTestId('plan-task-shortcuts');
}
function shortcutSelect(slot: 'left' | 'center' | 'right') {
  return screen.getByTestId(`plan-task-shortcut-${slot}`) as HTMLSelectElement;
}
function setShortcut(slot: 'left' | 'center' | 'right', reason: string | null) {
  fireEvent.change(shortcutSelect(slot), { target: { value: reason ?? '' } });
}
function selectedTaskShortcuts() {
  return getPlans().find((p) => p.name === 'Tabletop Manipulation')!.tasks[0]!
    .failure_shortcuts;
}

test('Plans: the shortcut editor offers the shared vocabulary and writes the shared store', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  openTaskShortcuts();

  expect(screen.getByTestId('plan-task-shortcut-slot-left')).toHaveTextContent('LEFT');
  expect(screen.getByTestId('plan-task-shortcut-slot-center')).toHaveTextContent(
    'CENTER',
  );
  expect(screen.getByTestId('plan-task-shortcut-slot-right')).toHaveTextContent(
    'RIGHT',
  );
  // Unassigned by default; the options are the shared failure-reason vocabulary.
  expect(shortcutSelect('left')).toHaveValue('');
  expect(screen.getByTestId('plan-task-shortcuts')).toHaveTextContent(
    new RegExp(getFailReasons()[0]!),
  );

  setShortcut('left', 'Grasp missed');
  expect(selectedTaskShortcuts().left).toBe('Grasp missed');
  // The same reason is offered to no other slot of THIS task (one reason,
  // one slot — the server would reject a duplicate too).
  const centerOptions = Array.from(
    shortcutSelect('center').querySelectorAll('option'),
  ) as HTMLOptionElement[];
  const centerGrasp = centerOptions.find((o) => o.value === 'Grasp missed');
  expect(centerGrasp?.disabled).toBe(true);
  // A different reason is still assignable to the other slot.
  setShortcut('center', 'Object dropped');
  expect(selectedTaskShortcuts()).toMatchObject({
    left: 'Grasp missed',
    center: 'Object dropped',
    right: null,
  });

  // Unassigning clears the slot.
  setShortcut('left', null);
  expect(selectedTaskShortcuts().left).toBeNull();
});

test('Plans: a task switch shows that task own shortcuts', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  openTaskShortcuts();
  setShortcut('left', 'Grasp missed');

  // Stacking (the second task) starts unassigned — each task maps its own.
  // The task NAME button is the selector (a click on the row's padding is a
  // no-op), exactly like the existing selection tests click 'B1'/'B2'.
  fireEvent.click(within(screen.getByTestId('plan-task-1')).getByText('Stacking'));
  await waitFor(() => expect(shortcutSelect('left')).toHaveValue(''));
  expect(selectedTaskShortcuts().left).toBe('Grasp missed'); // first task untouched

  // …and switching back restores the first task's assignment.
  fireEvent.click(
    within(screen.getByTestId('plan-task-0')).getByText('Pick and Place'),
  );
  await waitFor(() => expect(shortcutSelect('left')).toHaveValue('Grasp missed'));
});

test('Plans: renaming a referenced reason follows the shortcut to the new name', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('Grasp slipped');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  openTaskShortcuts();
  setShortcut('left', 'Grasp missed');

  // Rename the reason in its own section — the slot must not go stale.
  fireEvent.click(screen.getByTestId('settings-menu-item-2'));
  fireEvent.click(within(screen.getByTestId('fail-reason-0')).getByTitle('Rename'));
  expect(getFailReasons()[0]).toBe('Grasp slipped');

  openTaskShortcuts();
  await waitFor(() => expect(selectedTaskShortcuts().left).toBe('Grasp slipped'));
});

test('Plans: removing a referenced reason clears its slot and says so', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  openTaskShortcuts();
  setShortcut('center', 'Object dropped');

  fireEvent.click(screen.getByTestId('settings-menu-item-2'));
  // 'Object dropped' is fail-reason-1 in the default vocabulary.
  fireEvent.click(
    within(screen.getByTestId('fail-reason-1')).getByTitle('Remove reason'),
  );
  expect(getFailReasons()).not.toContain('Object dropped');

  openTaskShortcuts();
  await waitFor(() => expect(selectedTaskShortcuts().center).toBeNull());
  expect(screen.getByTestId('settings-toast')).toHaveTextContent(/unassigned/i);
});

// ---------------------------------------------------------------------------
// An EMPTIED shared catalog. `PUT /api/v1/plans {"projects": []}` is accepted
// and served back as an explicitly-emptied catalog (routers/plans.py), and this
// browser adopts it as-is rather than resurrecting the seeds (plans.ts
// adoptServerPlans, pinned by plans.test.ts). This editor blocks removing the
// LAST project locally, but that does nothing about a catalog emptied from
// another terminal — so Settings has to survive it.
//
// These tests mount the REAL root ErrorBoundary from main.tsx so a render throw
// surfaces as its recovery card instead of being invisible, and they assert on
// the boundary directly (the vitest equivalent of Playwright's `pageerror`)
// rather than merely looking for some text that happens to be present.
// ---------------------------------------------------------------------------

const EMPTY_SERVER_CATALOG = {
  projects: [],
  failure_reasons: ['Grasp missed'],
  operators: [],
  updated_at: 't0',
};

/** Mount Settings under the root ErrorBoundary, capturing what it logs. */
function renderGuarded() {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  renderWithClient(
    <ErrorBoundary>
      <SettingsScreen />
    </ErrorBoundary>,
  );
  return errorSpy;
}

/** Assert nothing reached the root boundary: neither its recovery card nor the
 *  componentDidCatch log. Reports the thrown message when it did. */
function expectNoRenderCrash(errorSpy: ReturnType<typeof vi.spyOn>) {
  const caught = errorSpy.mock.calls
    .filter((c) => String(c[0]).includes('Unhandled UI error'))
    .map((c) => String((c[1] as Error | undefined)?.message ?? c[1]));
  expect(caught).toEqual([]);
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
}

test('Plans: a catalog emptied elsewhere does not white-screen Settings', async () => {
  serverPlans = EMPTY_SERVER_CATALOG;
  const errorSpy = renderGuarded();

  // The adopt lands after GET /plans resolves, i.e. while Settings is mounted.
  await waitFor(() => expect(getPlans()).toEqual([]));
  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-0')).toBeInTheDocument(),
  );

  // The cursor clamp lives in useSettingsState, which SettingsScreen calls for
  // EVERY section — so the whole screen died, not just Projects & tasks. Robots
  // is the default section and has to still be there.
  expectNoRenderCrash(errorSpy);
  expect(await screen.findByTestId('robot-form')).toBeInTheDocument();
});

test('Plans: an empty catalog renders an empty state that seeds the first project', async () => {
  serverPlans = EMPTY_SERVER_CATALOG;
  vi.spyOn(window, 'prompt').mockReturnValue('First Project');
  const errorSpy = renderGuarded();

  await waitFor(() => expect(getPlans()).toEqual([]));
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // An honest empty state — no crash, and no fabricated project name standing
  // in for a project that does not exist.
  expectNoRenderCrash(errorSpy);
  expect(screen.getByTestId('plan-empty')).toHaveTextContent(/no projects/i);
  expect(screen.queryByTestId('plan-project-name')).not.toBeInTheDocument();

  // Its affordance actually seeds the catalog (and the shared store Collect reads).
  fireEvent.click(screen.getByTestId('plan-add-first'));
  expect(getPlans().map((p) => p.name)).toEqual(['First Project']);
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('First Project');
  expect(screen.queryByTestId('plan-empty')).not.toBeInTheDocument();
  expectNoRenderCrash(errorSpy);
});

test('Plans: an empty catalog leaves the other settings sections usable', async () => {
  serverPlans = EMPTY_SERVER_CATALOG;
  const errorSpy = renderGuarded();
  await waitFor(() => expect(getPlans()).toEqual([]));

  // Walk the sections that read the same hook — none of them owns a project.
  fireEvent.click(screen.getByTestId('settings-menu-item-2')); // Failure reasons
  expect(screen.getByTestId('settings-fail-reasons')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('settings-menu-item-3')); // External controls
  expect(screen.getByTestId('settings-ext-controls')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('settings-menu-item-4')); // Operators
  expect(screen.getByTestId('settings-operators')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('settings-menu-item-10')); // System
  expectNoRenderCrash(errorSpy);
});

test('Plans: a PARTIAL shrink never leaves an enabled control that does nothing', async () => {
  // The project survives but its task list shortens under a non-zero cursor.
  // The view derived `disabled` from the CLAMPED task index while the handlers
  // read the RAW one, so "+ Add condition" was enabled and silently did
  // nothing. Handlers and view now share one clamped cursor per render, so the
  // control is either correct or disabled — never enabled and inert.
  const gate = holdPlansResponse();
  serverPlans = {
    projects: [
      { name: 'Alpha', tasks: [{ name: 'A1', conditions: ['a'] }] },
      { name: 'Beta', tasks: [{ name: 'B1', conditions: ['x'] }] }, // B2 is gone
    ],
    failure_reasons: ['Grasp missed'],
    operators: [],
    updated_at: 't0',
  };
  window.localStorage.setItem(
    'kairos.v2.plans.v1',
    JSON.stringify([
      { name: 'Alpha', tasks: [{ name: 'A1', conditions: ['a'] }] },
      {
        name: 'Beta',
        tasks: [
          { name: 'B1', conditions: ['x'] },
          { name: 'B2', conditions: ['y', 'z'] },
        ],
      },
    ]),
  );
  __rehydratePlansStore();
  vi.spyOn(window, 'prompt').mockReturnValue('added condition');

  const errorSpy = renderGuarded();
  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-1')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  fireEvent.click(within(screen.getByTestId('plan-project-1')).getByText('Beta'));
  fireEvent.click(within(screen.getByTestId('plan-task-1')).getByText('B2'));
  expect(screen.getByTestId('plan-condition-1')).toHaveTextContent('z');

  // B2 disappears from under the cursor.
  gate.release();
  await waitFor(() =>
    expect(screen.queryByTestId('plan-task-1')).not.toBeInTheDocument(),
  );
  expectNoRenderCrash(errorSpy);

  // The selection the operator made is gone, so the controls that act on "the
  // selected task" do not act on the substitute behind their back.
  expect(screen.getByTestId('plan-task-selection-lost')).toHaveTextContent('B1');
  const addCondition = screen.getByText('+ Add condition');
  expect(addCondition).toBeDisabled();
  fireEvent.click(addCondition);
  expect(
    getPlans()[1]!.tasks[0]!.conditions.map((condition) => condition.name),
  ).toEqual(['x']); // nothing added

  // Re-confirming by picking a task restores the control, and it WORKS.
  fireEvent.click(within(screen.getByTestId('plan-task-0')).getByText('B1'));
  expect(screen.queryByTestId('plan-task-selection-lost')).not.toBeInTheDocument();
  expect(screen.getByText('+ Add condition')).toBeEnabled();
  fireEvent.click(screen.getByText('+ Add condition'));
  expect(
    getPlans()[1]!.tasks[0]!.conditions.map((condition) => condition.name),
  ).toEqual(['x', 'added condition']);
  expectNoRenderCrash(errorSpy);
});

test('Settings survives a browser where localStorage access throws', async () => {
  // Private mode / storage blocked by policy: access THROWS instead of
  // returning null. The plans store touches storage on read AND on every edit,
  // and it is imported by the whole console — measured here at the screen
  // level, under the real root boundary, because the blast radius of a throw in
  // a hook or an effect is the entire app, not this tab.
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
  vi.spyOn(window, 'prompt').mockReturnValue('Storage-less project');
  const errorSpy = renderGuarded();

  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-1')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Editing still works for the session; it just cannot be persisted.
  fireEvent.click(screen.getByText('+ Add project'));
  expect(getPlans().some((p) => p.name === 'Storage-less project')).toBe(true);
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent(
    'Storage-less project',
  );

  fireEvent.click(screen.getByTestId('settings-menu-item-2')); // Failure reasons
  fireEvent.click(screen.getByTestId('fail-reason-add'));
  expectNoRenderCrash(errorSpy);
});

test('Plans: the catalog empties WHILE the operator is in the detail editor', async () => {
  // The other empty-catalog tests adopt before the editor is on screen, so the
  // cursors are clamped on their FIRST render. This is the other path: both
  // cursors are already non-zero, pointing into a populated catalog, when the
  // shorter one arrives — a stale index surviving in state rather than one
  // computed against the new list.
  const gate = holdPlansResponse();
  serverPlans = EMPTY_SERVER_CATALOG;
  // Restore a catalog from a previous session (NOT setPlans, which would mark
  // the browser dirty and make the reconcile push instead of adopt).
  window.localStorage.setItem(
    'kairos.v2.plans.v1',
    JSON.stringify([
      { name: 'Alpha', tasks: [{ name: 'A1', conditions: ['a'] }] },
      {
        name: 'Beta',
        tasks: [
          { name: 'B1', conditions: ['x'] },
          { name: 'B2', conditions: ['y', 'z'] },
        ],
      },
    ]),
  );
  __rehydratePlansStore();

  const errorSpy = renderGuarded();
  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-1')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Put BOTH cursors off zero: project 1, task 1 (its second condition proves it).
  fireEvent.click(within(screen.getByTestId('plan-project-1')).getByText('Beta'));
  fireEvent.click(within(screen.getByTestId('plan-task-1')).getByText('B2'));
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Beta');
  expect(screen.getByTestId('plan-condition-1')).toHaveTextContent('z');

  // The colleague's emptied catalog lands underneath the populated view.
  gate.release();
  await waitFor(() => expect(getPlans()).toEqual([]));

  await waitFor(() => expect(screen.getByTestId('plan-empty')).toBeInTheDocument());
  expectNoRenderCrash(errorSpy);
  expect(screen.queryByTestId('plan-project-name')).not.toBeInTheDocument();
  expect(screen.queryByTestId('plan-task-1')).not.toBeInTheDocument();
  expect(screen.getByTestId('plan-add-first')).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Robot switch. alerts.yaml is PER ROBOT (config/<robot>/monitoring/alerts.yaml)
// but its query key was the global ['config','alerts'], and neither switcher
// (Settings > Robots, or Collect's ContextBar) invalidates it — they refresh
// runtimeConfig + RECORDING_CONFIG_KEY only. So the cache handed back the
// PREVIOUS robot's rules, and its file path, under the new robot. A Save in
// that window PUTs those rules to /config/alerts, which the server resolves to
// the ACTIVE robot's file — robot A's rules written into robot B's alerts.yaml.
//
// HOW LONG that window lasts differs between here and production, and the test
// must not be read as claiming more than it shows: this client sets
// staleTime: Infinity (see renderWithClient), so the stale entry is served
// indefinitely and the cross-robot hit is deterministic to assert. Production
// leaves staleTime at 0, so the remount also fires a background refetch and the
// display self-corrects after one round trip. The bug is the window, not
// permanence. Keying the cache by robot removes it either way, because there is
// then no other robot's entry to serve.
// ---------------------------------------------------------------------------

test('Data quality: alert rules follow the ACTIVE robot across a switch', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  // Data quality shows airoa_hsr's rule, from airoa_hsr's file.
  fireEvent.click(screen.getByTestId('settings-menu-item-6'));
  await waitFor(() =>
    expect(screen.getByLabelText('rule topic 0')).toHaveValue(
      '/airoa_hsr/joint_states',
    ),
  );

  // Switch the active robot from the Robots section.
  fireEvent.click(screen.getByTestId('settings-menu-item-0'));
  fireEvent.click(await screen.findByTestId('robot-row-1'));
  fireEvent.click(screen.getByTestId('activate-robot'));
  await waitFor(() =>
    expect(selectPosts()).toContainEqual({ category: 'robot', id: 'template' }),
  );

  // Back to Data quality: the previous robot's rules must never be on screen
  // under the new robot — not even for the moment before a refetch lands, since
  // Save in that window would write them into the new robot's file.
  fireEvent.click(screen.getByTestId('settings-menu-item-6'));
  expect(screen.queryByDisplayValue('/airoa_hsr/joint_states')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByLabelText('rule topic 0')).toHaveValue('/template/joint_states'),
  );
});

// ---------------------------------------------------------------------------
// E-34: a catalog edit that never reached the server. The push is best-effort
// and its failure was caught and dropped, so the operator got "Project added"
// and nothing else — while the shared catalog every other terminal reads was
// unchanged. The local copy standing is the right BEHAVIOUR; claiming a save
// that did not happen is not.
// ---------------------------------------------------------------------------

test('an edit that could not reach the server says so', async () => {
  serverPlans = {
    projects: null,
    failure_reasons: null,
    operators: null,
    updated_at: null,
  };
  plansPutFails = true;
  vi.spyOn(window, 'prompt').mockReturnValue('Warehouse Sort');
  renderGuarded();

  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-1')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  fireEvent.click(screen.getByText('+ Add project'));

  // The edit applies locally — that part is deliberate and stays.
  expect(getPlans().some((p) => p.name === 'Warehouse Sort')).toBe(true);
  // …and the operator is told it is local-only, rather than being left to
  // assume every terminal now offers this project.
  const note = await screen.findByTestId('plans-unsynced');
  expect(note).toHaveTextContent(/this browser/i);
});

test('a catalog edit that DOES reach the server raises no such note', async () => {
  serverPlans = {
    projects: null,
    failure_reasons: null,
    operators: null,
    updated_at: null,
  };
  vi.spyOn(window, 'prompt').mockReturnValue('Warehouse Sort');
  renderGuarded();

  await waitFor(() =>
    expect(screen.getByTestId('settings-menu-item-1')).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  fireEvent.click(screen.getByText('+ Add project'));

  await waitFor(() =>
    expect(getPlans().some((p) => p.name === 'Warehouse Sort')).toBe(true),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByTestId('plans-unsynced')).not.toBeInTheDocument();
});

// #14 — heading structure. This screen must title itself exactly once and
// descend one heading level at a time, so a screen-reader user can navigate it
// by heading instead of reading it as one flat run of text.
test('titles itself with a single h1 and skips no heading level', async () => {
  renderWithClient(<SettingsScreen />);
  await expectScreenHeadingOutline('Settings');
}, 20000);
