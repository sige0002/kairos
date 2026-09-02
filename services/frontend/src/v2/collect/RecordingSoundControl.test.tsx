// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { fireEvent, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithClient } from '../../test/renderWithClient';
import { RecordingSoundControl } from './RecordingSoundControl';

test('sound settings explain the three cues and expose opt-in controls', () => {
  const setEnabled = vi.fn();
  const setVolume = vi.fn();
  const preview = vi.fn();
  renderWithClient(
    <RecordingSoundControl
      open
      onToggle={vi.fn()}
      settings={{
        enabled: false,
        volume: 0.45,
        playbackState: 'disabled',
        setEnabled,
        setVolume,
        preview,
      }}
    />,
  );

  expect(
    screen.getByRole('dialog', { name: 'Recording sound settings' }),
  ).toBeVisible();
  expect(
    screen.getByText(/End = recording finalized, not a data quality result/),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

  fireEvent.click(screen.getByRole('switch'));
  expect(setEnabled).toHaveBeenCalledWith(true);
});

test('enabled settings can preview cues and change volume', () => {
  const setVolume = vi.fn();
  const preview = vi.fn();
  renderWithClient(
    <RecordingSoundControl
      open
      onToggle={vi.fn()}
      settings={{
        enabled: true,
        volume: 0.45,
        playbackState: 'ready',
        setEnabled: vi.fn(),
        setVolume,
        preview,
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Warning' }));
  expect(preview).toHaveBeenCalledWith('warning');

  fireEvent.change(screen.getByRole('slider'), { target: { value: '0.7' } });
  expect(setVolume).toHaveBeenCalledWith(0.7);
});

test('the dialog takes focus, closes with Escape and returns focus', () => {
  const onToggle = vi.fn();
  const settings = {
    enabled: true,
    volume: 0.45,
    playbackState: 'ready' as const,
    setEnabled: vi.fn(),
    setVolume: vi.fn(),
    preview: vi.fn(),
  };
  const { rerender } = renderWithClient(
    <RecordingSoundControl open settings={settings} onToggle={onToggle} />,
  );

  expect(screen.getByRole('switch')).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onToggle).toHaveBeenCalledOnce();

  rerender(
    <RecordingSoundControl open={false} settings={settings} onToggle={onToggle} />,
  );
  expect(screen.getByTestId('recording-sounds-toggle')).toHaveFocus();
});

test('blocked, incomplete, and unsupported playback are not presented as sound-on', () => {
  const base = {
    enabled: true,
    volume: 0.45,
    setEnabled: vi.fn(),
    setVolume: vi.fn(),
    preview: vi.fn(),
  };
  const { rerender } = renderWithClient(
    <RecordingSoundControl
      open={false}
      onToggle={vi.fn()}
      settings={{ ...base, playbackState: 'blocked' }}
    />,
  );
  expect(screen.getByTestId('recording-sounds-toggle')).toHaveAccessibleName(
    'Recording sounds blocked',
  );

  rerender(
    <RecordingSoundControl
      open
      onToggle={vi.fn()}
      settings={{ ...base, playbackState: 'incomplete' }}
    />,
  );
  expect(screen.getByTestId('recording-sounds-toggle')).toHaveAccessibleName(
    'Recording sounds incomplete',
  );
  expect(screen.getByTestId('recording-sounds-status')).toHaveTextContent(
    /voice cues are not prepared/i,
  );

  rerender(
    <RecordingSoundControl
      open
      onToggle={vi.fn()}
      settings={{ ...base, playbackState: 'unsupported' }}
    />,
  );
  expect(screen.getByTestId('recording-sounds-toggle')).toHaveAccessibleName(
    'Recording sounds unavailable',
  );
  expect(screen.getByRole('switch')).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Close recording sound settings' }),
  ).toHaveFocus();
});

test('an external overlay close does not steal focus back to the speaker', () => {
  const settings = {
    enabled: true,
    volume: 0.45,
    playbackState: 'ready' as const,
    setEnabled: vi.fn(),
    setVolume: vi.fn(),
    preview: vi.fn(),
  };
  const view = (open: boolean) => (
    <>
      <button type="button">Other control</button>
      <RecordingSoundControl open={open} settings={settings} onToggle={vi.fn()} />
    </>
  );
  const { rerender } = renderWithClient(view(true));
  const other = screen.getByRole('button', { name: 'Other control' });
  other.focus();

  rerender(view(false));
  expect(other).toHaveFocus();
});
