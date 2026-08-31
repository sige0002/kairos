// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, cn } from '../../components/ui';
import { getFailReasons, useFailReasons } from '../plans';
import { getAudioStatus, prepareAudioAssets } from '../audio/api';
import { assetKey, phraseFor } from '../audio/phrases';
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
import { useTranslation } from 'react-i18next';

function cueFor(event: AudioFeedbackEvent) {
  return event === 'stop'
    ? 'end'
    : event === 'failure_reason'
      ? 'failure'
      : event === 'error'
        ? 'warning'
        : event;
}

const VOICE_LABELS: Record<string, string> = {
  af_heart: 'Heart · US female',
  af_bella: 'Bella · US female',
  am_michael: 'Michael · US male',
  bf_emma: 'Emma · UK female',
  jf_alpha: 'Alpha · 日本語 女性',
  jf_gongitsune: 'Gongitsune · 日本語 女性',
  jf_nezumi: 'Nezumi · 日本語 女性',
  jf_tebukuro: 'Tebukuro · 日本語 女性',
  jm_kumo: 'Kumo · 日本語 男性',
};

function phrasesFor(settings: AudioSettings, failureReasons = getFailReasons()) {
  const base = AUDIO_EVENTS.filter((event) => event !== 'failure_reason').map(
    (event) => {
      const visibleText = phraseFor(event, settings.language);
      return {
        key: assetKey(event, visibleText),
        text: visibleText,
        language: settings.language,
        voice: settings.voiceName,
        speed: settings.speechRate,
      };
    },
  );
  return base.concat(
    failureReasons.map((text) => ({
      key: assetKey('failure_reason', text),
      text,
      language: settings.language,
      voice: settings.voiceName,
      speed: settings.speechRate,
    })),
  );
}

function phraseSetIdentity(phrases: ReturnType<typeof phrasesFor>): string {
  return JSON.stringify(
    phrases.map(({ key, text, language, voice, speed }) => [
      key,
      text,
      language,
      voice,
      speed,
    ]),
  );
}

