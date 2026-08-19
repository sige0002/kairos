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
  const playerRef = useRef<RecordingCuePlayer | null>(null);
  playerRef.current ??= suppliedPlayer ?? createRecordingCuePlayer();
  const player = playerRef.current;
  const initialRef = useRef<StoredSettings | null>(null);
  initialRef.current ??= readSettings();
  const [enabled, setEnabledState] = useState(
    player.supported && initialRef.current.enabled,
  );
  const [volume, setVolumeState] = useState(initialRef.current.volume);
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
      setEnabledState(next);
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
    [player, volume],
  );

  const setVolume = useCallback(
    (next: number) => {
      const clamped = clampVolume(next);
      setVolumeState(clamped);
      persistSettings({ enabled, volume: clamped });
    },
    [enabled],
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
    void play('start');
  }, [
    phase,
    currentCaptureId,
    recorderReachable,
    statusCaptureId,
    statusState,
    liveCaptures,
    play,
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
      void play('end');
    },
    [play],
  );

  const notifyFailure = useCallback(() => {
    abandonStart();
    void play('warning');
  }, [abandonStart, play]);

  const warnOnce = useCallback(
    (key: string) => {
      if (warnedRef.current.has(key)) return;
      warnedRef.current.add(key);
      void play('warning');
    },
    [play],
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
  };
}
