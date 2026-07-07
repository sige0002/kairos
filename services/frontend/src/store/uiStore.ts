// Zustand store for UI-only state (not server state). Server state lives in
// TanStack Query; SSE pushes update the Query cache. Here we keep the active
// tab and the live SSE connection status so the header can surface it.
//
// We also park a few pieces of *operator-draft* state here that would otherwise
// live in the Live/Stream tab components. The tab panel renders only the active
// tab (App.tsx unmounts the others on switch), so any component-local state is
// lost on navigation. operator/task were the first casualties; the record-topic
// selection, the Scope band (its panels + REC/STOP markers), and the stream
// camera panes have the same lifetime requirement — losing them silently
// reverts a customized recording set or collapses the Scope band on a tab
// round-trip.

import { create } from 'zustand';
import type { RecMarker } from '../features/live/LiveTab';
import type { ProbeSeries } from '../features/probe/types';

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Max live stream previews: the Live grid maximizes up to a 2x2 (4) layout that
 *  fits the viewport without page scroll. */
export const MAX_STREAM_PANES = 4;

// Live Scope band (OL-③.2 successor): add-style panels overlaid on the Live
// tab, below the [Stream | Monitor] grid. Two panel kinds share one shell —
// Health (monitor-derived, no payload decode) and Signal (topic_probe-derived
// decoded fields). Persisted here (not component state) so the band survives a
// Live tab unmount on tab switch.
export type ScopeMetric = 'hz' | 'shortfall' | 'jitter';
export interface ScopeHealthPanel {
  id: number;
  kind: 'health';
  metric: ScopeMetric;
  topics: string[];
}
export interface ScopeSignalPanel {
  id: number;
  kind: 'signal';
  series: ProbeSeries[];
  hz: number;
}
export type ScopePanel = ScopeHealthPanel | ScopeSignalPanel;
/** Fields settable via `updateScopePanel`: metric/topics apply to a health
 *  panel, series/hz to a signal panel — the caller only sends the ones that
 *  apply to the panel's own kind. */
export interface ScopePanelPatch {
  metric?: ScopeMetric;
  topics?: string[];
  series?: ProbeSeries[];
  hz?: number;
}
export type ScopeWindowId = '30s' | '1m' | '5m';
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

  // Live Scope band: expanded/collapsed, the band-wide time window, and the
  // panel list (Health or Signal). Plus the REC/STOP markers accumulated from
  // /record/status transitions, drawn on every panel. Persisted so the band
  // keeps its panels (and marker history) across a tab round-trip.
  scopeOpen: boolean;
  scopeWindowId: ScopeWindowId;
  scopePanels: ScopePanel[];
  scopePanelSeq: number;
  setScopeOpen: (open: boolean) => void;
  setScopeWindow: (id: ScopeWindowId) => void;
  /** Adds a 'hz' health panel. With a topic, dedupes against any existing 'hz'
   *  panel that already contains it (just opens the band instead). */
  addHealthPanel: (topic?: string) => void;
  addSignalPanel: () => void;
  removeScopePanel: (id: number) => void;
  updateScopePanel: (id: number, patch: ScopePanelPatch) => void;
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
  streamPanes: { id: number; topic: string }[];
  streamPaneSeq: number;
  // Key of the config the panes were seeded from (the active robot's stream
  // config). Re-seed when it changes (e.g. a robot switch) so the panes follow
  // the new robot's cameras; `null` = not yet seeded.
  streamPanesSeededKey: string | null;
  seedStreamPanes: (configured: { topic?: string | null }[], key: string) => void;
  addStreamPane: () => void;
  removeStreamPane: (id: number) => void;
  setStreamPaneTopic: (id: number, topic: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeTab: '',
  setActiveTab: (id) => set({ activeTab: id }),

  pendingRun: null,
  setPendingRun: (pendingRun) => set({ pendingRun }),

  sseStatus: 'closed',
  setSseStatus: (sseStatus) => set({ sseStatus }),

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

  scopeOpen: false,
  scopeWindowId: '1m',
  scopePanels: [],
  scopePanelSeq: 0,
  setScopeOpen: (scopeOpen) => set({ scopeOpen }),
  setScopeWindow: (scopeWindowId) => set({ scopeWindowId }),
  addHealthPanel: (topic) =>
    set((s) => {
      if (
        topic &&
        s.scopePanels.some(
          (p) => p.kind === 'health' && p.metric === 'hz' && p.topics.includes(topic),
        )
      ) {
        return { scopeOpen: true };
      }
      const panel: ScopeHealthPanel = {
        id: s.scopePanelSeq,
        kind: 'health',
        metric: 'hz',
        topics: topic ? [topic] : [],
      };
      return {
        scopePanels: [...s.scopePanels, panel],
        scopePanelSeq: s.scopePanelSeq + 1,
        scopeOpen: true,
      };
    }),
  addSignalPanel: () =>
    set((s) => {
      const panel: ScopeSignalPanel = { id: s.scopePanelSeq, kind: 'signal', series: [], hz: 10 };
      return {
        scopePanels: [...s.scopePanels, panel],
        scopePanelSeq: s.scopePanelSeq + 1,
        scopeOpen: true,
      };
    }),
  removeScopePanel: (id) =>
    set((s) => ({ scopePanels: s.scopePanels.filter((p) => p.id !== id) })),
  updateScopePanel: (id, patch) =>
    set((s) => ({
      scopePanels: s.scopePanels.map((p) => (p.id === id ? ({ ...p, ...patch } as ScopePanel) : p)),
    })),
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
}));
