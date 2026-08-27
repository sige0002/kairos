// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Where the System status rows come from. Three live sources are mixed here —
// the console's /api/v1/system, the recorder's own /record/status, and the
// monitor's SSE metrics — and each row is responsible for saying WHICH of them
// it speaks for and WHEN it was measured. A row with no source reads "—";
// none of them is ever filled in with a plausible-looking number.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../../api/client';
import { queryKeys } from '../../../api/queryKeys';
import { SYSTEM_INFO_POLL_MS } from '../../pollingPolicy';
import type { MetricsSnapshot, SystemInfo } from '../../../api/types';
import type { SseStatus } from '../../../store/uiStore';
import type { BatchMachine } from '../useBatchMachine';
import { formatBytes } from '../../review/format';
import { i18n } from '../../../i18n';
import { useRecordStatus } from '../../captures/useRecordStatus';
import type { CameraHealth } from '../Cameras';
import { cameraSummary, topicRates } from '../warnings';
import type { Tone } from './Chip';

// Below this much free space on the data-dir filesystem we flag Storage for
// attention (amber "CHECK"). ~50 GB leaves comfortable headroom for several more
// episodes before disk pressure becomes a real risk to an in-progress batch.
const LOW_STORAGE_FREE_BYTES = 50 * 1024 ** 3;

export interface SysRow {
  /** Stable internal identity. Display labels are localized. */
  id?: string;
  /** Hover text saying WHEN the figure was measured, where two adjacent rows
   *  describe different moments and would otherwise read as contradicting. */
  title?: string;
  label: string;
  value: string;
  chip: string;
  tone: Tone;
  /**
   * WHICH cause put this row in its current state, when the label alone does
   * not distinguish them. Purely a key for prose elsewhere — it does not touch
   * this row's own chip, tone or value.
   *
   * The Active warnings card has to say what a CHECK means for the take, and
   * "Topic rates · CHECK" has more than one meaning: a genuine rate shortfall,
   * readings this console could not parse (E-23), or both at once. Keyed on the
   * label alone, one sentence had to speak for all of them, and for the
   * unreadable-only case it was simply false. Absent = the label is the whole
   * story.
   */
  cause?: string;
  /** Stable internal state. Display chips are localized. */
  status?: 'ok' | 'check' | 'recording' | 'stopping' | 'armed' | 'ready' | 'unknown';
}

export interface SystemRowsInput {
  machine: BatchMachine;
  sseStatus: SseStatus;
  monitorBridge: 'up' | 'down' | null;
  cameraHealth: CameraHealth;
}

