// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, cn } from '../../components/ui';
import { getFailReasons } from '../plans';
import { getAudioStatus, prepareAudioAssets } from '../audio/api';
import { assetKey, phraseFor, spokenPhraseFor } from '../audio/phrases';
import {
  AUDIO_EVENTS,
  getAudioSettings,
  resetAudioSettings,
  setAudioSettings,
  useAudioSettings,
  type AudioFeedbackEvent,
  type AudioSettings,
} from '../audio/settings';
import {
  playVoiceAsset,
  stopVoicePlayer,
  unlockVoicePlayer,
} from '../audio/voicePlayer';
import { createRecordingCuePlayer } from '../collect/recordingCues';

const LABELS: Record<AudioFeedbackEvent, string> = {
  start: 'Recording Start accepted',
  stop: 'Recording Stop completed',
  success: 'Success saved',
  failure: 'Failure selected',
  failure_reason: 'Failure reason saved',
  retake: 'Retake accepted',
  save: 'Save completed',
  invalid: 'Invalid shortcut action',
  error: 'Recording / Collect error',
};

function cueFor(event: AudioFeedbackEvent) {
  return event === 'stop'
    ? 'end'
    : event === 'failure_reason'
      ? 'failure'
      : event === 'error'
        ? 'warning'
        : event;
}

function voicevoxCredit(voice: string): string {
  const match = /^\d+:(.+?) \/ (.+)$/.exec(voice);
  return match ? `VOICEVOX:${match[1]} · ${match[2]}` : `VOICEVOX:${voice}`;
}

function phrasesFor(settings: AudioSettings, engine: string | null) {
  const base = AUDIO_EVENTS.filter((event) => event !== 'failure_reason').map(
    (event) => {
      const visibleText = phraseFor(event, settings.language);
      return {
        key: assetKey(event, visibleText),
        text: spokenPhraseFor(event, settings.language, engine),
        language: settings.language,
        voice: settings.voiceName,
      };
    },
  );
  return base.concat(
    getFailReasons().map((text) => ({
      key: assetKey('failure_reason', text),
      text,
      language: settings.language,
      voice: settings.voiceName,
    })),
  );
}

function phraseSetIdentity(phrases: ReturnType<typeof phrasesFor>): string {
  return JSON.stringify(
    phrases.map(({ key, text, language, voice }) => [key, text, language, voice]),
  );
}

