// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import type { AudioFeedbackEvent, AudioLanguage } from './settings';

const PHRASES: Record<
  AudioLanguage,
  Record<Exclude<AudioFeedbackEvent, 'failure_reason'>, string>
> = {
  en: {
    start: 'Recording',
    stop: 'Stopped',
    success: 'Success',
    failure: 'Failure',
    retake: 'Retake',
    save: 'Saved',
    invalid: 'Invalid action',
    error: 'Error',
  },
  ja: {
    start: '録画開始',
    stop: '録画停止',
    success: '成功',
    failure: '失敗',
    retake: '撮り直し',
    save: '保存しました',
    invalid: '操作できません',
    error: 'エラー',
  },
};

export function phraseFor(
  event: AudioFeedbackEvent,
  language: AudioLanguage,
  detail?: string,
): string {
  return event === 'failure_reason' ? (detail ?? '') : PHRASES[language][event];
}

export function assetKey(event: AudioFeedbackEvent, phrase: string): string {
  let hash = 2166136261;
  for (const char of phrase) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${event}:${(hash >>> 0).toString(16)}`;
}
