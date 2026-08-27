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

// eSpeak's Japanese dictionary does not reliably read kanji. Keep the visible
// UI phrases natural, but give that lightweight fallback kana for the fixed
// built-in announcements. User-defined failure reasons remain unchanged;
// neural Japanese providers can read them directly.
const ESPEAK_JA_PHRASES: Record<
  Exclude<AudioFeedbackEvent, 'failure_reason'>,
  string
> = {
  start: 'ろくがかいし',
  stop: 'ろくがていし',
  success: 'せいこう',
  failure: 'しっぱい',
  retake: 'とりなおし',
  save: 'ほぞんしました',
  invalid: 'そうさできません',
  error: 'えらあ',
};

export function phraseFor(
  event: AudioFeedbackEvent,
  language: AudioLanguage,
  detail?: string,
): string {
  return event === 'failure_reason' ? (detail ?? '') : PHRASES[language][event];
}

export function spokenPhraseFor(
  event: AudioFeedbackEvent,
  language: AudioLanguage,
  engine: string | null,
  detail?: string,
): string {
  if (event === 'failure_reason') return detail ?? '';
  if (language === 'ja' && engine === 'espeak-ng') return ESPEAK_JA_PHRASES[event];
  return PHRASES[language][event];
}

export function assetKey(event: AudioFeedbackEvent, phrase: string): string {
  let hash = 2166136261;
  for (const char of phrase) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${event}:${(hash >>> 0).toString(16)}`;
}
