// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// RECORDING: the take is running. B1 also puts the "recorder stopped
// answering" face of this card here — same card, but it stops asserting that a
// recording is still happening.

import { Card, cn } from '../../../components/ui';
import { formatBytes } from '../../review/format';
import { CARD_PAD } from '../compact';
import type { BatchMachine } from '../useBatchMachine';
import { ArmingNote } from './banners';
import { CARD_GAP_COMPACT, formatElapsed } from './shared';

export function RecordingCard({
  machine,
  stopRef,
}: {
  machine: BatchMachine;
  stopRef: React.Ref<HTMLButtonElement>;
}) {
  const { stats } = machine;
  const elapsedText = formatElapsed(machine.elapsedMs);
  // B1: the recorder has stopped answering. We do NOT know that the recording
  // is still running, so the card stops asserting that it is — the pulsing
  // dot, the red RECORDING word and the live timer are all claims about a
  // thing we can no longer see. The last known values stay, labelled as such.
  const unreachable = machine.recorderUnreachable;
  const staleText =
    machine.recorderStaleMs != null
      ? `${Math.round(machine.recorderStaleMs / 1000)}s ago`
      : 'unknown';
  // Real bytes written for this run (from /record/status), not elapsed×rate.
  const writtenText =
    machine.recordingBytes != null
      ? `${formatBytes(machine.recordingBytes)} written`
      : '—';
  return (
    <Card
      className={cn(
        'flex shrink-0 flex-col gap-2.5 border-2 border-status-danger-border',
        CARD_GAP_COMPACT,
        CARD_PAD,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-[9px] w-[9px] rounded-sm',
            unreachable ? 'bg-status-warning-accent' : 'animate-recpulse bg-status-danger-accent',
          )}
        />
        <h2
          data-testid="phase-title"
          className={cn(
            'text-[17px] font-bold',
            unreachable ? 'text-status-warning-text' : 'text-status-danger-text',
          )}
        >
          {unreachable ? 'RECORDER UNREACHABLE' : 'RECORDING'}
        </h2>
        <div className="flex-1" />
        <span className="font-mono text-xs text-text-muted">
          Ep {stats.epNext} / {machine.targetEpisodes}
        </span>
      </div>
      {unreachable && (
        <div
          data-testid="recorder-unreachable-note"
          className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[12.5px] leading-relaxed text-status-warning-text"
        >
          <p role="alert" aria-live="assertive">
            The recorder is not answering. Whether this take is still running cannot be
            confirmed from here. Check the recorder connection; after it reconnects,
            confirm whether this take is still live before continuing.
          </p>
          <p className="mt-1 text-[11.5px] text-status-warning-text" aria-live="off">
            Last known: <span className="font-semibold">recording</span>, {staleText}.
            The figures below are the last ones reported, not current.
          </p>
        </div>
      )}
      <div className="flex items-baseline gap-2.5">
        <span
          data-testid="elapsed"
          className={cn(
            'font-mono text-[34px] font-semibold',
            unreachable ? 'text-text-muted' : 'text-text-primary',
          )}
          title={
            unreachable
              ? `Frozen at the last confirmed reading (${staleText})`
              : undefined
          }
        >
          {elapsedText}
        </span>
        <span className="font-mono text-xs text-text-muted">{writtenText}</span>
      </div>
      {/* Stop occupies the position Start just vacated, so the second half
          of a double-click lands here. Refused for the first moment of a
          take — see STOP_FLOOR_MS. */}
      <button
        ref={stopRef}
        type="button"
        data-testid="stop-recording"
        onClick={machine.stopRecording}
        disabled={!machine.canStop}
        title={
          machine.stopBlockedReason === 'floor'
            ? 'Just started — Stop is available a moment from now, so a ' +
              'double-click on Start cannot end the take it just began.'
            : undefined
        }
        className={cn(
          'flex h-[52px] items-center justify-center gap-2 rounded-control text-[15px] font-bold shadow-btn-red [@media(max-height:860px)]:h-[44px]',
          machine.canStop
            ? 'bg-status-danger-accent text-status-danger-contrast hover:bg-status-danger-text'
            : 'cursor-not-allowed bg-status-danger-accent text-status-danger-contrast/80',
        )}
      >
        <span className="h-[11px] w-[11px] rounded-sm bg-surface" />
        Stop recording
        <span className="text-[11px] font-medium opacity-70">· S</span>
      </button>
      {machine.arming && <ArmingNote arming={machine.arming} />}
    </Card>
  );
}
