// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RecordState } from '../../../api/types';
import type { Phase } from '../machine/types';
import type { RecordingCueKind, RecordingCuePlayer } from '../recordingCues';
import { useRecordingCues } from './useRecordingCues';
import {
  __reloadAudioSettings,
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  setAudioSettings,
} from '../../audio/settings';
import { assetKey, phraseFor } from '../../audio/phrases';

const STORAGE_KEY = 'kairos.collect.recording-cues.v1';

function fakePlayer() {
  const played: RecordingCueKind[] = [];
  const player: RecordingCuePlayer = {
    supported: true,
    unlock: vi.fn(async () => true),
    play: vi.fn(async (kind) => {
      played.push(kind);
      return true;
    }),
    dispose: vi.fn(),
  };
  return { player, played };
}

interface Signals {
  phase: Phase;
  currentCaptureId: string | null;
  recorderReachable: boolean;
  statusCaptureId: string | null;
  statusState: RecordState | undefined;
  liveCaptures: string[] | null;
}

const baseSignals: Signals = {
  phase: 'ready',
  currentCaptureId: null,
  recorderReachable: true,
  statusCaptureId: null,
  statusState: 'created',
  liveCaptures: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  setAudioSettings(structuredClone(DEFAULT_AUDIO_SETTINGS));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('recording cues are opt-in and persist their volume', async () => {
  const { player } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));

  expect(result.current.settings.enabled).toBe(false);
  expect(result.current.settings.volume).toBe(0.45);

  await act(async () => result.current.settings.setEnabled(true));
  act(() => result.current.settings.setVolume(0.7));

  expect(player.unlock).toHaveBeenCalledOnce();
  expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
    enabled: true,
    volume: 0.7,
  });
});

test('start sounds only after this tab owns a live recording', async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  setAudioSettings({ ...structuredClone(DEFAULT_AUDIO_SETTINGS), master: true });
  const { player, played } = fakePlayer();
  const { result, rerender } = renderHook(
    ({ signals }) => useRecordingCues({ ...signals, player }),
    { initialProps: { signals: baseSignals } },
  );

  await act(async () => {
    result.current.markStartRequested();
    result.current.claimStartedCapture('cap_owned');
  });
  expect(played).toEqual([]);

  rerender({
    signals: {
      phase: 'recording' as const,
      currentCaptureId: 'cap_owned',
      recorderReachable: true,
      statusCaptureId: 'cap_owned',
      statusState: 'recording' as const,
      liveCaptures: ['cap_owned'],
    },
  });
  await waitFor(() => expect(played).toEqual(['start']));

  rerender({
    signals: {
      phase: 'recording' as const,
      currentCaptureId: 'cap_owned',
      recorderReachable: true,
      statusCaptureId: 'cap_owned',
      statusState: 'recording' as const,
      liveCaptures: ['cap_owned'],
    },
  });
  expect(played).toEqual(['start']);
});

test('an already-live capture stays silent after reload or takeover', () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  setAudioSettings({ ...structuredClone(DEFAULT_AUDIO_SETTINGS), master: true });
  const { player, played } = fakePlayer();

  renderHook(() =>
    useRecordingCues({
      phase: 'recording',
      currentCaptureId: 'cap_existing',
      recorderReachable: true,
      statusCaptureId: 'cap_existing',
      statusState: 'recording',
      liveCaptures: ['cap_existing'],
      player,
    }),
  );

  expect(played).toEqual([]);
});

test('end sounds only for a locally requested and confirmed stop', async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  setAudioSettings({ ...structuredClone(DEFAULT_AUDIO_SETTINGS), master: true });
  const { player, played } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));

  act(() => {
    result.current.markStartRequested();
    result.current.claimStartedCapture('cap_owned');
    result.current.confirmStop('cap_owned');
  });
  expect(played).toEqual([]);

  await act(async () => {
    result.current.markStopRequested('cap_owned');
    result.current.confirmStop('cap_owned');
  });
  expect(played).toEqual(['end']);

  act(() => result.current.confirmStop('cap_owned'));
  expect(played).toEqual(['end']);
});

test('failures and an owned recording loss use the warning cue once per event', async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  setAudioSettings({ ...structuredClone(DEFAULT_AUDIO_SETTINGS), master: true });
  const { player, played } = fakePlayer();
  const { result, rerender } = renderHook(
    ({ signals }) => useRecordingCues({ ...signals, player }),
    { initialProps: { signals: baseSignals } },
  );

  await act(async () => {
    result.current.notifyFailure();
    result.current.markStartRequested();
    result.current.claimStartedCapture('cap_owned');
  });
  expect(played).toEqual(['warning']);

  rerender({
    signals: {
      phase: 'recording' as const,
      currentCaptureId: 'cap_owned',
      recorderReachable: false,
      statusCaptureId: null,
      statusState: undefined,
      liveCaptures: null,
    },
  });
  await waitFor(() => expect(played).toEqual(['warning', 'warning']));

  rerender({
    signals: {
      phase: 'recording' as const,
      currentCaptureId: 'cap_owned',
      recorderReachable: false,
      statusCaptureId: null,
      statusState: undefined,
      liveCaptures: null,
    },
  });
  expect(played).toEqual(['warning', 'warning']);

  await act(async () => result.current.notifyInterrupted('cap_owned'));
  expect(played).toEqual(['warning', 'warning', 'warning']);
  act(() => result.current.notifyInterrupted('cap_owned'));
  expect(played).toEqual(['warning', 'warning', 'warning']);
});

