import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse, makeTestClient } from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
import { ProbeTab } from './ProbeTab';

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

function renderProbe() {
  const client = makeTestClient();
  // Seed the topic list (normally GET /probe/topics) so it renders without a
  // backend; the field list is fetched on demand (mocked per test).
  client.setQueryData<{ name: string; type: string | null }[]>(queryKeys.probeTopics, [
    { name: '/pose', type: 'geometry_msgs/msg/Pose' },
    { name: '/hsrb/joint_states', type: 'sensor_msgs/msg/JointState' },
  ]);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(createElement(ProbeTab), { wrapper });
}

test('lists subscribable topics and prompts to pick one', async () => {
  renderProbe();
  await screen.findByLabelText('probe topic');
  expect(screen.getByRole('option', { name: '/pose' })).toBeInstanceOf(
    HTMLOptionElement,
  );
  expect(screen.getByRole('option', { name: '/hsrb/joint_states' })).toBeInstanceOf(
    HTMLOptionElement,
  );
  // Empty-state guidance until a topic+field are chosen.
  expect(screen.getByText(/Select a topic and a numeric field/i)).toBeInTheDocument();
});

test('introspects fields after selecting a topic and defaults to the first', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      ts: '2026-06-27T00:00:00Z',
      topic: '/pose',
      type: 'geometry_msgs/msg/Pose',
      fields: ['position.x', 'position.y', 'position.z'],
      reason: null,
    }),
  );
  renderProbe();

  const topicSelect = (await screen.findByLabelText(
    'probe topic',
  )) as HTMLSelectElement;
  fireEvent.change(topicSelect, { target: { value: '/pose' } });

  // The field query fires against /probe/fields?topic=/pose.
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const url = String(fetchMock.mock.calls[0]?.[0]);
  expect(url).toContain('/probe/fields');
  expect(url).toContain('topic=%2Fpose');

  // Fields populate and the first is auto-selected.
  const fieldSelect = (await screen.findByLabelText(
    'probe field',
  )) as HTMLSelectElement;
  await waitFor(() => expect(fieldSelect.value).toBe('position.x'));
  expect(screen.getByRole('option', { name: 'position.z' })).toBeInstanceOf(
    HTMLOptionElement,
  );
});
