// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Browser-local, opt-in auditory feedback for recording boundaries. The cues
// are subordinate to the persistent visual state and alerts: failure to play
// audio never changes the recording state machine.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordState } from '../../../api/types';
import type { Phase } from '../machine/types';
import {
  createRecordingCuePlayer,
  type RecordingCueKind,
  type RecordingCuePlayer,
} from '../recordingCues';
import { assetKey, phraseFor } from '../../audio/phrases';
import {
  setAudioSettings,
  useAudioSettings,
  type AudioFeedbackEvent,
} from '../../audio/settings';

const STORAGE_KEY = 'kairos.collect.recording-cues.v1';
const DEFAULT_VOLUME = 0.45;

export type RecordingCuePlaybackState =
  | 'disabled'
  | 'ready'
  | 'blocked'
  | 'unsupported';

export interface RecordingCueSettings {
  enabled: boolean;
  volume: number;
  playbackState: RecordingCuePlaybackState;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  preview: (kind: RecordingCueKind) => void;
}

interface StoredSettings {
  enabled: boolean;
  volume: number;
}

function clampVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : DEFAULT_VOLUME;
}

function readSettings(): StoredSettings {
  if (typeof window === 'undefined') return { enabled: false, volume: DEFAULT_VOLUME };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<StoredSettings> | null;
    return {
      enabled: parsed?.enabled === true,
      volume: clampVolume(parsed?.volume),
    };
  } catch {
    return { enabled: false, volume: DEFAULT_VOLUME };
  }
}

function persistSettings(settings: StoredSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full store: the setting still works for this mount.
  }
}

