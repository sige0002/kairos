// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Zustand store for UI-only state (not server state). Server state lives in
// TanStack Query; SSE pushes update the Query cache. Here we keep the active
// tab and the live SSE connection status so the header can surface it.
//
// We also park a few pieces of *operator-draft* state here that would otherwise
// live in the Live/Stream tab components. The tab panel renders only the active
// tab (App.tsx unmounts the others on switch), so any component-local state is
// lost on navigation. operator/task were the first casualties; the record-topic
// selection, the REC/STOP chart markers, and the stream camera panes have the
// same lifetime requirement — losing them silently reverts a customized
// recording set on a tab round-trip.

import { create } from 'zustand';
import type { ProbeSeries } from '../features/probe/types';

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** A REC/STOP recording marker, drawn on the Monitor chart bands. Defined here
 *  because this store is where the markers live and the only place they are
 *  produced (`pushRecordMarker`). */
export interface RecMarker {
  t: number;
  kind: 'REC' | 'STOP';
}

/** Monitor-bridge connectivity relayed by the orchestrator's `bridge` SSE
 *  event: whether the orchestrator can reach the monitor (which runs ON the
 *  robot in the cross-host split). `null` = not reported yet. Lets the header
 *  distinguish "my pipe to the orchestrator is open" from "the robot-edge
 *  services are actually reachable". */
export type MonitorBridge = 'up' | 'down' | null;

/** Max live stream previews: the Live grid maximizes up to a 2x2 (4) layout that
 *  fits the viewport without page scroll. */
export const MAX_STREAM_PANES = 4;

export type ProbeWindowId = '10s' | '30s' | '1m';

interface UiState {
  activeTab: string;
  setActiveTab: (id: string) => void;

  // A run id parked when the operator deep-links from the Recordings tab to
  // "Validate" / "Export" it: the target tab reads this once on mount to
  // preselect / highlight the run, then clears it. Avoids the back-and-forth of
  // switching tab and re-finding the same run in a dropdown.
  pendingRun: string | null;
  setPendingRun: (id: string | null) => void;

  sseStatus: SseStatus;
  setSseStatus: (s: SseStatus) => void;

  monitorBridge: MonitorBridge;
  setMonitorBridge: (s: MonitorBridge) => void;

  // Draft record metadata (operator/task). Kept here, not in the Live tab's
  // local state, so it survives the tab unmounting on navigation — otherwise
  // typing it and switching tabs would reset it.
  recordOperator: string;
  setRecordOperator: (v: string) => void;
  recordTask: string;
  setRecordTask: (v: string) => void;

  // Next-recording topic selection (Live monitor picker). Seeded from the
  // configured topics as discovery first arrives; the operator can then add or
  // drop any topic. Persisted here so a tab switch doesn't silently revert the
  // customized set back to the configured defaults (which would start the next
  // recording with an unintended topic set). `recordSeededKey` is the config the
  // selection was seeded from (the active robot's default_topics) — mirrors
  // `streamPanesSeededKey`, so a robot switch re-seeds (and resets a stale
  // customized set) instead of leaving the previous robot's selection in place.
  recordSelected: Set<string>;
  recordCustomized: boolean;
  recordSeededKey: string | null;
  seedRecordTopics: (names: string[], key: string) => void;
  toggleRecordTopic: (name: string) => void;

  recMarkers: RecMarker[];
  recMarkersPrevActive: boolean | null;
  pushRecordMarker: (state: string) => void;

  // Probe tab overlay: the added (topic, field) series plus the plot controls
  // (rate / time window). Persisted so a tab round-trip doesn't silently drop a
  // built-up overlay — the same unmount-on-navigation lifetime problem as the
  // Live tab drafts above. Pause state stays component-local: a remount reopens
  // the streams anyway, so restoring a stale "paused" would just look broken.
  probeSeries: ProbeSeries[];
  probeSeriesSeq: number;
  addProbeSeries: (topic: string, field: string) => void;
  removeProbeSeries: (id: string) => void;
  clearProbeSeries: () => void;
  probeHz: number;
  setProbeHz: (hz: number) => void;
  probeWindowId: ProbeWindowId;
  setProbeWindow: (id: ProbeWindowId) => void;