export function AudioSection() {
  const { t } = useTranslation('settings');
  const settings = useAudioSettings();
  const failureReasons = useFailReasons();
  const [message, setMessage] = useState('');
  const cuePlayerRef = useRef<ReturnType<typeof createRecordingCuePlayer> | null>(null);
  cuePlayerRef.current ??= createRecordingCuePlayer();
  const cuePlayer = cuePlayerRef.current;
  useEffect(() => () => cuePlayer.dispose?.(), [cuePlayer]);
  const status = useQuery({
    queryKey: ['audio-status'],
    queryFn: ({ signal }) => getAudioStatus(signal),
  });
  useEffect(() => {
    const catalog = status.data;
    if (!catalog?.available) return;
    const current = getAudioSettings();
    const candidates = catalog.voices[current.language] ?? [];
    const voiceName = candidates.includes(current.voiceName)
      ? current.voiceName
      : candidates[0];
    if (!voiceName) return;
    const modelRevision = catalog.model_revision ?? null;
    const preparedIsStale =
      current.preparedEngine !== null &&
      (current.preparedEngine !== catalog.engine ||
        current.preparedModelRevision !== modelRevision);
    if (voiceName !== current.voiceName || preparedIsStale) {
      setAudioSettings({
        ...current,
        voiceName,
        preparedEngine: null,
        preparedModelRevision: null,
        assets: {},
      });
    }
  }, [status.data]);
  const voices = status.data?.voices[settings.language] ?? [];
  const phrases = useMemo(
    () => phrasesFor(settings, failureReasons),
    [failureReasons, settings],
  );
  const prepare = useMutation({
    mutationFn: (request: {
      language: typeof settings.language;
      voiceName: string;
      speechRate: number;
      phrases: typeof phrases;
    }) => prepareAudioAssets(request.phrases),
    onSuccess: (result, request) => {
      const current = getAudioSettings();
      if (
        current.language !== request.language ||
        current.voiceName !== request.voiceName ||
        current.speechRate !== request.speechRate
      ) {
        setMessage(t('audio.selectionChanged'));
        return;
      }
      const currentPhrases = phrasesFor(current);
      const phraseSetChanged =
        phraseSetIdentity(currentPhrases) !== phraseSetIdentity(request.phrases);
      const currentKeys = new Set(currentPhrases.map((phrase) => phrase.key));
      const assets = Object.fromEntries(
        Object.entries(current.assets).filter(([key]) => currentKeys.has(key)),
      );
      const acceptedAssets = result.assets.filter((asset) =>
        currentKeys.has(asset.key),
      );
      acceptedAssets.forEach((asset) => {
        assets[asset.key] = asset.url;
      });
      setAudioSettings({
        ...current,
        assets,
        preparedEngine: result.engine,
        preparedModelRevision: result.model_revision,
      });
      setMessage(
        result.deferred
          ? t('audio.prepareDeferred', {
              reason: result.errors[0] ?? t('audio.prepareDeferredDefault'),
            })
          : phraseSetChanged
            ? acceptedAssets.length
              ? t('audio.assetsReadyReasonsChanged', {
                  count: acceptedAssets.length,
                })
              : t('audio.reasonsChanged')
            : result.available
              ? result.errors.length
                ? acceptedAssets.length
                  ? t('audio.assetsReadyPartial', {
                      ready: String(acceptedAssets.length),
                      count: result.errors.length,
                    })
                  : `${result.errors[0] ?? t('audio.noAssets')}`
                : t('audio.ready')
              : t('audio.engineUnavailable'),
      );
    },
    onError: () => setMessage(t('audio.prepareFailed')),
  });

  const patch = (next: Partial<typeof settings>) =>
    setAudioSettings({ ...getAudioSettings(), ...next });
  const previewSound = async (event: AudioFeedbackEvent) => {
    const played = await cuePlayer.play(cueFor(event), settings.volume);
    setMessage(played ? t('audio.soundSent') : t('audio.soundBlocked'));
  };
  const previewVoice = async (event: AudioFeedbackEvent, detail?: string) => {
    await unlockVoicePlayer();
    if (prepare.isPending) {
      setMessage(t('audio.voicePreparing'));
      return;
    }
    const text = phraseFor(event, settings.language, detail);
    const url = settings.assets[assetKey(event, text)];
    if (url) {
      const played = await playVoiceAsset(url, settings.volume);
      if (!played) setMessage(t('audio.voiceBlocked'));
      else setMessage(t('audio.voicePreview', { voice: settings.voiceName }));
    } else {
      setMessage(
        settings.preparedEngine ? t('audio.voiceRetry') : t('audio.voiceNotPrepared'),
      );
    }
  };

  return (
    <Card
      className="flex min-w-0 flex-col overflow-auto lg:col-span-2"
      data-testid="settings-audio"
    >
      <div className="border-b border-border px-4 py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('audio.title')}
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
          {t('audio.description')}
        </p>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Toggle
            label={t('audio.master')}
            checked={settings.master}
            onChange={(master) => {
              if (master) void unlockVoicePlayer();
              else stopVoicePlayer();
              patch({ master });
            }}
          />
          <Toggle
            label={t('audio.sound')}
            checked={settings.soundEffects}
            onChange={(soundEffects) => patch({ soundEffects })}
          />
          <Toggle
            label={t('audio.voice')}
            checked={settings.voice}
            onChange={(voice) => {
              if (!voice) stopVoicePlayer();
              patch({ voice });
            }}
          />
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-primary">
            {t('audio.volume')}
            <input
              aria-label={t('audio.volume')}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.volume}
              onChange={(event) => patch({ volume: Number(event.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-primary">
            {t('audio.language')}
            <select
              value={settings.language}
              onChange={(event) =>
                patch({
                  language: event.target.value === 'ja' ? 'ja' : 'en',
                  voiceName:
                    status.data?.voices[
                      event.target.value === 'ja' ? 'ja' : 'en'
                    ]?.[0] ?? (event.target.value === 'ja' ? 'jf_alpha' : 'af_heart'),
                  preparedEngine: null,
                  preparedModelRevision: null,
                  assets: {},
                })
              }
              className="h-9 rounded-control border border-border px-2"
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-primary">
            {t('audio.voiceName')}
            <select
              value={settings.voiceName}
              disabled={!status.data?.available}
              onChange={(event) => {
                const voiceName = event.currentTarget.value;
                setAudioSettings({
                  ...getAudioSettings(),
                  voiceName,
                  preparedEngine: null,
                  preparedModelRevision: null,
                  assets: {},
                });
              }}
              className="h-9 rounded-control border border-border px-2 disabled:opacity-50"
            >
              {(voices.length ? voices : [settings.voiceName]).map((voice) => (
                <option key={voice} value={voice}>
                  {VOICE_LABELS[voice] ?? voice}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-text-primary">
            {t('audio.speechRate', { rate: settings.speechRate.toFixed(2) })}
            <input
              aria-label={t('audio.speechRate', {
                rate: settings.speechRate.toFixed(2),
              })}
              type="range"
              min="0.75"
              max="1.25"
              step="0.05"
              value={settings.speechRate}
              onChange={(event) => {
                const speechRate = Number(event.currentTarget.value);
                setAudioSettings({
                  ...getAudioSettings(),
                  speechRate,
                  preparedEngine: null,
                  preparedModelRevision: null,
                  assets: {},
                });
              }}
            />
          </label>
        </div>
        <div className="rounded-control border border-border">
          <div className="grid grid-cols-[minmax(180px,1fr)_56px_56px_72px_72px] border-b border-border bg-surface-muted px-3 py-2 text-[10.5px] font-bold uppercase tracking-wide text-text-muted">
            <span>{t('audio.event')}</span>
            <span>{t('audio.sound')}</span>
            <span>{t('audio.voice')}</span>
            <span>{t('audio.testSound')}</span>
            <span>{t('audio.testVoice')}</span>
          </div>
          {AUDIO_EVENTS.map((event) => {
            const phrase = phraseFor(event, settings.language);
            return (
              <div
                key={event}
                className="grid min-h-14 grid-cols-[minmax(180px,1fr)_56px_56px_72px_72px] items-center border-b border-border px-3 last:border-0"
              >
                <span className="min-w-0 pr-2 text-[12.5px] text-text-primary">
                  {t(`audio.events.${event}`)}
                  <span className="block truncate text-[11px] font-normal text-text-muted">
                    {phrase || t('audio.usesReason')}
                  </span>
                </span>
                {(['sound', 'voice'] as const).map((kind) => (
                  <input
                    key={kind}
                    aria-label={`${t(`audio.events.${event}`)} ${kind === 'sound' ? t('audio.sound') : t('audio.voice')}`}
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
                  aria-label={t('audio.previewSound', {
                    event: t(`audio.events.${event}`),
                  })}
                  onClick={() => void previewSound(event)}
                  className="min-h-9 rounded-control border border-border px-2 text-[11px] font-semibold text-accent"
                >
                  {t('audio.sound')}
                </button>
                <button
                  type="button"
                  aria-label={t('audio.previewVoice', {
                    event: t(`audio.events.${event}`),
                  })}
                  onClick={() =>
                    void previewVoice(
                      event,
                      event === 'failure_reason' ? failureReasons[0] : undefined,
                    )
                  }
                  className="min-h-9 rounded-control border border-border px-2 text-[11px] font-semibold text-accent"
                >
                  {prepare.isPending ? t('audio.wait') : t('audio.voice')}
                </button>
              </div>
            );
          })}
        </div>
        <div className="rounded-control border border-border px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            {t('audio.taskReasons')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {failureReasons.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => void previewVoice('failure_reason', reason)}
                className="min-h-9 rounded-control border border-border px-2 text-[11.5px] text-text-primary"
              >
                {reason} · {prepare.isPending ? t('audio.wait') : t('audio.voice')}
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
                speechRate: settings.speechRate,
                phrases,
              })
            }
            disabled={
              !status.data?.available || voices.length === 0 || prepare.isPending
            }
            className="min-h-11 rounded-control bg-accent px-3 text-[12.5px] font-semibold text-text-inverse disabled:opacity-50"
          >
            {prepare.isPending ? t('audio.preparing') : t('audio.prepare')}
          </button>
          <button
            type="button"
            onClick={() => {
              resetAudioSettings();
              stopVoicePlayer();
              setMessage(t('audio.resetMessage'));
            }}
            className="min-h-11 rounded-control border border-dashed border-border-strong px-3 text-[12.5px] font-semibold text-accent"
          >
            {t('audio.reset')}
          </button>
        </div>
        <div
          role="status"
          className={cn(
            'rounded-control border px-3 py-2 text-[12px]',
            status.data?.available
              ? 'border-accent bg-interaction-selected text-accent'
              : 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
          )}
        >
          {message ||
            (status.isLoading
              ? t('audio.checking')
              : status.isError
                ? t('audio.reachableError')
                : status.data?.available
                  ? t('audio.ready')
                  : t('audio.unavailable'))}
          {status.data?.available ? (
            <span className="mt-1 block">
              {t('audio.localModel', {
                voice: VOICE_LABELS[settings.voiceName] ?? settings.voiceName,
              })}
            </span>
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
    <label className="flex min-h-11 items-center justify-between rounded-control border border-border px-3 text-[12.5px] font-semibold text-text-primary">
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
