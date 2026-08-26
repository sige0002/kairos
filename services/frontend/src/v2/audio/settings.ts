// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { useSyncExternalStore } from 'react';

export const AUDIO_EVENTS = [
  'start',
  'stop',
  'success',
  'failure',
  'failure_reason',
  'retake',
  'save',
  'invalid',
  'error',
] as const;
export type AudioFeedbackEvent = (typeof AUDIO_EVENTS)[number];
export type AudioLanguage = 'en' | 'ja';

export interface EventAudioSetting {
  sound: boolean;
  voice: boolean;
}

export interface AudioSettings {
  version: 2;
  master: boolean;
  soundEffects: boolean;
  voice: boolean;
  volume: number;
  language: AudioLanguage;
  voiceName: string;
  events: Record<AudioFeedbackEvent, EventAudioSetting>;
  assets: Record<string, string>;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  version: 2,
  master: false,
  soundEffects: true,
  voice: true,
  volume: 0.45,
  language: 'en',
  voiceName: 'en-us',
  events: {
    start: { sound: true, voice: false },
    stop: { sound: true, voice: false },
    success: { sound: true, voice: true },
    failure: { sound: true, voice: true },
    failure_reason: { sound: false, voice: true },
    retake: { sound: true, voice: true },
    save: { sound: true, voice: false },
    invalid: { sound: true, voice: false },
    error: { sound: true, voice: true },
  },
  assets: {},
};

const STORAGE_KEY = 'kairos.audio-feedback.v2';
let snapshot = load();
const listeners = new Set<() => void>();

function clampVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : DEFAULT_AUDIO_SETTINGS.volume;
}

function load(): AudioSettings {
  if (typeof window === 'undefined') return structuredClone(DEFAULT_AUDIO_SETTINGS);
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as
      | Partial<AudioSettings>
      | null;
    if (raw?.version !== 2) return structuredClone(DEFAULT_AUDIO_SETTINGS);
    return {
      ...structuredClone(DEFAULT_AUDIO_SETTINGS),
      ...raw,
      volume: clampVolume(raw.volume),
      language: raw.language === 'ja' ? 'ja' : 'en',
      events: { ...structuredClone(DEFAULT_AUDIO_SETTINGS.events), ...raw.events },
      assets: raw.assets ?? {},
    };
  } catch {
    return structuredClone(DEFAULT_AUDIO_SETTINGS);
  }
}

export function getAudioSettings(): AudioSettings {
  return snapshot;
}

export function setAudioSettings(next: AudioSettings): void {
  snapshot = { ...next, volume: clampVolume(next.volume) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // The terminal keeps the in-memory setting when browser storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

export function updateAudioSettings(patch: Partial<AudioSettings>): void {
  setAudioSettings({ ...snapshot, ...patch });
}

export function resetAudioSettings(): void {
  setAudioSettings(structuredClone(DEFAULT_AUDIO_SETTINGS));
}

export function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAudioSettings,
    getAudioSettings,
  );
}

export function __reloadAudioSettings(): void {
  snapshot = load();
  listeners.forEach((listener) => listener());
}
