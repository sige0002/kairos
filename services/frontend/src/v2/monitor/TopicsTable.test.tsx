import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import type { MonitorRow } from '../../features/monitor/useMonitorRows';
import { TopicsTable } from './TopicsTable';

afterEach(() => useUiStore.setState({ monitorBridge: null }));

const row = (p: Partial<MonitorRow>): MonitorRow =>
  ({ name: '/t', configured: false, live: true, measured: true, ...p }) as MonitorRow;

test('discovering shows a loading row, not the empty-state message', () => {
  render(
    <TopicsTable rows={[]} isDiscovering selectedTopic={null} onSelect={() => {}} />,
  );
  expect(screen.getByText('Discovering topics…')).toBeInTheDocument();
  expect(screen.queryByTestId('topics-table-empty')).not.toBeInTheDocument();
});

test('empty state explains why — generic when the bridge state is unknown', () => {
  render(
    <TopicsTable rows={[]} isDiscovering={false} selectedTopic={null} onSelect={() => {}} />,
  );
  expect(screen.getByTestId('topics-table-empty')).toHaveTextContent('No topics discovered yet.');
});

test('empty state blames the robot bridge when it is reported down', () => {
  useUiStore.setState({ monitorBridge: 'down' });
  render(
    <TopicsTable rows={[]} isDiscovering={false} selectedTopic={null} onSelect={() => {}} />,
  );
  expect(screen.getByTestId('topics-table-empty')).toHaveTextContent('Robot offline');
});

test('threshold -> status chip mapping: ok/warning/danger/inactive/unmeasured', () => {
  const rows = [
    row({ name: '/ok', status: 'ok', hz: 29.8, expected_hz: 30 }),
    row({ name: '/warn', status: 'warning', hz: 22.1, expected_hz: 30 }),
    row({ name: '/danger', status: 'danger', hz: 5, expected_hz: 30 }),
    row({ name: '/silent', status: 'inactive' }),
    row({ name: '/undiscovered', measured: false, status: undefined }),
  ];
  render(
    <TopicsTable rows={rows} isDiscovering={false} selectedTopic={null} onSelect={() => {}} />,
  );

  const chipFor = (name: string) =>
    screen.getByTestId(`topic-row-${name}`).querySelector('span:last-child');

  expect(chipFor('/ok')).toHaveTextContent('OK');
  expect(chipFor('/warn')).toHaveTextContent('CHECK');
  expect(chipFor('/danger')).toHaveTextContent('DANGER');
  expect(chipFor('/silent')).toHaveTextContent('SILENT');
  expect(chipFor('/undiscovered')).toHaveTextContent('—');
});

test('expected column falls back to a learned baseline, then em-dash', () => {
  const rows = [
    row({ name: '/static', expected_hz: 30, hz: 29 }),
    row({ name: '/learned', baseline_state: 'stable', baseline_hz: 12.3, hz: 12 }),
    row({ name: '/none', hz: 8 }),
  ];
  render(
    <TopicsTable rows={rows} isDiscovering={false} selectedTopic={null} onSelect={() => {}} />,
  );
  expect(screen.getByTestId('topic-row-/static')).toHaveTextContent('30');
  expect(screen.getByTestId('topic-row-/learned')).toHaveTextContent('~12.3 Hz');
  expect(screen.getByTestId('topic-row-/none')).toHaveTextContent('—');
});

test('clicking a row selects its topic; the selected row is highlighted', () => {
  const rows = [row({ name: '/a' }), row({ name: '/b' })];
  const onSelect = vi.fn();
  render(<TopicsTable rows={rows} isDiscovering={false} selectedTopic="/a" onSelect={onSelect} />);

  expect(screen.getByTestId('topic-row-/a').className).toContain('bg-teal-50');
  expect(screen.getByTestId('topic-row-/b').className).not.toContain('bg-teal-50');

  fireEvent.click(screen.getByTestId('topic-row-/b'));
  expect(onSelect).toHaveBeenCalledWith('/b');
});
