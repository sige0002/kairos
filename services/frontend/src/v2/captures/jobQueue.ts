// One job at a time per capture.
//
// The §7.1 lease is per CAPTURE, not per job: whoever submits first holds
// `objects/<capture_id>` and every other submission is refused with 409
// capture_busy. The video section mounts one player per camera topic and each
// auto-submits on mount, so a robot with five cameras fired five simultaneous
// POST /jobs for the same capture — one winner and four rejections, which the
// operator experienced as "the video doesn't show".
//
// Nothing about that is a server fault, and retrying the losers would just race
// again. The fix is to stop generating the contention: submissions for the same
// capture queue behind each other and go one at a time, handing over when the
// previous job reaches a terminal state (which the players already poll for).
//
// This does NOT replace the 409 handling. It only removes the contention this
// screen creates with itself; a digest job or another browser tab can still
// take the lease, and that refusal is still surfaced with its holder named.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface Entry {
  token: symbol;
  /** True once this entry holds the capture and its job may be submitted. */
  granted: boolean;
}

const queues = new Map<string, Entry[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Grant the head of a capture's queue if nothing currently holds it. */
function pump(captureId: string): void {
  const queue = queues.get(captureId);
  if (!queue || queue.length === 0) {
    queues.delete(captureId);
    return;
  }
  if (queue.some((e) => e.granted)) return;
  queue[0]!.granted = true;
}

/** Join the queue for a capture. The returned token identifies this waiter. */
export function requestSlot(captureId: string): symbol {
  const token = Symbol('job-slot');
  const queue = queues.get(captureId) ?? [];
  queue.push({ token, granted: false });
  queues.set(captureId, queue);
  pump(captureId);
  notify();
  return token;
}

/**
 * Leave the queue, handing the capture to the next waiter.
 *
 * Called on a job reaching ANY terminal state — succeeded, failed or canceled —
 * and on unmount. A failure must release exactly like a success: holding the
 * slot for a job that will never finish would strand every other preview
 * behind it, turning one broken topic into a section that never loads.
 */
export function releaseSlot(captureId: string, token: symbol): void {
  const queue = queues.get(captureId);
  if (!queue) return;
  const next = queue.filter((e) => e.token !== token);
  if (next.length === 0) queues.delete(captureId);
  else queues.set(captureId, next);
  pump(captureId);
  notify();
}

export function isGranted(captureId: string, token: symbol): boolean {
  return queues.get(captureId)?.find((e) => e.token === token)?.granted ?? false;
}

/** How many submissions are ahead of this one. 0 once it holds the capture. */
export function waitingAhead(captureId: string, token: symbol): number {
  const queue = queues.get(captureId) ?? [];
  const index = queue.findIndex((e) => e.token === token);
  return index < 0 ? 0 : index;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface JobSlot {
  /** True once this caller may submit. */
  granted: boolean;
  /** Submissions ahead of this one; 0 when granted. */
  ahead: number;
  /** Hand the capture to the next waiter. Idempotent. */
  release: () => void;
}

/**
 * Hold a place in a capture's submission queue for as long as `want` is true.
 *
 * The slot is released on unmount as well as on `release()`, so a player the
 * operator navigates away from cannot strand the queue behind it.
 */
export function useJobSlot(captureId: string, want: boolean): JobSlot {
  const tokenRef = useRef<symbol | null>(null);
  if (want && tokenRef.current === null) {
    tokenRef.current = requestSlot(captureId);
  }
  const token = tokenRef.current;

  const release = useCallback(() => {
    if (tokenRef.current === null) return;
    releaseSlot(captureId, tokenRef.current);
    tokenRef.current = null;
  }, [captureId]);

  useEffect(() => release, [release]);

  const granted = useSyncExternalStore(
    subscribe,
    () => (token ? isGranted(captureId, token) : false),
    () => false,
  );
  const ahead = useSyncExternalStore(
    subscribe,
    () => (token ? waitingAhead(captureId, token) : 0),
    () => 0,
  );
  return { granted, ahead, release };
}

/** Test seam: no queue may survive from one case into the next. */
export function __resetJobQueue(): void {
  queues.clear();
  notify();
}
