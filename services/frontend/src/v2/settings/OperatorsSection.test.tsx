// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { OperatorsSection } from './OperatorsSection';
import type { SettingsState } from './useSettingsState';

test('names each remove action after the operator it affects', () => {
  const removeOperator = vi.fn();
  const settings = {
    operators: ['Aki', 'Morgan'],
    addOperator: vi.fn(),
    renameOperator: vi.fn(),
    removeOperator,
  } as unknown as SettingsState;

  render(<OperatorsSection settings={settings} />);

  const aki = screen.getByRole('button', { name: 'Remove operator Aki' });
  const morgan = screen.getByRole('button', { name: 'Remove operator Morgan' });
  expect(aki).toHaveAttribute('title', 'Remove operator Aki');
  expect(morgan).toHaveAttribute('title', 'Remove operator Morgan');

  fireEvent.click(morgan);
  expect(removeOperator).toHaveBeenCalledWith(1);
});
