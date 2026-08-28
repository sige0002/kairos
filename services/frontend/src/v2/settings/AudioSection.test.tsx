// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse, renderWithClient } from '../../test/renderWithClient';
import {
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  setAudioSettings,
} from '../audio/settings';
import { __resetPlansStore, getFailReasons, setFailReasons } from '../plans';
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
  __resetPlansStore();
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
      engine: 'kokoro-82m',
      voices: { en: ['af_heart'], ja: ['jf_alpha'] },
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
    phrases: { key: string; text: string; language: string; speed: number }[];
  } | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    posted = JSON.parse(String(init?.body));
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'kokoro-82m',
        assets: [],
        errors: [],
      }),
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
    '録画開始',
  );
  expect(posted!.phrases.find((phrase) => phrase.key.startsWith('error:'))?.text).toBe(
    'エラー',
  );
  expect(posted!.phrases.every((phrase) => phrase.language === 'ja')).toBe(true);
  expect(posted!.phrases.every((phrase) => phrase.speed === 1)).toBe(true);
});

test('sound preview keeps its Web Audio player alive until Settings unmounts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    jsonResponse({
      available: true,
      engine: 'kokoro-82m',
      voices: { en: ['af_heart'], ja: ['jf_alpha'] },
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

test('preparing after a speaker change sends the selected Kokoro voice', async () => {
  let postedVoice = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: {
            en: ['af_heart'],
            ja: ['jf_alpha', 'jm_kumo'],
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
        engine: 'kokoro-82m',
        assets: [],
        errors: [],
        deferred: false,
      }),
    );
  });
  renderWithClient(<AudioSection />);

  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Voice' })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Voice' })).toHaveValue('jf_alpha'),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), {
    target: { value: 'jm_kumo' },
  });
  expect(getAudioSettings().voiceName).toBe('jm_kumo');
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Voice' })).toHaveValue('jm_kumo'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));

  await waitFor(() => expect(postedVoice).toBe('jm_kumo'));
});

test('speech-rate changes invalidate assets and are sent to prepare', async () => {
  let postedSpeed = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    const body = JSON.parse(String(init?.body)) as {
      phrases: { speed: number }[];
    };
    postedSpeed = body.phrases[0]?.speed ?? 0;
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'kokoro-82m',
        assets: [],
        errors: [],
        deferred: false,
      }),
    );
  });
  setAudioSettings({
    ...getAudioSettings(),
    preparedEngine: 'kokoro-82m',
    assets: { prepared: '/voice.wav' },
  });
  renderWithClient(<AudioSection />);

  fireEvent.change(screen.getByLabelText(/Speech rate/), {
    target: { value: '0.9' },
  });
  expect(getAudioSettings().assets).toEqual({});
  expect(getAudioSettings().preparedEngine).toBeNull();
  await waitFor(() => expect(screen.getByLabelText(/Speech rate/)).toHaveValue('0.9'));
  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  await waitFor(() => expect(postedSpeed).toBe(0.9));
});

test('an unknown stored voice recovers to the live catalog before prepare', async () => {
  let postedVoice = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          model_revision: 'revision-a',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    const body = JSON.parse(String(init?.body)) as {
      phrases: { voice: string }[];
    };
    postedVoice = body.phrases[0]?.voice ?? '';
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'kokoro-82m',
        assets: [],
        errors: [],
        deferred: false,
      }),
    );
  });
  setAudioSettings({
    ...getAudioSettings(),
    voiceName: 'bogus_voice',
    preparedEngine: 'kokoro-82m',
    preparedModelRevision: 'old-revision',
    assets: { stale: '/stale.wav' },
  });
  renderWithClient(<AudioSection />);

  await waitFor(() => expect(getAudioSettings().voiceName).toBe('af_heart'));
  expect(getAudioSettings().assets).toEqual({});
  expect(getAudioSettings().preparedModelRevision).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare voice assets' }));

  await waitFor(() => expect(postedVoice).toBe('af_heart'));
});

