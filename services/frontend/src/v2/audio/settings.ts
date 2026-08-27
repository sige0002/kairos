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
  preparedEngine: string | null;
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
  preparedEngine: null,
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

function normalizeEvent(
  value: unknown,
  fallback: EventAudioSetting,
): EventAudioSetting {
  if (!value || typeof value !== 'object') return { ...fallback };
  const candidate = value as Partial<EventAudioSetting>;
  return {
    sound: typeof candidate.sound === 'boolean' ? candidate.sound : fallback.sound,
    voice: typeof candidate.voice === 'boolean' ? candidate.voice : fallback.voice,
  };
}

function normalizeSettings(value: unknown): AudioSettings {
  if (!value || typeof value !== 'object')
    return structuredClone(DEFAULT_AUDIO_SETTINGS);
  const raw = value as Partial<AudioSettings>;
  if (raw.version !== 2) return structuredClone(DEFAULT_AUDIO_SETTINGS);
  const rawEvents = raw.events && typeof raw.events === 'object' ? raw.events : {};
  const events = Object.fromEntries(
    AUDIO_EVENTS.map((event) => [
      event,
      normalizeEvent(
        (rawEvents as Partial<Record<AudioFeedbackEvent, unknown>>)[event],
        DEFAULT_AUDIO_SETTINGS.events[event],
      ),
    ]),
  ) as Record<AudioFeedbackEvent, EventAudioSetting>;
  const assets =
    raw.assets && typeof raw.assets === 'object'
      ? Object.fromEntries(
          Object.entries(raw.assets).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    version: 2,
    master: raw.master === true,
    soundEffects:
      typeof raw.soundEffects === 'boolean'
        ? raw.soundEffects
        : DEFAULT_AUDIO_SETTINGS.soundEffects,
    voice: typeof raw.voice === 'boolean' ? raw.voice : DEFAULT_AUDIO_SETTINGS.voice,
    volume: clampVolume(raw.volume),
    language: raw.language === 'ja' ? 'ja' : 'en',
    voiceName:
      typeof raw.voiceName === 'string' && raw.voiceName
        ? raw.voiceName
        : DEFAULT_AUDIO_SETTINGS.voiceName,
    preparedEngine: typeof raw.preparedEngine === 'string' ? raw.preparedEngine : null,
    events,
    assets,
  };
}

function load(): AudioSettings {
  if (typeof window === 'undefined') return structuredClone(DEFAULT_AUDIO_SETTINGS);
  try {
    return normalizeSettings(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'),
    );
  } catch {
    return structuredClone(DEFAULT_AUDIO_SETTINGS);
  }
}

export function getAudioSettings(): AudioSettings {
  return snapshot;
}

export function setAudioSettings(next: AudioSettings): void {
  snapshot = normalizeSettings(next);
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