export function AudioSection() {
  const settings = useAudioSettings();
  const [message, setMessage] = useState('');
  const cuePlayerRef = useRef<ReturnType<typeof createRecordingCuePlayer> | null>(null);
  cuePlayerRef.current ??= createRecordingCuePlayer();
  const cuePlayer = cuePlayerRef.current;
  useEffect(() => () => cuePlayer.dispose?.(), [cuePlayer]);
  const status = useQuery({
    queryKey: ['audio-status'],
    queryFn: ({ signal }) => getAudioStatus(signal),
  });
  const voices = status.data?.voices[settings.language] ?? [];
  const phrases = useMemo(
    () => phrasesFor(settings, status.data?.engine ?? null),
    [settings, status.data?.engine],
  );
  useEffect(() => {
    const engine = status.data?.engine;
    if (!status.data?.available || !engine) return;
    const current = getAudioSettings();
    const availableVoices = status.data.voices[current.language] ?? [];
    const voiceName = availableVoices.includes(current.voiceName)
      ? current.voiceName
      : (availableVoices[0] ?? current.voiceName);
    const providerChanged =
      current.preparedEngine !== null && current.preparedEngine !== engine;
    const legacyAssets =
      current.preparedEngine === null && Object.keys(current.assets).length > 0;
    if (voiceName === current.voiceName && !providerChanged && !legacyAssets) return;
    setAudioSettings({
      ...current,
      voiceName,
      preparedEngine: providerChanged || legacyAssets ? null : current.preparedEngine,
      assets: providerChanged || legacyAssets ? {} : current.assets,
    });
    if (providerChanged || legacyAssets)
      setMessage('Voice engine changed. Prepare voice assets again.');
  }, [status.data, settings.language]);
  const prepare = useMutation({
    mutationFn: (request: {
      language: typeof settings.language;
      voiceName: string;
      phrases: typeof phrases;
    }) => prepareAudioAssets(request.phrases),
    onSuccess: (result, request) => {
      const current = getAudioSettings();
      if (
        current.language !== request.language ||
        current.voiceName !== request.voiceName ||
        phraseSetIdentity(phrasesFor(current, result.engine)) !==
          phraseSetIdentity(request.phrases)
      ) {
        setMessage(
          'Voice selection changed while preparing. Prepare the current voice again.',
        );
        return;
      }
      const assets = { ...current.assets };
      result.assets.forEach((asset) => {
        assets[asset.key] = asset.url;
      });
      setAudioSettings({ ...current, assets, preparedEngine: result.engine });
      setMessage(
        result.deferred
          ? `${result.errors[0] ?? 'Voice preparation was deferred.'} Retry after recording stops.`
          : result.available
            ? result.errors.length
              ? `Prepared with ${result.errors.length} skipped phrase(s).`
              : `Voice assets ready (${result.assets.length}).`
            : 'Voice engine is unavailable. Sound effects remain available.',
      );
    },
    onError: () =>
      setMessage(
        'Voice preparation failed. Sound effects and Collect remain available.',
      ),
  });

  const patch = (next: Partial<typeof settings>) =>
    setAudioSettings({ ...getAudioSettings(), ...next });
  const previewSound = async (event: AudioFeedbackEvent) => {
    const played = await cuePlayer.play(cueFor(event), settings.volume);
    setMessage(
      played
        ? 'Sound preview sent to this browser.'
        : 'The browser blocked sound. Press Sound again to allow it.',
    );
  };
  const previewVoice = async (event: AudioFeedbackEvent, detail?: string) => {
    await unlockVoicePlayer();
    const text = phraseFor(event, settings.language, detail);
    const url = settings.assets[assetKey(event, text)];
    if (url) {
      const played = await playVoiceAsset(url, settings.volume);
      if (!played)
        setMessage('The browser blocked Voice. Press Voice again to allow it.');
      else setMessage(`Voice preview: ${settings.voiceName}.`);
    } else {
      setMessage('This Voice is not prepared. Press Prepare voice assets first.');
    }
  };

  return (
    <Card
      className="flex min-w-0 flex-col overflow-auto lg:col-span-2"
      data-testid="settings-audio"
    >
      <div className="border-b border-gray-100 px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Audio feedback
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
          Optional, browser-local confirmation for hands-busy Collect work. Visual state
          stays authoritative; missing audio never blocks an action.
        </p>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Toggle
            label="Audio feedback"
            checked={settings.master}
            onChange={(master) => {
              if (master) void unlockVoicePlayer();
              else stopVoicePlayer();
              patch({ master });
            }}
          />
          <Toggle
            label="Sound effects"
            checked={settings.soundEffects}
            onChange={(soundEffects) => patch({ soundEffects })}
          />
          <Toggle
            label="Voice / TTS"
            checked={settings.voice}
            onChange={(voice) => {
              if (!voice) stopVoicePlayer();
              patch({ voice });
            }}
          />
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-gray-700">
            Output volume
            <input
              aria-label="Output volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.volume}
              onChange={(event) => patch({ volume: Number(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-gray-700">
            Language
            <select
              value={settings.language}
              onChange={(event) =>
                patch({
                  language: event.target.value === 'ja' ? 'ja' : 'en',
                  voiceName:
                    status.data?.voices[
                      event.target.value === 'ja' ? 'ja' : 'en'
                    ]?.[0] ?? (event.target.value === 'ja' ? 'ja' : 'en-us'),
                  preparedEngine: null,
                  assets: {},
                })
              }
              className="h-9 rounded-control border border-gray-200 px-2"
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-gray-700">
            Voice
            <select
              value={settings.voiceName}
              disabled={!status.data?.available}
              onChange={(event) =>
                patch({
                  voiceName: event.target.value,
                  preparedEngine: null,
                  assets: {},
                })
              }
              className="h-9 rounded-control border border-gray-200 px-2 disabled:opacity-50"
            >
              {(voices.length ? voices : [settings.voiceName]).map((voice) => (
                <option key={voice}>{voice}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="rounded-control border border-gray-100">
          <div className="grid grid-cols-[minmax(180px,1fr)_56px_56px_72px_72px] border-b border-gray-100 bg-gray-50 px-3 py-2 text-[10.5px] font-bold uppercase tracking-wide text-gray-500">
            <span>Confirmed event / phrase</span>
            <span>Sound</span>
            <span>Voice</span>
            <span>Test SFX</span>
            <span>Test voice</span>
          </div>
          {AUDIO_EVENTS.map((event) => {
            const phrase = phraseFor(event, settings.language);
            return (
              <div
                key={event}
                className="grid min-h-14 grid-cols-[minmax(180px,1fr)_56px_56px_72px_72px] items-center border-b border-gray-100 px-3 last:border-0"
              >
                <span className="min-w-0 pr-2 text-[12.5px] text-gray-700">
                  {LABELS[event]}
                  <span className="block truncate text-[11px] font-normal text-gray-500">
                    {phrase || 'Uses the selected task failure reason'}
                  </span>
                </span>
                {(['sound', 'voice'] as const).map((kind) => (
                  <input
                    key={kind}
                    aria-label={`${LABELS[event]} ${kind}`}
                    type="checkbox"
                    checked={settings.events[event][kind]}
                    onChange={(e) => {
                      const current = getAudioSettings();
                      setAudioSettings({
                        ...current,
                        events: {
                          ...current.events,
                          [event]: {
                            ...current.events[event],
                            [kind]: e.target.checked,
                          },
                        },
                      });
                    }}
                  />
                ))}
                <button
                  type="button"
                  aria-label={`Preview sound for ${LABELS[event]}`}
                  onClick={() => void previewSound(event)}
                  className="min-h-9 rounded-control border border-gray-200 px-2 text-[11px] font-semibold text-teal-700"
                >
                  Sound
                </button>
                <button
                  type="button"
                  aria-label={`Preview voice for ${LABELS[event]}`}
                  onClick={() =>
                    void previewVoice(
                      event,
                      event === 'failure_reason' ? getFailReasons()[0] : undefined,
                    )
                  }
                  className="min-h-9 rounded-control border border-gray-200 px-2 text-[11px] font-semibold text-teal-700"
                >
                  Voice
                </button>
              </div>
            );
          })}
        </div>
        <div className="rounded-control border border-gray-100 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Task failure reason phrases
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {getFailReasons().map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => void previewVoice('failure_reason', reason)}
                className="min-h-9 rounded-control border border-gray-200 px-2 text-[11.5px] text-gray-700"
              >
                {reason} · Voice
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              prepare.mutate({
                language: settings.language,
                voiceName: settings.voiceName,
                phrases,
              })
            }
            disabled={
              !status.data?.available || voices.length === 0 || prepare.isPending
            }
            className="min-h-11 rounded-control bg-teal-700 px-3 text-[12.5px] font-semibold text-white disabled:opacity-50"
          >
            {prepare.isPending ? 'Preparing…' : 'Prepare voice assets'}
          </button>
          <button
            type="button"
            onClick={() => {
              resetAudioSettings();
              stopVoicePlayer();
              setMessage('Audio settings reset. Audio feedback is Off.');
            }}
            className="min-h-11 rounded-control border border-dashed border-gray-300 px-3 text-[12.5px] font-semibold text-teal-700"
          >
            Reset to defaults
          </button>
        </div>
        <div
          role="status"
          className={cn(
            'rounded-control border px-3 py-2 text-[12px]',
            status.data?.available
              ? 'border-teal-200 bg-teal-50 text-teal-800'
              : 'border-amber-200 bg-amber-50 text-amber-800',
          )}
        >
          {message ||
            (status.isLoading
              ? 'Checking local voice engine…'
              : status.isError
                ? 'Could not reach the voice service. Retry by reopening Audio settings; Collect is unaffected.'
                : status.data?.available
                  ? `Voice engine ready: ${status.data.engine}. Prepare assets after changing language, voice, or failure reasons.`
                  : `Configured voice provider ${status.data?.configured_provider ?? 'unknown'} is unavailable. Sound effects still work; Collect is unaffected.`)}
          {status.data?.engine === 'espeak-ng' && settings.language === 'ja' ? (
            <span className="mt-1 block">
              eSpeak uses kana for built-in phrases. Write custom failure reasons in
              hiragana or katakana, or select the VOICEVOX provider.
            </span>
          ) : null}
          {status.data?.engine?.includes('voicevox') &&
          settings.language === 'ja' ? (
            <span className="mt-1 block">{voicevoxCredit(settings.voiceName)}</span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between rounded-control border border-gray-100 px-3 text-[12.5px] font-semibold text-gray-700">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
