// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The shape every bulk operation in this console shares (the standing bulk
// rule, first written down in useCaptureDeletion).
//
// One item at a time, never in parallel: these are writes against a store that
// serialises them anyway, and a burst of concurrent requests only makes the
// failure report harder to read. A refused item does NOT stop the run — it is
// collected and reported BY ID, because an item that was skipped is still in
// whatever state it was in, and dropping it from the report is how an operator
// ends up believing a batch is cleaner than it is.
//
// The cache sweep happens ONCE, after the loop, rather than once per item.
//
// What belongs to the caller, deliberately: the toast wording, whether a dialog
// closes, and what a partial failure means for the screen. Those differ per
// operation and are exactly the things that should read as written prose at the
// call site rather than as flags passed into a helper.

import { useCallback, useState } from 'react';

export interface BulkRunOutcome<F> {
  succeeded: number;
  failures: F[];
}

export interface BulkRunArgs<T, F> {
  /** The items to work through, when they are known up front. */
  items?: T[];
  /** ...or how to work out what the items ARE, when that itself takes network
   *  calls. Runs inside the busy window and under the same try/catch, and is
   *  handed `setTotal` so a caller that learns the count before the rest of its
   *  preparation finishes can publish it at that moment rather than after. */
  prepare?: (setTotal: (n: number) => void) => Promise<T[]>;
  /** Attempt one item: null when it succeeded, or the failure to report. A
   *  per-item refusal is returned, never thrown — throwing would abandon the
   *  rest of the run. */
  attempt: (item: T) => Promise<F | null>;
  /** Runs after the loop and BEFORE `running` clears, so a caller can finish
   *  the whole operation — invalidate, re-select, close, toast — without the
   *  screen flickering out of its busy state half way through. Anything thrown
   *  here lands in `error`, same as `prepare`. */
  afterAll?: (outcome: BulkRunOutcome<F>) => Promise<void> | void;
}

export interface BulkRun<F> {
  running: boolean;
  done: number;
  total: number;
  failures: F[];
  /** Set only when `prepare` or `afterAll` THREW. A per-item refusal is a
   *  `failures` entry and never this — the two mean different things: one item
   *  was refused, versus the operation could not be carried out at all. */
  error: unknown;
  reset: () => void;
  /** Resolves with the outcome, or null when the run threw. */
  run: <T>(args: BulkRunArgs<T, F>) => Promise<BulkRunOutcome<F> | null>;
}

export function useBulkRun<F>(): BulkRun<F> {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [failures, setFailures] = useState<F[]>([]);
  const [error, setError] = useState<unknown>(null);

  const reset = useCallback(() => {
    setDone(0);
    setTotal(0);
    setFailures([]);
    setError(null);
  }, []);

  const run = useCallback(
    async <T>({
      items,
      prepare,
      attempt,
      afterAll,
    }: BulkRunArgs<T, F>): Promise<BulkRunOutcome<F> | null> => {
      setRunning(true);
      setDone(0);
      setTotal(items?.length ?? 0);
      setFailures([]);
      setError(null);
      try {
        const list = items ?? (await prepare!(setTotal));
        // Idempotent: a `prepare` that already published the count sets the
        // same number again, and one that did not gets it here.
        setTotal(list.length);
        const collected: F[] = [];
        let succeeded = 0;
        for (const item of list) {
          const failure = await attempt(item);
          if (failure == null) succeeded += 1;
          else {
            collected.push(failure);
            setFailures([...collected]);
          }
          setDone((d) => d + 1);
        }
        const outcome = { succeeded, failures: collected };
        await afterAll?.(outcome);
        return outcome;
      } catch (e) {
        setError(e);
        return null;
      } finally {
        setRunning(false);
      }
    },
    [],
  );

  return { running, done, total, failures, error, reset, run };
}
