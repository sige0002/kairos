import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse, makeTestClient } from '../../test/renderWithClient';
import { queryKeys } from '../../api/queryKeys';
import { useUiStore } from '../../store/uiStore';
import { ProbeTab } from './ProbeTab';

beforeEach(() => {
  vi.restoreAllMocks();
  // The series/controls live in the shared UI store — reset between tests.
  useUiStore.setState({
    probeSeries: [],
    probeSeriesSeq: 0,
    probeHz: 10,
    probeWindowId: '30s',
  });
});
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

function mockFields(fields: string[]) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      ts: '2026-06-27T00:00:00Z',
      topic: '/pose',
      type: 'geometry_msgs/msg/Pose',
      fields,
      reason: null,
    }),
  );
}

test('lists subscribable topics and prompts to add a series', async () => {
  renderProbe();
  await screen.findByLabelText('probe topic');
  expect(screen.getByRole('option', { name: '/pose' })).toBeInstanceOf(HTMLOptionElement);
  expect(
    screen.getByRole('option', { name: '/hsrb/joint_states' }),
  ).toBeInstanceOf(HTMLOptionElement);
  // Empty-state guidance until a series is added.
  expect(screen.getByText(/Add a topic \+ field series/i)).toBeInTheDocument();
});

test('introspects fields after selecting a topic and defaults to the first', async () => {
  const fetchMock = mockFields(['position.x', 'position.y', 'position.z']);
  renderProbe();

  fireEvent.change(await screen.findByLabelText('probe topic'), {
    target: { value: '/pose' },
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const url = String(fetchMock.mock.calls[0]?.[0]);
  expect(url).toContain('/probe/fields');
  expect(url).toContain('topic=%2Fpose');

  const fieldSelect = (await screen.findByLabelText('probe field')) as HTMLSelectElement;
  await waitFor(() => expect(fieldSelect.value).toBe('position.x'));
});

test('adds and removes overlay series (multi-field)', async () => {
  mockFields(['position.x', 'position.y']);
  renderProbe();

  fireEvent.change(await screen.findByLabelText('probe topic'), {
    target: { value: '/pose' },
  });
  const fieldSelect = (await screen.findByLabelText('probe field')) as HTMLSelectElement;
  await waitFor(() => expect(fieldSelect.value).toBe('position.x'));

  // Add the first series -> a chip with a remove control appears.
  fireEvent.click(screen.getByRole('button', { name: '+ Add series' }));
  expect(await screen.findByLabelText('remove pose·position.x')).toBeInTheDocument();

  // Overlay a second field of the same topic.
  fireEvent.change(fieldSelect, { target: { value: 'position.y' } });
  fireEvent.click(screen.getByRole('button', { name: '+ Add series' }));
  expect(screen.getByLabelText('remove pose·position.y')).toBeInTheDocument();

  // Remove the first series.
  fireEvent.click(screen.getByLabelText('remove pose·position.x'));
  await waitFor(() =>
    expect(screen.queryByLabelText('remove pose·position.x')).not.toBeInTheDocument(),
  );
});

// The overlay lives in the persistent UI store: switching tabs unmounts the
// ProbeTab (like every tab), and the built-up series set must survive the
// round-trip instead of reverting to the empty placeholder.
test('added series survive a remount (tab switch away and back)', async () => {
  mockFields(['position.x']);
  const { unmount } = renderProbe();

  fireEvent.change(await screen.findByLabelText('probe topic'), {
    target: { value: '/pose' },
  });
  const fieldSelect = (await screen.findByLabelText('probe field')) as HTMLSelectElement;
  await waitFor(() => expect(fieldSelect.value).toBe('position.x'));
  fireEvent.click(screen.getByRole('button', { name: '+ Add series' }));
  expect(await screen.findByLabelText('remove pose·position.x')).toBeInTheDocument();

  unmount(); // leave the Probe tab
  renderProbe(); // come back

  expect(await screen.findByLabelText('remove pose·position.x')).toBeInTheDocument();
  expect(screen.queryByText(/Add a topic \+ field series/i)).not.toBeInTheDocument();
});