  // Stream camera previews: how many panes and what each shows. Seeded once from
  // config.stream.panes; add/remove/topic edits persist so opening a second
  // camera and switching tabs doesn't drop it back to the configured layout.
  streamPanes: { id: number; topic: string; maxWidth?: number | null; maxHeight?: number | null }[];
  streamPaneSeq: number;
  // Key of the config the panes were seeded from (the active robot's stream
  // config). Re-seed when it changes (e.g. a robot switch) so the panes follow
  // the new robot's cameras; `null` = not yet seeded.
  streamPanesSeededKey: string | null;
  seedStreamPanes: (configured: { topic?: string | null }[], key: string) => void;
  addStreamPane: () => void;
  removeStreamPane: (id: number) => void;
  setStreamPaneTopic: (id: number, topic: string) => void;
  /** Per-pane preview resolution cap (null/null = Source, no downscale). */
  setStreamPaneResolution: (id: number, maxWidth: number | null, maxHeight: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeTab: '',
  setActiveTab: (id) => set({ activeTab: id }),

  pendingRun: null,
  setPendingRun: (pendingRun) => set({ pendingRun }),

  sseStatus: 'closed',
  setSseStatus: (sseStatus) => set({ sseStatus }),

  monitorBridge: null,
  setMonitorBridge: (monitorBridge) => set({ monitorBridge }),

  recordOperator: '',
  setRecordOperator: (recordOperator) => set({ recordOperator }),
  recordTask: '',
  setRecordTask: (recordTask) => set({ recordTask }),

  recordSelected: new Set<string>(),
  recordCustomized: false,
  recordSeededKey: null,
  seedRecordTopics: (names, key) =>
    set((s) =>
      // Re-seed only when the source config changes (robot switch) — otherwise
      // an operator-customized set persists across tab switches / discovery
      // refreshes. On re-seed, clear `recordCustomized` so a stale selection
      // from the previous robot can't be sent to the next Start.
      //
      // CALLERS: `key` MUST be order-insensitive — build it with
      // `configSeedKey` (src/v2/seedKey.ts), never a bare JSON.stringify of the
      // list. Any difference here DISCARDS the operator's customized selection,
      // so a plain reorder of `default_topics` (identical set, no semantic
      // change) would silently reset it while the list still shows everything
      // they wanted. Two independent call sites had that bug; this is the
      // invariant that stops a third.
      s.recordSeededKey === key
        ? {}
        : {
            recordSelected: new Set(names),
            recordCustomized: false,
            recordSeededKey: key,
          },
    ),
  toggleRecordTopic: (name) =>
    set((s) => {
      const next = new Set(s.recordSelected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { recordSelected: next, recordCustomized: true };
    }),

  recMarkers: [],
  recMarkersPrevActive: null,
  pushRecordMarker: (state) =>
    set((s) => {
      // Mirror the recorder's _ACTIVE_STATES: only recording/stopping is an
      // actually-running session. Log a marker on each active<->idle edge.
      const active = state === 'recording' || state === 'stopping';
      if (s.recMarkersPrevActive !== null && s.recMarkersPrevActive !== active) {
        const now = Date.now();
        return {
          recMarkers: [
            ...s.recMarkers.filter((m) => m.t > now - 300_000),
            { t: now, kind: active ? 'REC' : 'STOP' },
          ],
          recMarkersPrevActive: active,
        };
      }
      return s.recMarkersPrevActive !== active
        ? { recMarkersPrevActive: active }
        : {};
    }),

  probeSeries: [],
  probeSeriesSeq: 0,
  addProbeSeries: (topic, field) =>
    set((s) =>
      s.probeSeries.some((p) => p.topic === topic && p.field === field)
        ? {} // no dupes — same guard the ProbeTab add button had
        : {
            probeSeries: [
              ...s.probeSeries,
              { id: `s${s.probeSeriesSeq}`, topic, field },
            ],
            probeSeriesSeq: s.probeSeriesSeq + 1,
          },
    ),
  removeProbeSeries: (id) =>
    set((s) => ({ probeSeries: s.probeSeries.filter((p) => p.id !== id) })),
  clearProbeSeries: () => set({ probeSeries: [] }),
  probeHz: 10,
  setProbeHz: (probeHz) => set({ probeHz }),
  probeWindowId: '30s',
  setProbeWindow: (probeWindowId) => set({ probeWindowId }),

  streamPanes: [],
  streamPaneSeq: 0,
  streamPanesSeededKey: null,
  seedStreamPanes: (configured, key) =>
    set((s) => {
      // Re-seed only when the source config changes (robot switch) — otherwise
      // operator-opened panes persist across tab switches / config refetches.
      if (s.streamPanesSeededKey === key) return {};
      // Cap at MAX_STREAM_PANES (4): the Live grid maximizes up to a 2x2 layout
      // that fits the viewport without page scroll.
      const init =
        configured.length > 0
          ? configured.slice(0, MAX_STREAM_PANES).map((p, i) => ({ id: i, topic: p.topic ?? '' }))
          : [{ id: 0, topic: '' }];
      return { streamPanes: init, streamPaneSeq: init.length, streamPanesSeededKey: key };
    }),
  // No-op once 4 panes exist (the fit-to-viewport grid tops out at 2x2).
  addStreamPane: () =>
    set((s) =>
      s.streamPanes.length >= MAX_STREAM_PANES
        ? {}
        : {
            streamPanes: [...s.streamPanes, { id: s.streamPaneSeq, topic: '' }],
            streamPaneSeq: s.streamPaneSeq + 1,
          },
    ),
  removeStreamPane: (id) =>
    set((s) => ({ streamPanes: s.streamPanes.filter((p) => p.id !== id) })),
  setStreamPaneTopic: (id, topic) =>
    set((s) => ({
      streamPanes: s.streamPanes.map((p) => (p.id === id ? { ...p, topic } : p)),
    })),
  setStreamPaneResolution: (id, maxWidth, maxHeight) =>
    set((s) => ({
      streamPanes: s.streamPanes.map((p) =>
        p.id === id ? { ...p, maxWidth, maxHeight } : p,
      ),
    })),
}));