export function useRecordingCues({
  phase,
  currentCaptureId,
  recorderReachable,
  statusCaptureId,
  statusState,
  liveCaptures,
  player: suppliedPlayer,
}: {
  phase: Phase;
  currentCaptureId: string | null;
  recorderReachable: boolean;
  statusCaptureId: string | null | undefined;
  statusState: RecordState | undefined;
  liveCaptures: string[] | null;
  /** Test seam; production uses the lazy Web Audio player. */
  player?: RecordingCuePlayer;
}) {
  const audioSettings = useAudioSettings();
  const playerRef = useRef<RecordingCuePlayer | null>(null);
  playerRef.current ??= suppliedPlayer ?? createRecordingCuePlayer();
  const player = playerRef.current;
  const initialRef = useRef<StoredSettings | null>(null);
  initialRef.current ??= readSettings();
  const enabled = player.supported && audioSettings.master;
  const volume =
    audioSettings.version === 2 ? audioSettings.volume : initialRef.current.volume;
  const [playbackState, setPlaybackState] = useState<RecordingCuePlaybackState>(
    !player.supported ? 'unsupported' : enabled ? 'ready' : 'disabled',
  );

  useEffect(() => () => player.dispose?.(), [player]);

  const play = useCallback(
    async (kind: RecordingCueKind) => {
      if (!enabled || !player.supported) return;
      const played = await player.play(kind, volume);
      setPlaybackState(played ? 'ready' : 'blocked');
    },
    [enabled, player, volume],
  );

  const setEnabled = useCallback(
    (next: boolean) => {
      if (next && !player.supported) {
        setPlaybackState('unsupported');
        return;
      }
      setAudioSettings({ ...audioSettings, master: next });
      persistSettings({ enabled: next, volume });
      if (!next) {
        setPlaybackState(player.supported ? 'disabled' : 'unsupported');
        return;
      }
      if (!player.supported) {
        setPlaybackState('unsupported');
        return;
      }
      void player
        .unlock()
        .then((unlocked) => setPlaybackState(unlocked ? 'ready' : 'blocked'));
    },
    [audioSettings, player, volume],
  );

  const setVolume = useCallback(
    (next: number) => {
      const clamped = clampVolume(next);
      setAudioSettings({ ...audioSettings, volume: clamped });
      persistSettings({ enabled, volume: clamped });
    },
    [audioSettings, enabled],
  );

  const voiceRef = useRef<HTMLAudioElement | null>(null);
  const voicePriorityRef = useRef(0);
  const priority: Record<AudioFeedbackEvent, number> = {
    save: 1,
    start: 2,
    stop: 2,
    success: 3,
    failure: 3,
    failure_reason: 4,
    retake: 5,
    invalid: 6,
    error: 7,
  };

  useEffect(() => {
    if (!enabled || !audioSettings.voice) return;
    try {
      for (const url of Object.values(audioSettings.assets)) {
        const audio = new Audio(url);
        audio.preload = 'auto';
        audio.load();
      }
    } catch {
      // Audio is advisory. A browser implementation may reject construction.
    }
  }, [audioSettings.assets, audioSettings.voice, enabled]);

  const stopVoice = useCallback(() => {
    try {
      voiceRef.current?.pause();
    } catch {
      // Audio teardown must never escape into Collect.
    }
    voiceRef.current = null;
    voicePriorityRef.current = 0;
  }, []);

  useEffect(() => {
    if (!enabled || !audioSettings.voice) stopVoice();
    return stopVoice;
  }, [audioSettings.voice, enabled, stopVoice]);

  const emit = useCallback(
    (event: AudioFeedbackEvent, detail?: string) => {
      try {
        if (!enabled) return;
        const eventSettings = audioSettings.events[event];
        const cue: RecordingCueKind =
          event === 'stop'
            ? 'end'
            : event === 'failure_reason'
              ? 'failure'
              : event === 'error'
                ? 'warning'
                : event;
        if (audioSettings.soundEffects && eventSettings.sound)
          void play(cue).catch(() => {});
        if (!audioSettings.voice || !eventSettings.voice) return;
        const phrase = phraseFor(event, audioSettings.language, detail);
        const url = audioSettings.assets[assetKey(event, phrase)];
        if (!url) return;
        if (voiceRef.current && !voiceRef.current.paused) {
          if (priority[event] <= voicePriorityRef.current) return;
          voiceRef.current.pause();
        }
        const audio = new Audio(url);
        audio.volume = audioSettings.volume;
        voiceRef.current = audio;
        voicePriorityRef.current = priority[event];
        audio.addEventListener(
          'ended',
          () => {
            if (voiceRef.current === audio) {
              voiceRef.current = null;
              voicePriorityRef.current = 0;
            }
          },
          { once: true },
        );
        void audio.play().catch(() => setPlaybackState('blocked'));
      } catch {
        setPlaybackState('blocked');
      }
    },
    [audioSettings, enabled, play],
  );

  const preview = useCallback(
    (kind: RecordingCueKind) => {
      void play(kind);
    },
    [play],
  );

  // Ownership exists only in this mounted browser tab. It is deliberately not
  // persisted: reload, hydration and takeover must never replay success cues.
  const startRequestedRef = useRef(false);
  const ownedCaptureRef = useRef<string | null>(null);
  const startPlayedRef = useRef<string | null>(null);
  const stopRequestedRef = useRef<string | null>(null);
  const stopPlayedRef = useRef<string | null>(null);
  const warnedRef = useRef(new Set<string>());

  const markStartRequested = useCallback(() => {
    startRequestedRef.current = true;
    if (enabled) void player.unlock();
  }, [enabled, player]);

  /** Prime Web Audio synchronously from gestures whose eventual start happens
   *  after asynchronous work (notably Retake's discard). */
  const prime = useCallback(() => {
    if (enabled) void player.unlock();
  }, [enabled, player]);

  const claimStartedCapture = useCallback((captureId: string | null) => {
    if (!startRequestedRef.current) return;
    startRequestedRef.current = false;
    if (!captureId) return;
    ownedCaptureRef.current = captureId;
  }, []);

  const abandonStart = useCallback(() => {
    startRequestedRef.current = false;
  }, []);

  // A successful start response is not the cue. The recorder must freshly name
  // this tab's capture as both `recording` and live before it becomes a go-signal.
  useEffect(() => {
    const owned = ownedCaptureRef.current;
    if (!owned || startPlayedRef.current === owned) return;
    if (phase !== 'recording' || currentCaptureId !== owned) return;
    if (!recorderReachable || statusCaptureId !== owned) return;
    if (statusState !== 'recording' || !liveCaptures?.includes(owned)) return;
    startPlayedRef.current = owned;
    emit('start');
  }, [
    phase,
    currentCaptureId,
    recorderReachable,
    statusCaptureId,
    statusState,
    liveCaptures,
    emit,
  ]);

  const markStopRequested = useCallback(
    (captureId: string | null) => {
      if (!captureId || ownedCaptureRef.current !== captureId) return;
      stopRequestedRef.current = captureId;
      if (enabled) void player.unlock();
    },
    [enabled, player],
  );

  const confirmStop = useCallback(
    (captureId: string | null) => {
      if (!captureId || stopRequestedRef.current !== captureId) return;
      if (ownedCaptureRef.current !== captureId || stopPlayedRef.current === captureId)
        return;
      stopPlayedRef.current = captureId;
      stopRequestedRef.current = null;
      emit('stop');
    },
    [emit],
  );

  const notifyFailure = useCallback(() => {
    abandonStart();
    emit('error');
  }, [abandonStart, emit]);

  const warnOnce = useCallback(
    (key: string) => {
      if (warnedRef.current.has(key)) return;
      warnedRef.current.add(key);
      emit('error');
    },
    [emit],
  );

  // Losing the recorder while an owned capture is active is uncertain, not a
  // normal end. One attention cue sends the operator back to the persistent UI.
  useEffect(() => {
    const owned = ownedCaptureRef.current;
    if (
      owned &&
      phase === 'recording' &&
      currentCaptureId === owned &&
      !recorderReachable
    )
      warnOnce(`unreachable:${owned}`);
  }, [phase, currentCaptureId, recorderReachable, warnOnce]);

  const notifyInterrupted = useCallback(
    (captureId: string | null) => {
      if (!captureId || ownedCaptureRef.current !== captureId) return;
      warnOnce(`interrupted:${captureId}`);
    },
    [warnOnce],
  );

  return {
    settings: {
      enabled,
      volume,
      playbackState,
      setEnabled,
      setVolume,
      preview,
    } satisfies RecordingCueSettings,
    prime,
    markStartRequested,
    claimStartedCapture,
    abandonStart,
    markStopRequested,
    confirmStop,
    notifyFailure,
    notifyInterrupted,
    emit,
  };
}
