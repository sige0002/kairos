// MCAP transfer is OUR addition to the Review screen (agreed with the user;
// not in the design mock) for split robot/recording-PC deployments. All of
// that UI is gated behind this single flag, off by default, so the common
// single-PC deployment never sees it.
//
// Phase 2 will derive this from whether the orchestrator's runtime config
// references a remote recorder (cross-host split); until that signal exists,
// it's a plain reactive flag nobody in production code ever flips. The setter
// exists only for tests: unit tests call `setSplitMode` directly, and
// Playwright (which drives the built app, not this module) flips it through
// the `window.__reviewSetSplitMode` bridge below.

import { useSyncExternalStore } from 'react';

let splitMode = false;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  return splitMode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test/e2e hook only. */
export function setSplitMode(value: boolean): void {
  if (splitMode === value) return;
  splitMode = value;
  listeners.forEach((l) => l());
}

export function useSplitMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __reviewSetSplitMode?: (v: boolean) => void }).__reviewSetSplitMode =
    setSplitMode;
}
