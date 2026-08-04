import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SettingsScreen } from './SettingsScreen';
import { __resetPlansStore, getFailReasons, getPlans, setPlans } from '../plans';

// Runtime config (GET /api/v1/config): the ACTIVE robot's read-only values that
// the Robots form surfaces (ROS_DOMAIN_ID + recorded topics).
const CONFIG_WITH_ROBOT = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
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
        { id: 'default', path: '/config/airoa_hsr/recording/default.yaml', local: false, meta: { default_topics: 7 } },
      ],
    },
    stream: {
      active: 'default',
      options: [
        { id: 'default', path: '/config/airoa_hsr/stream/default.yaml', local: false, meta: { columns: 2, panes: 2 } },
      ],
    },
    validation: {
      active: 'default',
      options: [
        { id: 'default', path: '/config/airoa_hsr/validation/default.yaml', local: false, meta: { name: 'airoa_hsr', version: 1, required_topics: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }] } },
        { id: 'strict', path: '/config/airoa_hsr/validation/strict.yaml', local: false, meta: { name: 'strict', version: 2, required_topics: [{ name: '/a' }] } },
      ],
    },
    validators: {
      active: 'loss_report',
      options: [
        { id: 'loss_report', path: '/config/airoa_hsr/validators/loss_report.yaml', local: false, meta: {} },
      ],
    },
  },
};

const RECORDING = {
  config: { robot_name: 'hsr', default_topics: ['/hsrb/odom'], expected_hz_patterns: [] },
  path: '/config/airoa_hsr/recording/default.yaml',
};

// GET /api/v1/config/robots/{robot} — read-only view of a non-active robot.
const ROBOT_CONFIG_TEMPLATE = {
  robot: 'template',
  local: false,
  active: false,
  summary: { robot_name: 'template', default_topics: ['/tmpl/a', '/tmpl/b'], ros_domain_id: null },
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

// The recorder state served by GET /record/status; tests flip it to exercise the
// recording-aware guards.
let recordState: 'created' | 'recording' = 'created';
// Whether that response carries `live_capture_ids` at all. §10 rev.2.4: a
// response without it is an unreachable recorder, not an idle one — a distinct
// case the guards have to handle, so it is switchable here.
let liveReported = true;

/** Build the /config/select echo: active follows the posted selection. */
function echoSelect(body: { category: string; id: string }) {
  const next = structuredClone(OPTIONS);
  if (body.category === 'robot') {
    next.active_robot = body.id;
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
      return Promise.resolve(jsonResponse(OPTIONS));
    }
    if (url.includes('/config/recording')) {
      if (method === 'PUT') {
        const body = JSON.parse(String((init as RequestInit).body));
        return Promise.resolve(jsonResponse({ config: body.config, path: RECORDING.path }));
      }
      return Promise.resolve(jsonResponse(RECORDING));
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
  recordState = 'created';
  liveReported = true;
  // Plans live in the shared v2/plans store now; reset it so a project added in
  // one test can't leak into the next.
  __resetPlansStore();
  mockFetch();
});
afterEach(() => vi.restoreAllMocks());

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

test('the active robot form shows real read-only runtime values + the recording editor', async () => {
  renderWithClient(<SettingsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('robot-form-name')).toHaveTextContent('airoa_hsr'),
  );
  expect(screen.getByTestId('robot-topics-summary')).toHaveTextContent('3 recorded topics');
  const chips = screen.getByTestId('robot-topic-chips');
  expect(within(chips).getByText('/tf')).toBeInTheDocument();
  expect(within(chips).getByText('/camera/top/image_raw')).toBeInTheDocument();

  // The embedded ConfigTab RecordingConfigEditor, seeded from GET /config/recording.
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
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
  const validation = (await screen.findByLabelText('validation option')) as HTMLSelectElement;
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
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));

  const edited = { robot_name: 'tiago', default_topics: ['/a'], expected_hz_patterns: [] };
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
    expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ config: edited });
  });
  expect(await screen.findByText('Saved')).toBeInTheDocument();
});

