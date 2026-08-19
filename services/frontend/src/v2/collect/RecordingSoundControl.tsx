// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import { useEffect, useRef } from 'react';
import { cn } from '../../components/ui';
import type { RecordingCueKind } from './recordingCues';
import type { RecordingCueSettings } from './hooks/useRecordingCues';

function SpeakerIcon({ enabled }: { enabled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.25 6.25h2.1L7.25 4v8l-2.9-2.25h-2.1z" fill="currentColor" />
      {enabled ? (
        <>
          <path
            d="M9.2 6.1a2.6 2.6 0 010 3.8"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path d="M11 4.5a4.7 4.7 0 010 7" stroke="currentColor" strokeWidth="1.2" />
        </>
      ) : (
        <path d="M9.4 6.2l3 3m0-3l-3 3" stroke="currentColor" strokeWidth="1.2" />
      )}
    </svg>
  );
}

const PREVIEWS: { kind: RecordingCueKind; label: string }[] = [
  { kind: 'start', label: 'Start' },
  { kind: 'end', label: 'End' },
  { kind: 'warning', label: 'Warning' },
];

export function RecordingSoundControl({
  settings,
  open,
  onToggle,
}: {
  settings: RecordingCueSettings;
  open: boolean;
  onToggle: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const unavailable = settings.playbackState === 'unsupported';
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = false;
      (unavailable ? closeRef.current : switchRef.current)?.focus();
    } else if (wasOpenRef.current && restoreFocusRef.current) {
      triggerRef.current?.focus();
      restoreFocusRef.current = false;
    }
    wasOpenRef.current = open;
  }, [open, unavailable]);

  const blocked = settings.playbackState === 'blocked';
  const buttonState = unavailable
    ? 'unavailable'
    : blocked
      ? 'blocked'
      : settings.enabled
        ? 'on'
        : 'off';
  const status =
    settings.playbackState === 'unsupported'
      ? 'Audio is not supported by this browser.'
      : settings.playbackState === 'blocked'
        ? 'The browser blocked audio. Press a Test button to allow it.'
        : settings.enabled
          ? 'On for this browser.'
          : 'Off — no recording cues will play.';

  return (
    <div className="relative mr-2">
      <button
        ref={triggerRef}
        type="button"
        data-testid="recording-sounds-toggle"
        onClick={() => {
          if (open) restoreFocusRef.current = true;
          onToggle();
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Recording sounds ${buttonState}`}
        title={`Recording sounds: ${buttonState}`}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-control border transition-colors',
          blocked
            ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
            : settings.enabled && !unavailable
              ? 'border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100'
              : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50',
        )}
      >
        <SpeakerIcon enabled={settings.enabled && !blocked && !unavailable} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Recording sound settings"
          data-testid="recording-sounds-menu"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            restoreFocusRef.current = true;
            onToggle();
          }}
          className="absolute right-0 top-full z-50 mt-1.5 flex w-72 flex-col gap-3 rounded-card border border-gray-200 bg-white p-3.5 shadow-float"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] font-bold text-gray-900">
                Recording sounds
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                Browser-local and optional. Visual status remains authoritative.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                ref={switchRef}
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                disabled={unavailable}
                onClick={() => settings.setEnabled(!settings.enabled)}
                className={cn(
                  'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  settings.enabled ? 'bg-teal-600' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
                    settings.enabled ? 'translate-x-5' : 'translate-x-0.5',
                  )}
                />
                <span className="sr-only">
                  {unavailable
                    ? 'Recording sounds unavailable'
                    : settings.enabled
                      ? 'Turn recording sounds off'
                      : 'Turn recording sounds on'}
                </span>
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => {
                  restoreFocusRef.current = true;
                  onToggle();
                }}
                aria-label="Close recording sound settings"
                className="rounded-control px-1.5 py-0.5 text-sm text-gray-500 hover:bg-gray-100"
              >
                ×
              </button>
            </div>
          </div>

          <label className="flex flex-col gap-1 text-[11px] font-semibold text-gray-600">
            Volume · {Math.round(settings.volume * 100)}%
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.volume}
              disabled={!settings.enabled}
              onChange={(event) => settings.setVolume(Number(event.target.value))}
              className="accent-teal-700 disabled:opacity-40"
            />
          </label>

          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-gray-500">
              Test cues
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {PREVIEWS.map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  disabled={
                    !settings.enabled || settings.playbackState === 'unsupported'
                  }
                  onClick={() => settings.preview(kind)}
                  className="rounded-chip border border-gray-200 px-2 py-1.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <p
            role="status"
            data-testid="recording-sounds-status"
            className={cn(
              'text-[11px] leading-relaxed',
              settings.playbackState === 'blocked' ||
                settings.playbackState === 'unsupported'
                ? 'font-medium text-amber-700'
                : 'text-gray-500',
            )}
          >
            {status}
          </p>
          <p className="border-t border-gray-100 pt-2 text-[10.5px] leading-relaxed text-gray-500">
            Start = live recording confirmed. End = recording finalized, not a data
            quality result. Warning = check the persistent alert and recovery action.
          </p>
        </div>
      )}
    </div>
  );
}
