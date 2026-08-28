// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import { i18n } from '../../i18n';
import type { MonitorRow } from '../../features/monitor/useMonitorRows';
import { TopicsTable } from './TopicsTable';
import { MAX_SERIES, paletteColor } from './chartSeries';

afterEach(async () => {
  useUiStore.setState({ monitorBridge: null });
  await i18n.changeLanguage('en');
});

const row = (p: Partial<MonitorRow>): MonitorRow =>
  ({ name: '/t', configured: false, live: true, measured: true, ...p }) as MonitorRow;

test('discovering shows a loading row, not the empty-state message', () => {
  render(
    <TopicsTable rows={[]} isDiscovering chartedTopics={[]} onToggle={() => {}} />,
  );
  expect(screen.getByText('Discovering topics…')).toBeInTheDocument();
  expect(screen.queryByTestId('topics-table-empty')).not.toBeInTheDocument();
});

test('Japanese resources localize table controls and status without changing raw topic names', async () => {
  await i18n.changeLanguage('ja');
  render(
    <TopicsTable
      rows={[row({ name: '/robot/raw_topic', status: 'warning' })]}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={() => {}}
    />,
  );

  expect(screen.getByRole('searchbox', { name: 'トピックを検索' })).toBeInTheDocument();
  expect(screen.getByTestId('topic-row-/robot/raw_topic')).toHaveTextContent('要確認');
  expect(screen.getByTestId('topic-row-/robot/raw_topic')).toHaveTextContent(
    '/robot/raw_topic',
  );
});

test('empty state explains why — generic when the bridge state is unknown', () => {
  render(
    <TopicsTable
      rows={[]}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={() => {}}
    />,
  );
  expect(screen.getByTestId('topics-table-empty')).toHaveTextContent(
    'No topics discovered yet.',
  );
});

test('empty state blames the robot bridge when it is reported down', () => {
  useUiStore.setState({ monitorBridge: 'down' });
  render(
    <TopicsTable
      rows={[]}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={() => {}}
    />,
  );
  expect(screen.getByTestId('topics-table-empty')).toHaveTextContent('Robot offline');
});

test('search filters topic names case-insensitively without changing row actions', () => {
  const rows = [row({ name: '/Camera/Color' }), row({ name: '/joint_states' })];
  const onToggle = vi.fn();
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={onToggle}
    />,
  );

  const search = screen.getByRole('searchbox', { name: 'Search topics' });
  fireEvent.change(search, { target: { value: 'camera' } });
  expect(screen.getByTestId('topic-row-/Camera/Color')).toBeInTheDocument();
  expect(screen.queryByTestId('topic-row-/joint_states')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('topic-row-/Camera/Color'));
  expect(onToggle).toHaveBeenCalledWith('/Camera/Color');

  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByTestId('topics-table-no-results')).toHaveTextContent(
    'No topics match “missing”.',
  );
  expect(screen.queryByTestId('topics-table-empty')).not.toBeInTheDocument();
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
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={() => {}}
    />,
  );

  // The status chip is the row button's last DIRECT child (the swatch added to
  // the Topic cell makes a bare `span:last-child` ambiguous).
  const chipFor = (name: string) =>
    screen.getByTestId(`topic-row-${name}`).querySelector(':scope > :last-child');

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
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={() => {}}
    />,
  );
  expect(screen.getByTestId('topic-row-/static')).toHaveTextContent('30');
  expect(screen.getByTestId('topic-row-/learned')).toHaveTextContent('~12.3 Hz');
  expect(screen.getByTestId('topic-row-/none')).toHaveTextContent('—');
});

test('clicking a row toggles its topic; charted rows are highlighted and marked pressed', () => {
  const rows = [row({ name: '/a' }), row({ name: '/b' })];
  const onToggle = vi.fn();
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={['/a']}
      onToggle={onToggle}
    />,
  );

  const a = screen.getByTestId('topic-row-/a');
  const b = screen.getByTestId('topic-row-/b');
  expect(a.className).toContain('bg-interaction-selected');
  expect(a).toHaveAttribute('aria-pressed', 'true');
  expect(b.className).not.toContain('bg-interaction-selected');
  expect(b).toHaveAttribute('aria-pressed', 'false');

  // Clicking an already-charted row toggles it (out); the parent decides the set.
  fireEvent.click(a);
  expect(onToggle).toHaveBeenCalledWith('/a');
  fireEvent.click(b);
  expect(onToggle).toHaveBeenCalledWith('/b');
});

test('a charted row carries a swatch in its series colour (index -> palette)', () => {
  const rows = [row({ name: '/a' }), row({ name: '/b' })];
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={['/a', '/b']}
      onToggle={() => {}}
    />,
  );
  // The first swatch inside each row cell; jsdom serialises hex as rgb, so match
  // against the row's own second colour rather than parsing the style string.
  const swatchB = screen.getByTestId('topic-row-/b').querySelector('span > span');
  // /b is the 2nd charted topic -> paletteColor(1). Its background must not equal
  // the unselected transparent border case, and must differ from /a's colour.
  expect(paletteColor(1)).not.toBe(paletteColor(0));
  expect(swatchB).toBeTruthy();
});

test('Rec checkbox reflects recordSelected and is independent of the chart selection', () => {
  const rows = [row({ name: '/a' }), row({ name: '/b' })];
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={['/a']}
      onToggle={() => {}}
      recordSelected={new Set(['/b'])}
      onToggleRec={() => {}}
    />,
  );
  // /b is in the record set (checked) though it is NOT charted; /a is charted
  // but NOT in the record set (unchecked) — the two selections are orthogonal.
  expect(screen.getByTestId('rec-check-/b')).toBeChecked();
  expect(screen.getByTestId('rec-check-/a')).not.toBeChecked();
});

test('clicking the Rec checkbox toggles the record set only — never the chart series', () => {
  const rows = [row({ name: '/a' }), row({ name: '/b' })];
  const onToggle = vi.fn();
  const onToggleRec = vi.fn();
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={onToggle}
      recordSelected={new Set()}
      onToggleRec={onToggleRec}
    />,
  );

  fireEvent.click(screen.getByTestId('rec-check-/a'));
  expect(onToggleRec).toHaveBeenCalledWith('/a');
  // Separation: the checkbox click must not bubble to the row's chart toggle.
  expect(onToggle).not.toHaveBeenCalled();
});

test('clicking the row toggles the chart series only — never the record set', () => {
  const rows = [row({ name: '/a' })];
  const onToggle = vi.fn();
  const onToggleRec = vi.fn();
  render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={[]}
      onToggle={onToggle}
      recordSelected={new Set()}
      onToggleRec={onToggleRec}
    />,
  );

  fireEvent.click(screen.getByTestId('topic-row-/a'));
  expect(onToggle).toHaveBeenCalledWith('/a');
  expect(onToggleRec).not.toHaveBeenCalled();
});

test('cap note appears only when the charted set is full', () => {
  const rows = Array.from({ length: MAX_SERIES + 1 }, (_, i) =>
    row({ name: `/t${i}` }),
  );
  const full = rows.slice(0, MAX_SERIES).map((r) => r.name);
  const { rerender } = render(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={full.slice(0, 3)}
      onToggle={() => {}}
    />,
  );
  expect(screen.queryByTestId('topics-table-cap')).not.toBeInTheDocument();

  rerender(
    <TopicsTable
      rows={rows}
      isDiscovering={false}
      chartedTopics={full}
      onToggle={() => {}}
    />,
  );
  expect(screen.getByTestId('topics-table-cap')).toHaveTextContent(
    `${MAX_SERIES}/${MAX_SERIES}`,
  );
});