test('menu switches Robots → Plans → Recording (real, not a placeholder) → back', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  expect(screen.getByTestId('plan-projects')).toBeInTheDocument();
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Tabletop Manipulation');

  // Recording is now a real form-first section, not a §12 placeholder.
  fireEvent.click(screen.getByTestId('settings-menu-item-4'));
  expect(screen.getByTestId('settings-recording')).toBeInTheDocument();
  expect(screen.queryByTestId('settings-other-placeholder')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('settings-menu-item-0'));
  expect(screen.getByTestId('robot-form')).toBeInTheDocument();
});

test('only Dataset profiles + Users & permissions stay honest placeholders', async () => {
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('settings-menu-item-7'));
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent('Dataset profiles');
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(/Phase 3 recipe/);

  fireEvent.click(screen.getByTestId('settings-menu-item-8'));
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent('Users & permissions');
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent(/single-team/);
});

test('Plans: adding and removing a task updates the task list and condition count', async () => {
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
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Object: Top → Tray: Left');
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // "Pick and Place" (task 0) starts with 3 conditions.
  expect(screen.getByTestId('plan-task-0')).toHaveTextContent('3 cond');

  fireEvent.click(screen.getByText('+ Add condition'));
  expect(promptSpy).toHaveBeenCalled();
  expect(screen.getByTestId('plan-task-0')).toHaveTextContent('4 cond');
  expect(screen.getByTestId('plan-condition-3')).toHaveTextContent('Object: Top → Tray: Left');

  fireEvent.click(within(screen.getByTestId('plan-condition-3')).getByTitle('Remove condition'));
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
  expect(within(screen.getByTestId('plan-project-1')).getByText('Bin Picking')).toBeInTheDocument();
  fireEvent.click(within(screen.getByTestId('plan-project-1')).getByTitle('Remove project'));

  // Gone from the list AND from the shared store the Collect pickers read.
  expect(screen.queryByText('Bin Picking')).not.toBeInTheDocument();
  expect(getPlans().some((p) => p.name === 'Bin Picking')).toBe(false);
});

test('Plans: cancelling the remove confirmation keeps the project', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  fireEvent.click(within(screen.getByTestId('plan-project-1')).getByTitle('Remove project'));

  expect(within(screen.getByTestId('plan-project-1')).getByText('Bin Picking')).toBeInTheDocument();
  expect(getPlans().some((p) => p.name === 'Bin Picking')).toBe(true);
});

test('Failure reasons: adding and removing writes the SHARED store (so Collect sees it)', async () => {
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

  fireEvent.click(within(screen.getByTestId('fail-reason-6')).getByTitle('Remove reason'));
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
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-2'));

  // Remove all but one — the final ✕ is disabled (a Failure REQUIRES a reason).
  for (let i = 0; i < 5; i += 1) {
    fireEvent.click(within(screen.getByTestId('fail-reason-0')).getByTitle('Remove reason'));
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
  setPlans([{ name: 'Only Project', tasks: [{ name: 'Only Task', conditions: ['Only Cond'] }] }]);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  fireEvent.click(within(screen.getByTestId('plan-project-0')).getByTitle('Remove project'));

  // Blocked before any confirm dialog; the project survives and we say why.
  expect(confirmSpy).not.toHaveBeenCalled();
  expect(getPlans().map((p) => p.name)).toEqual(['Only Project']);
  expect(screen.getByTestId('settings-toast')).toHaveTextContent(/Keep at least one project/i);
});

test('Plans: removing the selected project falls back to a surviving one (no crash)', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('settings-menu-item-1'));

  // Tabletop Manipulation (row 0) is the default selection; remove it.
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Tabletop Manipulation');
  fireEvent.click(within(screen.getByTestId('plan-project-0')).getByTitle('Remove project'));

  // The detail panel shows the neighbour that slid into slot 0 — no crash.
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Bin Picking');
  expect(getPlans().some((p) => p.name === 'Tabletop Manipulation')).toBe(false);
});
