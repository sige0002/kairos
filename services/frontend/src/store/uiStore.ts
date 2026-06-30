// Zustand store for UI-only state (not server state). Server state lives in
// TanStack Query; SSE pushes update the Query cache. Here we keep the active
// tab and the live SSE connection status so the header can surface it.
//
// We also park a few pieces of *operator-draft* state here that would otherwise
// live in the Live/Stream tab components. The tab panel renders only the active
// tab (App.tsx unmounts the others on switch), so any component-local state is
// lost on navigation. operator/task were the first casualties; the record-topic
// selection, the open health-graph + its REC/STOP markers, and the stream camera
// panes have the same lifetime requirement — losing them silently reverts a
// customized recording set or closes the graph on a tab round-trip.

import { create } from 'zustand';
import type { RecMarker } from '../features/live/LiveHealthGraph';

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

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

  // Next-recording topic selection (Live monitor picker). Seeded once from the
  // configured topics as discovery first arrives; the operator can then add or
  // drop any topic. Persisted here so a tab switch doesn't silently revert the
  // customized set back to the configured defaults (which would start the next
  // recording with an unintended topic set).
  recordSelected: Set<string>;
  recordCustomized: boolean;
  recordSeeded: boolean;
  seedRecordTopics: (names: string[]) => void;
  toggleRecordTopic: (name: string) => void;

  // Live health graph: which topic's graph is open, plus the REC/STOP markers
  // accumulated from /record/status transitions. Persisted so the graph stays
  // open (and keeps its marker history) across a tab round-trip.
  graphTopic: string | null;
  setGraphTopic: (t: string | null) => void;
  recMarkers: RecMarker[];
  recMarkersPrevActive: boolean | null;
  pushRecordMarker: (state: string) => void;

  // Stream camera previews: how many panes and what each shows. Seeded once from
  // config.stream.panes; add/remove/topic edits persist so opening a second
  // camera and switching tabs doesn't drop it back to the configured layout.
  streamPanes: { id: number; topic: string }[];
  streamPaneSeq: number;
  streamPanesSeeded: boolean;
  seedStreamPanes: (configured: { topic?: string | null }[]) => void;
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
  recordSeeded: false,
  seedRecordTopics: (names) =>
    set((s) =>
      s.recordSeeded
        ? {}
        : { recordSelected: new Set(names), recordSeeded: true },
    ),
  toggleRecordTopic: (name) =>
    set((s) => {
      const next = new Set(s.recordSelected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { recordSelected: next, recordCustomized: true };
    }),

  graphTopic: null,
  setGraphTopic: (graphTopic) => set({ graphTopic }),
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

  streamPanes: [],
  streamPaneSeq: 0,
  streamPanesSeeded: false,
  seedStreamPanes: (configured) =>
    set((s) => {
      if (s.streamPanesSeeded) return {};
      const init =
        configured.length > 0
          ? configured.map((p, i) => ({ id: i, topic: p.topic ?? '' }))
          : [{ id: 0, topic: '' }];
      return { streamPanes: init, streamPaneSeq: init.length, streamPanesSeeded: true };
    }),
  addStreamPane: () =>
    set((s) => ({
      streamPanes: [...s.streamPanes, { id: s.streamPaneSeq, topic: '' }],
      streamPaneSeq: s.streamPaneSeq + 1,
    })),
  removeStreamPane: (id) =>
    set((s) => ({ streamPanes: s.streamPanes.filter((p) => p.id !== id) })),
  setStreamPaneTopic: (id, topic) =>
    set((s) => ({
      streamPanes: s.streamPanes.map((p) => (p.id === id ? { ...p, topic } : p)),
    })),
}));
