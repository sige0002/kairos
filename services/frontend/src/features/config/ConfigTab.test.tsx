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

const OPTIONS = {
  validation: {
    active: 'airoa_hsr',
    options: [
      {
        id: 'airoa_hsr',
        name: 'airoa_hsr',
        version: 1,
        required_topics: [{ name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' }],
      },
      { id: 'template', name: 'template', version: 1, required_topics: [{ name: '/joint_states' }] },
    ],
  },
};

const RECORDING = {
  config: { robot_name: 'hsr', default_topics: ['/hsrb/odom'], expected_hz_patterns: [] },
  path: '/config/airoa_hsr.yaml',
};

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
      // Echo back options with the new active selection.
      return Promise.resolve(
        jsonResponse({
          validation: { active: body.id, options: OPTIONS.validation.options },
        }),
      );
    }
    if (url.includes('/config/options')) {
      return Promise.resolve(jsonResponse(OPTIONS));
    }
    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => vi.restoreAllMocks());

test('lists validation templates and shows the active one’s required topics', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);

  const select = (await screen.findByLabelText(
    'validation template',
  )) as HTMLSelectElement;
  expect(select.value).toBe('airoa_hsr');
  // The active template's required topics are shown.
  expect(screen.getByText('/hsrb/joint_states')).toBeInTheDocument();
});

test('selecting a template posts the selection and updates active', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);

  const select = (await screen.findByLabelText(
    'validation template',
  )) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'template' } });

  await waitFor(() => {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const sel = calls.find((c) => String(c[0]).includes('/config/select'));
    expect(sel).toBeDefined();
    expect(JSON.parse(String((sel![1] as RequestInit).body))).toEqual({
      category: 'validation',
      id: 'template',
    });
  });
  // Active follows the selection (server echoes it back).
  await waitFor(() =>
    expect((screen.getByLabelText('validation template') as HTMLSelectElement).value).toBe(
      'template',
    ),
  );
});

test('renders the recording-config editor seeded with the fetched config', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);

  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));
  expect(editor.value).toContain('/hsrb/odom');
});

test('saving PUTs the edited config and shows the apply note', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);

  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name": "hsr"'));

  // Edit: rename the robot, then save.
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

  // Success note appears and states the immediate-vs-restart semantics.
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(screen.getByText(/apply after a service restart/)).toBeInTheDocument();
});

test('a server 422 validation error is shown inline', async () => {
  // Override PUT to return a 422 envelope with pydantic-style details.
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
                details: {
                  errors: [{ loc: ['robot_name'], msg: 'Field required' }],
                },
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

  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name"'));
  fireEvent.change(editor, { target: { value: '{"default_topics": []}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  // ErrorMessage renders "<code>: <message>" when a code is present.
  expect(
    await screen.findByText('invalid_config: Recording config failed validation.'),
  ).toBeInTheDocument();
  // The pydantic field error is rendered in the details list.
  expect(screen.getByText('robot_name: Field required')).toBeInTheDocument();
});

test('a client-side JSON parse error blocks the PUT', async () => {
  renderWithClient(<ConfigTab config={CONFIG} />);

  const editor = (await screen.findByLabelText(
    'recording config json',
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toContain('"robot_name"'));

  fireEvent.change(editor, { target: { value: '{ not json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText(/JSON error:/)).toBeInTheDocument();
  // No PUT was issued.
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const put = calls.find(
    (c) =>
      String(c[0]).includes('/config/recording') &&
      ((c[1] as RequestInit)?.method ?? 'GET') === 'PUT',
  );
  expect(put).toBeUndefined();
});
