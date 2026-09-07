// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderWithClient } from '../../../test/renderWithClient';
import { useUiStore } from '../../../store/uiStore';
import { SignalsView } from './SignalsView';

const fixtures = vi.hoisted(() => ({
  topics: [{ name: '/camera/status' }, { name: '/arm/joints' }],
  fields: { fields: ['value'] },
}));
vi.mock('../../../features/probe/useProbe', () => ({
  useProbeTopics: () => ({ data: fixtures.topics, isPending: false }),
  useProbeFields: () => ({ data: fixtures.fields, isPending: false }),
  useProbeSeries: () => ({ data: [], status: 'idle' }),
}));
vi.mock('../../../features/probe/UplotChart', () => ({
  PALETTE: ['#000'],
  UplotChart: () => null,
}));
afterEach(() => useUiStore.setState({ probeSeries: [] }));

test('search narrows topic names, preserves selection and plotted series, and clears with focus', () => {
  useUiStore.setState({ probeSeries: [] });
  renderWithClient(<SignalsView />);
  const search = screen.getByRole('searchbox', { name: 'Search topics' });
  const select = screen.getByTestId('signals-topic');
  fireEvent.change(search, { target: { value: '  CAMERA  ' } });
  expect(
    within(select).getByRole('option', { name: '/camera/status' }),
  ).toBeInTheDocument();
  expect(
    within(select).queryByRole('option', { name: '/arm/joints' }),
  ).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: '/camera/status' } });
  fireEvent.click(screen.getByTestId('signals-add'));
  const series = useUiStore.getState().probeSeries;
  expect(series).toHaveLength(1);

  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('No topics match “missing”.')).toBeInTheDocument();
  expect(select).toHaveValue('/camera/status');
  expect(screen.getByTestId('signals-field')).toHaveValue('value');
  expect(useUiStore.getState().probeSeries).toEqual(series);
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveValue('');
  expect(search).toHaveFocus();
  expect(
    within(select).getByRole('option', { name: '/arm/joints' }),
  ).toBeInTheDocument();
  expect(select).toHaveValue('/camera/status');
});