test('prime unlocks audio during an async action gesture and unmount disposes it', () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ enabled: true, volume: 0.45 }),
  );
  setAudioSettings({ ...structuredClone(DEFAULT_AUDIO_SETTINGS), master: true });
  const { player } = fakePlayer();
  const { result, unmount } = renderHook(() =>
    useRecordingCues({ ...baseSignals, player }),
  );

  act(() => result.current.prime());
  expect(player.unlock).toHaveBeenCalledOnce();
  unmount();
  expect(player.dispose).toHaveBeenCalledOnce();
});

test('master off and per-event sound controls suppress playback', async () => {
  const { player, played } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));

  await act(async () => result.current.notifyFailure());
  expect(played).toEqual([]);

  act(() =>
    setAudioSettings({
      ...structuredClone(DEFAULT_AUDIO_SETTINGS),
      master: true,
      events: {
        ...structuredClone(DEFAULT_AUDIO_SETTINGS.events),
        error: { sound: false, voice: false },
      },
    }),
  );
  await act(async () => result.current.notifyFailure());
  expect(played).toEqual([]);
});

test('higher-priority voice interrupts and stale lower-priority voice is dropped', () => {
  const instances: FakeAudio[] = [];
  const playedSources: string[] = [];
  class FakeAudio {
    paused = true;
    preload = '';
    volume = 1;
    played = false;
    pauseCount = 0;
    constructor(readonly src: string) {
      instances.push(this);
    }
    load() {}
    play() {
      this.paused = false;
      this.played = true;
      playedSources.push(this.src);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.pauseCount += 1;
    }
    addEventListener() {}
  }
  vi.stubGlobal('Audio', FakeAudio);
  const successPhrase = phraseFor('success', 'en');
  const errorPhrase = phraseFor('error', 'en');
  setAudioSettings({
    ...structuredClone(DEFAULT_AUDIO_SETTINGS),
    master: true,
    soundEffects: false,
    assets: {
      [assetKey('success', successPhrase)]: '/success.wav',
      [assetKey('error', errorPhrase)]: '/error.wav',
    },
  });
  const { player } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));

  act(() => {
    result.current.emit('success');
    result.current.emit('save');
    result.current.emit('error');
  });

  expect(playedSources).toEqual(['/success.wav', '/error.wav']);
  const voice = instances.filter((audio) => audio.played);
  expect(voice).toHaveLength(1);
  expect(voice[0]!.pauseCount).toBeGreaterThanOrEqual(2);
  expect(voice[0]!.paused).toBe(false);
});

test('malformed persisted event settings and browser Audio errors never escape Collect', () => {
  window.localStorage.setItem(
    'kairos.audio-feedback.v2',
    JSON.stringify({
      ...DEFAULT_AUDIO_SETTINGS,
      master: true,
      events: { ...DEFAULT_AUDIO_SETTINGS.events, success: null },
    }),
  );
  __reloadAudioSettings();
  vi.stubGlobal(
    'Audio',
    class BrokenAudio {
      constructor() {
        throw new Error('audio backend failed');
      }
    },
  );
  const { player } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));

  expect(() => result.current.emit('success')).not.toThrow();
});

test('an emitter captured before Audio is disabled consults the live setting', () => {
  const played: string[] = [];
  class FakeAudio {
    paused = true;
    preload = '';
    volume = 1;
    onended: (() => void) | null = null;
    constructor(public src: string) {}
    load() {}
    play() {
      this.paused = false;
      played.push(this.src);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {}
  }
  vi.stubGlobal('Audio', FakeAudio);
  const phrase = phraseFor('success', 'en');
  setAudioSettings({
    ...structuredClone(DEFAULT_AUDIO_SETTINGS),
    master: true,
    soundEffects: false,
    assets: { [assetKey('success', phrase)]: '/success.wav' },
  });
  const { player } = fakePlayer();
  const { result } = renderHook(() => useRecordingCues({ ...baseSignals, player }));
  const staleEmit = result.current.emit;

  act(() => setAudioSettings({ ...getAudioSettings(), master: false }));
  act(() => staleEmit('success'));

  expect(played).toEqual([]);
});
