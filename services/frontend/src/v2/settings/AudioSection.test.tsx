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

const cuePlayer = vi.hoisted(() => ({
  supported: true,
  unlock: vi.fn(() => Promise.resolve(true)),
  play: vi.fn(() => Promise.resolve(true)),
  dispose: vi.fn(),
}));

vi.mock('../collect/recordingCues', () => ({
  createRecordingCuePlayer: () => cuePlayer,
}));

beforeEach(() => {
  window.localStorage.clear();
  setAudioSettings(structuredClone(DEFAULT_AUDIO_SETTINGS));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  cuePlayer.unlock.mockClear();
  cuePlayer.play.mockClear();
  cuePlayer.dispose.mockClear();
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
  let posted: {
    phrases: { key: string; text: string; language: string }[];
  } | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'espeak-ng',
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
  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);

  await waitFor(() => expect(posted).not.toBeNull());
  expect(posted!.phrases.some((phrase) => phrase.text === 'Grasp missed')).toBe(true);
  expect(posted!.phrases.find((phrase) => phrase.key.startsWith('start:'))?.text).toBe(
    'ろくがかいし',
  );
  expect(posted!.phrases.find((phrase) => phrase.key.startsWith('error:'))?.text).toBe(
    'えらあ',
  );
  expect(posted!.phrases.every((phrase) => phrase.language === 'ja')).toBe(true);
});

test('sound preview keeps its Web Audio player alive until Settings unmounts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      available: true,
      engine: 'test',
      voices: { en: ['en-us'], ja: ['test-ja'] },
    }),
  );
  const view = renderWithClient(<AudioSection />);

  fireEvent.click(
    screen.getByRole('button', { name: 'Preview sound for Success saved' }),
  );

  await waitFor(() => expect(cuePlayer.play).toHaveBeenCalledWith('success', 0.45));
  expect(cuePlayer.dispose).not.toHaveBeenCalled();

  view.unmount();
  expect(cuePlayer.dispose).toHaveBeenCalledOnce();
});

test('preparing after a speaker change sends the selected unique voice', async () => {
  let postedVoice = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'voicevox+espeak-ng',
          voices: {
            en: ['en-us'],
            ja: ['3:Operator / Normal', '7:Operator / Calm'],
          },
        }),
      );
    const body = JSON.parse(String(init?.body)) as {
      phrases: { voice: string }[];
    };
    postedVoice = body.phrases[0]?.voice ?? '';
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'voicevox+espeak-ng',
        assets: [],
        errors: [],
        deferred: false,
      }),
    );
  });
  renderWithClient(<AudioSection />);

  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
  await waitFor(() =>
    expect(screen.getByLabelText('Voice')).toHaveValue('3:Operator / Normal'),
  );
  expect(screen.getByText('VOICEVOX:Operator · Normal')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Voice'), {
    target: { value: '7:Operator / Calm' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));

  await waitFor(() => expect(postedVoice).toBe('7:Operator / Calm'));
});

test('does not credit VOICEVOX when the active English route uses eSpeak', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      available: true,
      engine: 'voicevox+espeak-ng',
      voices: {
        en: ['en-us'],
        ja: ['3:Operator / Normal'],
      },
    }),
  );
  renderWithClient(<AudioSection />);

  await waitFor(() => expect(screen.getByLabelText('Voice')).toHaveValue('en-us'));
  expect(screen.queryByText(/^VOICEVOX:/)).not.toBeInTheDocument();
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

  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
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

  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);

  expect(
    await screen.findByText(
      /deferred while recording is active.*Retry after recording stops/,
    ),
  ).toBeVisible();
});
