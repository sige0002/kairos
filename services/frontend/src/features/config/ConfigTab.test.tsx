import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { ConfigTab } from './ConfigTab';

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

beforeEach(() => {
  setApiBase('/api/v1');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
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
  renderWithClient(<ConfigTab />);

  const select = (await screen.findByLabelText(
    'validation template',
  )) as HTMLSelectElement;
  expect(select.value).toBe('airoa_hsr');
  // The active template's required topics are shown.
  expect(screen.getByText('/hsrb/joint_states')).toBeInTheDocument();
});

test('selecting a template posts the selection and updates active', async () => {
  renderWithClient(<ConfigTab />);

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
