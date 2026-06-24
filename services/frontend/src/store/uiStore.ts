// Zustand store for UI-only state (not server state). Server state lives in
// TanStack Query; SSE pushes update the Query cache. Here we keep the active
// tab and the live SSE connection status so the header can surface it.

import { create } from 'zustand';

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface UiState {
  activeTab: string;
  setActiveTab: (id: string) => void;

  sseStatus: SseStatus;
  setSseStatus: (s: SseStatus) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeTab: '',
  setActiveTab: (id) => set({ activeTab: id }),

  sseStatus: 'closed',
  setSseStatus: (sseStatus) => set({ sseStatus }),
}));
