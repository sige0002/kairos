// Whether this is a SPLIT deployment: the recorder writes on the robot and the
// recording PC pulls finished captures across.
//
// It lives here, beside the deletion dialogs, because it is a property of the
// deployment rather than of any one screen — Review gates its transfer UI on
// it, and the discard dialog is REQUIRED to use it (§12: on a split deploy the
// dialog must say, unprompted, that a copy may still exist on the robot).
// Off by default, so the common single-PC deployment never sees either.
//
// The flag is DERIVED FROM THE SERVER: useReviewState fetches
// `GET /api/v1/transfer/status` once and calls `setSplitMode(available)` —
// the importer sidecar (the pull channel) answers its healthz only on a
// recording-PC split deploy, so `available` IS "this is a split deployment".
// The setter is also the test seam: unit tests call `setSplitMode` directly,
// and Playwright (which drives the built app, not this module) flips it
// through the `window.__reviewSetSplitMode` bridge below.

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

/** Server-derived (transfer channel available) — also the test/e2e seam. */
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
