// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import {
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  setAudioSettings,
} from '../audio/settings';
import { AudioSection } from './AudioSection';

beforeEach(() => {
  window.localStorage.clear();
  setAudioSettings(structuredClone(DEFAULT_AUDIO_SETTINGS));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

test('audio is off by default and global controls remain independent', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      available: true,
      engine: 'test',
      voices: { en: ['en-us'], ja: ['ja'] },
    }),
  );
  renderWithClient(<AudioSection />);

  expect(screen.getByRole('switch', { name: 'Audio feedback' })).not.toBeChecked();
  expect(screen.getByRole('switch', { name: 'Sound effects' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Voice / TTS' })).toBeChecked();

  fireEvent.click(screen.getByRole('switch', { name: 'Audio feedback' }));
  fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
  expect(getAudioSettings().master).toBe(true);
  expect(getAudioSettings().soundEffects).toBe(false);
  expect(getAudioSettings().voice).toBe(true);
});

test('preparing Japanese assets includes configured failure reason text', async () => {
  let posted: { phrases: { text: string; language: string }[] } | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'test',
          voices: { en: ['en-us'], ja: ['ja'] },
        }),
      );
    posted = JSON.parse(String(init?.body));
    return Promise.resolve(
      jsonResponse({ available: true, engine: 'test', assets: [], errors: [] }),
    );
  });
  renderWithClient(<AudioSection />);
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));

  await waitFor(() => expect(posted).not.toBeNull());
  expect(posted!.phrases.some((phrase) => phrase.text === 'Grasp missed')).toBe(true);
  expect(posted!.phrases.every((phrase) => phrase.language === 'ja')).toBe(true);
});

test('voice preparation merges into current settings instead of stale render state', async () => {
  let finishPreparation: ((response: Response) => void) | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'test',
          voices: { en: ['en-us'], ja: ['ja'] },
        }),
      );
    return new Promise<Response>((resolve) => {
      finishPreparation = resolve;
    });
  });
  renderWithClient(<AudioSection />);

  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));
  await waitFor(() => expect(finishPreparation).toBeDefined());
  fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
  finishPreparation!(
    jsonResponse({
      available: true,
      engine: 'test',
      assets: [{ key: 'success:x', url: '/voice.wav', asset_id: 'x' }],
      errors: [],
    }),
  );

  await waitFor(() =>
    expect(getAudioSettings().assets['success:x']).toBe('/voice.wav'),
  );
  expect(getAudioSettings().soundEffects).toBe(false);
});

test('recording deferral names the reason and recovery instead of skipped phrases', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'test',
          voices: { en: ['en-us'], ja: ['ja'] },
        }),
      );
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'test',
        assets: [],
        errors: ['Voice generation is deferred while recording is active'],
        deferred: true,
      }),
    );
  });
  renderWithClient(<AudioSection />);

  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));

  expect(
    await screen.findByText(
      /deferred while recording is active.*Retry after recording stops/,
    ),
  ).toBeVisible();
});