test('voice preparation merges into current settings instead of stale render state', async () => {
  let finishPreparation: ((response: Response) => void) | undefined;
  let requestedSuccessKey = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    const body = JSON.parse(String(init?.body)) as {
      phrases: { key: string }[];
    };
    requestedSuccessKey =
      body.phrases.find((phrase) => phrase.key.startsWith('success:'))?.key ?? '';
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
      engine: 'kokoro-82m',
      assets: [{ key: requestedSuccessKey, url: '/voice.wav', asset_id: 'x' }],
      errors: [],
    }),
  );

  await waitFor(() =>
    expect(getAudioSettings().assets[requestedSuccessKey]).toBe('/voice.wav'),
  );
  expect(getAudioSettings().soundEffects).toBe(false);
});

test('a failure-reason refresh during preparation keeps matching voice assets', async () => {
  let finishPreparation: ((response: Response) => void) | undefined;
  let requestedStartKey = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          model_revision: 'revision-a',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    if (url.includes('/audio/assets')) {
      const body = JSON.parse(String(init?.body)) as {
        phrases: { key: string }[];
      };
      requestedStartKey =
        body.phrases.find((phrase) => phrase.key.startsWith('start:'))?.key ?? '';
      return new Promise<Response>((resolve) => {
        finishPreparation = resolve;
      });
    }
    return Promise.resolve(jsonResponse({ revision: 1 }));
  });
  renderWithClient(<AudioSection />);

  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  await waitFor(() => expect(finishPreparation).toBeDefined());
  act(() => {
    setFailReasons([...getFailReasons(), 'Reason loaded during preparation']);
  });
  finishPreparation!(
    jsonResponse({
      available: true,
      engine: 'kokoro-82m',
      model_revision: 'revision-a',
      assets: [
        { key: requestedStartKey, url: '/prepared-start.wav', asset_id: 'start' },
      ],
      errors: [],
      deferred: false,
    }),
  );

  await waitFor(() =>
    expect(getAudioSettings().assets[requestedStartKey]).toBe('/prepared-start.wav'),
  );
  expect(
    screen.getByText(/failure reasons changed during preparation.*Prepare again/i),
  ).toBeVisible();
});

test('voice preview reports preparation in progress instead of not prepared', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          model_revision: 'revision-a',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    return new Promise<Response>(() => {});
  });
  renderWithClient(<AudioSection />);

  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  await waitFor(() => expect(prepare).toHaveTextContent('Preparing…'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Preview voice for Success saved' }),
  );

  expect(
    await screen.findByText(
      'Voice preparation is still running. Wait for it to finish.',
    ),
  ).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Preview voice for Success saved' }),
  ).toHaveTextContent('Wait…');
});

test('recording deferral names the reason and recovery instead of skipped phrases', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'kokoro-82m',
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

test('partial preparation uses a pluralized recovery message', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).includes('/audio/status'))
      return Promise.resolve(
        jsonResponse({
          available: true,
          engine: 'kokoro-82m',
          voices: { en: ['af_heart'], ja: ['jf_alpha'] },
        }),
      );
    const body = JSON.parse(String(init?.body)) as {
      phrases: { key: string }[];
    };
    const startKey = body.phrases.find((phrase) =>
      phrase.key.startsWith('start:'),
    )?.key;
    return Promise.resolve(
      jsonResponse({
        available: true,
        engine: 'kokoro-82m',
        assets: startKey ? [{ key: startKey, url: '/prepared-start.wav' }] : [],
        errors: ['raw service failure'],
        deferred: false,
      }),
    );
  });
  renderWithClient(<AudioSection />);

  const prepare = screen.getByRole('button', { name: 'Prepare voice assets' });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  expect(await screen.findByText(/1 phrase could not be prepared/i)).toBeVisible();
});
