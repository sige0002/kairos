import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { ConfigTab } from './ConfigTab';
import type { RuntimeConfig } from '../../config';

const CONFIG = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: { robot_name: 'hsr', default_topics: ['/hsrb/odom'] },
  schemas: {},
} as RuntimeConfig;

// Robot-first options: active robot airoa_hsr, a committed `template`, a local
// `myrobot`; per-aspect options for the active robot.
const OPTIONS = {
  active_robot: 'airoa_hsr',
  robots: [
    { id: 'airoa_hsr', local: false },
    { id: 'template', local: false },
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
        { id: 'default', path: '/config/airoa_hsr/stream/default.yaml', local: false, meta: { columns: 2, panes: 1 } },
      ],
    },
    validation: {
      active: 'default',
      options: [
        {
          id: 'default',
          path: '/config/airoa_hsr/validation/default.yaml',
          local: false,
          meta: { name: 'airoa_hsr', version: 1, required_topics: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }] },
        },
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

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
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
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse(OPTIONS));
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('renders robots and marks the active one', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  const active = await screen.findByLabelText('robot airoa_hsr');
  expect(active).toHaveAttribute('aria-pressed', 'true');
  // The local robot is labelled.
  expect(screen.getByLabelText('robot myrobot')).toBeInTheDocument();
});

test('selecting a robot posts {category: robot}', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  fireEvent.click(await screen.findByLabelText('robot template'));
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sel = calls.find((c) => String(c[0]).includes('/config/select'));
    expect(sel).toBeDefined();
    expect(JSON.parse(String((sel![1] as RequestInit).body))).toEqual({
      category: 'robot',
      id: 'template',
    });
  });
});

test('Validation aspect lists options and shows required topics', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Validation' }));
  const select = (await screen.findByLabelText('validation option')) as HTMLSelectElement;
  expect(select.value).toBe('default');
  expect(screen.getByText('/hsrb/joint_states')).toBeInTheDocument();
});

test('selecting an aspect option posts {category: <aspect>}', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Validation' }));
  const select = (await screen.findByLabelText('validation option')) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'strict' } });
  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sel = calls.find(
      (c) =>
        String(c[0]).includes('/config/select') &&
        JSON.parse(String((c[1] as RequestInit).body)).category === 'validation',
    );
    expect(sel).toBeDefined();
    expect(JSON.parse(String((sel![1] as RequestInit).body))).toEqual({
      category: 'validation',
      id: 'strict',
    });
  });
});

test('renders the recording-config editor seeded with the fetched config', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));
  expect(editor.value).toContain('/hsrb/odom');
});

test('saving PUTs the edited config and shows the apply note', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
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
  expect(screen.getByText(/apply after a service restart/)).toBeInTheDocument();
});

test('a server 422 validation error is shown inline', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? 'GET';
    if (url.includes('/config/recording')) {
      if (method === 'PUT') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'invalid_config',
                message: 'Recording config failed validation.',
                details: { errors: [{ loc: ['robot_name'], msg: 'Field required' }] },
              },
            },
            422,
          ),
        );
      }
      return Promise.resolve(jsonResponse(RECORDING));
    }
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse(OPTIONS));
    }
    return Promise.resolve(jsonResponse({}));
  });

  renderWithClient(<ConfigTab config={CONFIG} />);
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name"'));
  fireEvent.change(editor, { target: { value: '{"default_topics": []}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(
    await screen.findByText('invalid_config: Recording config failed validation.'),
  ).toBeInTheDocument();
  expect(screen.getByText('robot_name: Field required')).toBeInTheDocument();
});

test('a client-side JSON parse error blocks the PUT', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);
  const editor = (await screen.findByLabelText('recording config json')) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name"'));

  fireEvent.change(editor, { target: { value: '{ not json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText(/JSON error:/)).toBeInTheDocument();
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const put = calls.find(
    (c) =>
      String(c[0]).includes('/config/recording') &&
      ((c[1] as RequestInit)?.method ?? 'GET') === 'PUT',
  );
  expect(put).toBeUndefined();
});
