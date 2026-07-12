import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setApiBase } from '../../api/client';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import { SettingsScreen } from './SettingsScreen';

const CONFIG_WITH_ROBOT = {
  endpoints: { api: '/api/v1', events: '/api/v1/events', webrtc: 'http://localhost:8002' },
  tabs: [],
  defaults: {
    robot_name: 'airoa_hsr',
    ros_domain_id: 42,
    default_topics: ['/tf', '/joint_states', '/camera/top/image_raw'],
  },
  schemas: {},
};

function mockConfigFetch(body: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/config')) return Promise.resolve(jsonResponse(body));
    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => setApiBase('/api/v1'));
afterEach(() => vi.restoreAllMocks());

test('Robots is the default section and shows the active robot\'s real config values', async () => {
  mockConfigFetch(CONFIG_WITH_ROBOT);
  renderWithClient(<SettingsScreen />);

  await waitFor(() => expect(screen.getByTestId('robot-form-name')).toHaveTextContent('airoa_hsr'));
  expect(screen.getByTestId('robot-topics-summary')).toHaveTextContent('3 recorded topics');
  const chips = screen.getByTestId('robot-topic-chips');
  expect(within(chips).getByText('/tf')).toBeInTheDocument();
  expect(within(chips).getByText('/camera/top/image_raw')).toBeInTheDocument();
});

test('falls back to the mock profile when the backend has no config yet', async () => {
  mockConfigFetch({ endpoints: {}, tabs: [], defaults: {}, schemas: {} });
  renderWithClient(<SettingsScreen />);

  await waitFor(() =>
    expect(screen.getByTestId('robot-form-name')).toHaveTextContent('robot_arm_A'),
  );
  expect(screen.getByTestId('robot-topics-summary')).toHaveTextContent('12 required · 3 optional');
});

test('selecting a non-active robot profile shows its mock data, not the live config', async () => {
  mockConfigFetch(CONFIG_WITH_ROBOT);
  renderWithClient(<SettingsScreen />);

  await waitFor(() => expect(screen.getByTestId('robot-form-name')).toHaveTextContent('airoa_hsr'));
  fireEvent.click(screen.getByTestId('robot-row-1'));

  await waitFor(() =>
    expect(screen.getByTestId('robot-form-name')).toHaveTextContent('robot_arm_B'),
  );
  expect(screen.getByTestId('robot-topics-summary')).toHaveTextContent('12 required · 3 optional');
});

test('menu switches between Robots, Plans, and a placeholder for the rest', async () => {
  mockConfigFetch(CONFIG_WITH_ROBOT);
  renderWithClient(<SettingsScreen />);
  await waitFor(() => expect(screen.getByTestId('robot-form')).toBeInTheDocument());

  fireEvent.click(screen.getByTestId('settings-menu-item-1'));
  expect(screen.getByTestId('plan-projects')).toBeInTheDocument();
  expect(screen.getByTestId('plan-project-name')).toHaveTextContent('Tabletop Manipulation');

  fireEvent.click(screen.getByTestId('settings-menu-item-2'));
  expect(screen.getByTestId('settings-other-placeholder')).toHaveTextContent('Recording');

  fireEvent.click(screen.getByTestId('settings-menu-item-0'));
  expect(screen.getByTestId('robot-form')).toBeInTheDocument();
});

test('Plans: adding and removing a task updates the task list and condition count', async () => {
  mockConfigFetch(CONFIG_WITH_ROBOT);
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
  mockConfigFetch(CONFIG_WITH_ROBOT);
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
