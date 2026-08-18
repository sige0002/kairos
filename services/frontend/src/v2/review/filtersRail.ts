// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Persisted collapse state for the Review FiltersRail. Collapsing the rail hands
// its width to the evidence panes on a narrow viewport (1280 is tight with the
// full 216px filter column) — an operator preference, so it survives a reload.
//
// Same module-store + useSyncExternalStore shape as captures/splitMode.ts, plus a
// versioned localStorage mirror (like v2/plans.ts) so the choice persists.
// localStorage is best-effort: a private-mode / SSR failure just means the
// preference stays in-memory for the session.

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kairos.v2.review.filtersCollapsed.v1';

function readInitial(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let collapsed = readInitial();
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  return collapsed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFiltersCollapsed(value: boolean): void {
  if (collapsed === value) return;
  collapsed = value;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — the in-memory value still drives this session.
  }
  listeners.forEach((l) => l());
}

export function toggleFiltersCollapsed(): void {
  setFiltersCollapsed(!collapsed);
}

export function useFiltersCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
