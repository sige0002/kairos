// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  getAudioSettings,
  setAudioSettings,
  useAudioSettings,
} from './settings';

beforeEach(() => {
  window.localStorage.clear();
  setAudioSettings(structuredClone(DEFAULT_AUDIO_SETTINGS));
});

test('an already-open tab adopts audio settings written by another tab', () => {
  const { result } = renderHook(() => useAudioSettings());
  const next = { ...getAudioSettings(), master: true, volume: 0.8 };

  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'kairos.audio-feedback.v2',
        newValue: JSON.stringify(next),
        storageArea: window.localStorage,
      }),
    );
  });

  expect(result.current.master).toBe(true);
  expect(result.current.volume).toBe(0.8);
});