export function useSystemRows({
  machine,
  sseStatus,
  monitorBridge,
  cameraHealth,
}: SystemRowsInput): SysRow[] {
  const t = i18n.getFixedT(i18n.language, 'collect');
  const robotOffline = sseStatus === 'open' && monitorBridge === 'down';
  const robotLive = sseStatus === 'open' && !robotOffline;
  // The Recorder row reads the SERVER recorder state (same /record/status query
  // the takeover card uses), so a live server-side recording always shows REC
  // here — never a stale local "READY" while the recorder is actually running.
  const recState = machine.recorderState;
  const recording = recState === 'recording';
  const stopping = recState === 'stopping';
  // Pre-armed (two-phase start): spawned + subscribed, paused until Start.
  const armed = recState === 'armed';
  // No state yet, or a status body carrying no `live_capture_ids` array — which
  // means the recorder is UNREACHABLE, not idle (§10 rev.2.4). Reporting either
  // as READY would tell the operator they may start while nothing can answer
  // for what is already running.
  // No state at all, no live_capture_ids array (§10 rev.2.4 — an unreachable or
  // too-old recorder, NOT an idle one), or a poll that is currently failing.
  // Reporting any of them as READY would tell the operator they may start while
  // nothing can answer for what is already running.
  const recUnknown =
    machine.recorderUnreachable || recState == null || machine.liveCaptures == null;

  // Real disk free/total for the data-dir filesystem (GET /api/v1/system). Null
  // until measured (older backend / missing data dir) -> honest "—", never a
  // fabricated figure.
  const { data: system } = useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => apiGet<SystemInfo>('/api/v1/system', { signal }),
    staleTime: 5000,
    refetchInterval: SYSTEM_INFO_POLL_MS,
  });
  const disk = system?.disk ?? null;
  // Prefer the disk the RECORDER writes (its status reports its own data-dir
  // free space — the robot's disk in the split deploy, which /system cannot
  // see). Falls back to the console host's disk on an older recorder.
  const recStatus = useRecordStatus();
  const recFree = recStatus.reachable
    ? (recStatus.status?.disk_free_bytes ?? null)
    : null;
  const freeBytes = recFree ?? disk?.free_bytes ?? null;
  // Headroom in HOURS, from the live write rate of the same status poll —
  // shown only while actually recording, past the settle window (the first
  // seconds legitimately read 0 B), and never invented while idle.
  let headroom: string | null = null;
  if (recStatus.recording && recStatus.status?.started_at && freeBytes != null) {
    const elapsedS = (Date.now() - Date.parse(recStatus.status.started_at)) / 1000;
    const bytes = recStatus.status.bytes ?? 0;
    if (elapsedS > 10 && bytes > 0) {
      const hours = freeBytes / (bytes / elapsedS) / 3600;
      headroom =
        hours > 99
          ? t('headroomOver99')
          : t('headroomHours', { hours: hours.toFixed(hours < 10 ? 1 : 0) });
    }
  }
  const storageOk = freeBytes != null && freeBytes >= LOW_STORAGE_FREE_BYTES;
  // Version-skew row: the recorder reports ITS build sha, the status proxy
  // adds the console's — unequal means the two hosts run different builds
  // (the split deploy's classic silent failure: a robot still on last week's
  // image). Unknown on either side shows nothing rather than a guess.
  const recSha = recStatus.reachable ? (recStatus.status?.git_sha ?? null) : null;
  const conSha = recStatus.status?.console_git_sha ?? null;
  const shasKnown = recSha != null && conSha != null;
  const shaMatch = shasKnown && recSha === conSha;
  const stackRow: SysRow = shasKnown
    ? shaMatch
      ? {
          id: 'build',
          label: t('build'),
          value: recSha,
          chip: t('statusOk'),
          status: 'ok',
          tone: 'green',
        }
      : {
          id: 'build',
          label: t('build'),
          value: t('buildMismatch', { robot: recSha, console: conSha }),
          chip: t('statusCheck'),
          status: 'check',
          tone: 'amber',
        }
    : {
        id: 'build',
        label: t('build'),
        value: '—',
        chip: '—',
        status: 'unknown',
        tone: 'gray',
      };

  const storageRow: SysRow =
    freeBytes != null
      ? {
          id: 'storage',
          label: t('storage'),
          value: headroom
            ? t('freeWithHeadroom', { free: formatBytes(freeBytes), headroom })
            : t('freeSpace', { free: formatBytes(freeBytes) }),
          chip: storageOk ? t('statusOk') : t('statusCheck'),
          status: storageOk ? 'ok' : 'check',
          tone: storageOk ? 'green' : 'amber',
        }
      : {
          id: 'storage',
          label: t('storage'),
          value: '—',
          chip: '—',
          status: 'unknown',
          tone: 'gray',
        };

  // Real arming snapshot (matched vs missing target topics) — only measured
  // while the recorder is arming/recording; outside that window it's honestly
  // unknown ("—"), never a made-up count.
  const arming = machine.arming;
  const matched = arming?.matched_topics.length ?? null;
  const missing = arming?.missing_topics.length ?? null;

  // Live "at expected rate" count from the monitor's SSE metrics snapshot
  // (read-only cache view; useEventStream writes it). Gated on the monitor
  // bridge being up so a stale last snapshot never poses as live data.
  const { data: metrics } = useQuery<MetricsSnapshot>({
    queryKey: queryKeys.metrics,
    queryFn: () => {
      throw new Error('SSE-only cache: written by useEventStream');
    },
    enabled: false,
  });
  const rates = monitorBridge === 'down' ? null : topicRates(metrics);
  // E-23: a reading the SSE ingest could not identify is excluded from BOTH
  // sides of this ratio, so "12 / 12" can describe a robot that published 13.
  // A green OK must not be reachable while something was withheld — the ratio
  // is still shown (it is true of what was readable) but it is no longer
  // allowed to read as complete.
  const withheld = rates?.withheld ?? 0;
  const allJudgedOk = rates != null && rates.judged > 0 && rates.ok === rates.judged;
  // The ways this row reaches CHECK, kept apart because the warnings card owes
  // each a different sentence — telling an operator that topics are below rate
  // when the ONLY finding was an unparseable reading names a problem nobody
  // measured. Undefined while the row is passing: there is no cause to name.
  const ratesCause =
    rates == null || (allJudgedOk && withheld === 0)
      ? undefined
      : rates.judged === 0
        ? 'rates-none-readable'
        : withheld === 0
          ? 'rates-shortfall'
          : rates.ok === rates.judged
            ? 'rates-unreadable'
            : 'rates-mixed';
  const ratesRow: SysRow = rates
    ? {
        id: 'topic-rates',
        label: t('topicRates'),
        value:
          (rates.judged > 0
            ? t('atExpected', { ok: String(rates.ok), judged: String(rates.judged) })
            : t('noneReadable')) +
          (withheld > 0 ? ` · ${t('unreadableReadings', { count: withheld })}` : ''),
        title:
          withheld > 0
            ? t('unreadableReadingsTitle', { count: withheld })
            : t('liveRollingWindowTitle'),
        chip: allJudgedOk && withheld === 0 ? t('statusOk') : t('statusCheck'),
        status: allJudgedOk && withheld === 0 ? 'ok' : 'check',
        tone: allJudgedOk && withheld === 0 ? 'green' : 'amber',
        cause: ratesCause,
      }
    : {
        id: 'topic-rates',
        label: t('topicRates'),
        value: '—',
        chip: '—',
        status: 'unknown',
        tone: 'gray',
      };

  // Every pane, not just the main stream. A silent sub camera used to have
  // nothing on the screen accounting for it: the row spoke for the main tile
  // alone while the others advertised a live frame rate beside it.
  // One claim, one place (warnings.ts cameraSummary). This row used to be
  // assembled inline from the MAIN stream's phase plus per-pane topic
  // liveness, which is how four black tiles beside one working stream became
  // "5 cameras OK" in green (E-37). The summary is now a pure function of
  // facts that cover every pane, and it cannot go green while a stream is down.
  const cameras = cameraSummary({
    totalCameras: cameraHealth.totalCameras,
    streamsDown: cameraHealth.streamsDown,
    streamFault: cameraHealth.streamFault,
    streamsNoVideo: cameraHealth.streamsNoVideo,
    silentTopics: cameraHealth.silentTopics,
    unmonitoredTopics: cameraHealth.unmonitoredTopics,
    framesStale: cameraHealth.framesStale,
  });
  const cameraRow: SysRow = {
    id: 'cameras',
    label: t('cameras'),
    ...cameras,
    status:
      cameras.tone === 'amber' ? 'check' : cameras.tone === 'green' ? 'ok' : 'unknown',
  };

  return [
    // minor-b: this row and Topic rates below it describe DIFFERENT MOMENTS.
    // The arming snapshot is taken once, when the recorder matched its targets,
    // and is not re-checked during the take; the rates row is a live window
    // that decays over ~20s. Read as two live figures they contradict each
    // other — qa-ui watched "7 / 7 OK" sit above "0 / 7 CHECK". Saying WHEN
    // each was measured costs a word and removes the contradiction, without
    // pretending we re-measured something we did not.
    matched !== null && missing !== null
      ? {
          id: 'required-data',
          label: t('requiredData'),
          value: t('requiredDataValue', {
            matched: String(matched),
            total: String(matched + missing),
          }),
          title: t('requiredDataTitle'),
          chip: missing === 0 ? t('statusOk') : t('statusCheck'),
          status: missing === 0 ? 'ok' : 'check',
          tone: missing === 0 ? 'green' : 'amber',
        }
      : {
          id: 'required-data',
          label: t('requiredData'),
          value: '—',
          chip: '—',
          status: 'unknown',
          tone: 'gray',
        },
    ratesRow,
    cameraRow,
    {
      // NOT "is the robot fine" — this row only ever measured the event pipe:
      // our SSE connection to the orchestrator, and the orchestrator's bridge
      // to the monitor (which runs on the robot). Both can be up while nothing
      // robot-shaped is publishing, and qa-ui found it reading OK in exactly
      // that state. Named for what it measures.
      id: 'monitor-link',
      label: t('monitorLink'),
      value: robotOffline ? t('monitorUnreachable') : robotLive ? t('live') : sseStatus,
      chip: robotLive ? t('statusOk') : t('statusCheck'),
      status: robotLive ? 'ok' : 'check',
      tone: robotLive ? 'green' : robotOffline ? 'amber' : 'gray',
    },
    storageRow,
    stackRow,
    {
      id: 'recorder',
      label: t('recorder'),
      value: recUnknown
        ? t('recorderNoAnswer')
        : recording
          ? t('recorderRecording')
          : stopping
            ? t('recorderStopping')
            : armed
              ? t('recorderPreArmed')
              : t('recorderStandby'),
      chip: recUnknown
        ? t('statusCheck')
        : recording
          ? t('statusRecording')
          : stopping
            ? t('statusStopping')
            : armed
              ? t('statusArmed')
              : t('statusReady'),
      status: recUnknown
        ? 'check'
        : recording
          ? 'recording'
          : stopping
            ? 'stopping'
            : armed
              ? 'armed'
              : 'ready',
      tone: recUnknown ? 'amber' : recording ? 'red' : stopping ? 'amber' : 'teal',
    },
  ];
}
