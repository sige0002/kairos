// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { apiGet, apiPost } from '../../api/client';
import type { AudioLanguage } from './settings';

export interface AudioStatus {
  available: boolean;
  engine: string | null;
  model_revision: string | null;
  voices: Partial<Record<AudioLanguage, string[]>>;
}

export interface PreparedAudioAssets {
  available: boolean;
  engine: string | null;
  model_revision: string | null;
  assets: { key: string; asset_id: string; url: string }[];
  errors: string[];
  deferred: boolean;
}

export function getAudioStatus(signal?: AbortSignal): Promise<AudioStatus> {
  return apiGet('/audio/status', { signal });
}

export function prepareAudioAssets(
  phrases: {
    key: string;
    text: string;
    language: AudioLanguage;
    voice: string;
    speed: number;
  }[],
): Promise<PreparedAudioAssets> {
  return apiPost(
    '/audio/assets',
    { phrases, release_prearm: true },
    { timeoutMs: 600_000 },
  );
}
