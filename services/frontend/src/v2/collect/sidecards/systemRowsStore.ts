// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// One set of System status rows, shared by the two cards that have to agree
// about them.
//
// Collect renders System status and Active warnings as SIBLING cards, so the
// warnings card could not see the rows the system card had just derived. It
// answered from its own sources instead — arming gaps plus firing SSE alerts —
// which is how "✓ No active warnings" came to sit directly beneath "Topic rates
// 27 / 29 at expected · CHECK" and "Build robot … ≠ console … · CHECK" (#13).
// An operator reading the warnings line was told the take was clean while two
// checks on the card immediately above it were not passing.
//
// So the rows are PUBLISHED once, by whoever called useSystemRows, and read
// back here. The warnings card never re-derives a chip: if a row says CHECK it
// says CHECK in both places by construction, and a row added later is carried
// across for free.
//
// SINGLE PUBLISHER, by convention rather than by construction. The store holds
// one set of rows, so exactly one mounted component may call
// usePublishSystemRows — today that is SystemStatusCard, one per Collect
// screen. With two, the behaviour is last-writer-wins, and EITHER of them
// unmounting clears the rows out from under the other; the warnings card would
// then show another card's rows or none at all. Nothing enforces this at the
// type level, so a second publisher warns in development (below). Making the
// store multi-publisher would mean keying rows by publisher and deciding which
// set the warnings card speaks for — a real design question, not a patch.

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { SysRow } from './useSystemRows';

interface SystemRowsState {
  rows: SysRow[];
  publish: (rows: SysRow[]) => void;
  clear: () => void;
}

/**
 * Every field of SysRow, so that a field added to the interface joins the
 * comparison below instead of being silently ignored — which would show as a
 * stuck row on screen. The `satisfies` is the guard: TypeScript fails here the
 * moment SysRow grows a key this object does not list.
 */
const SYS_ROW_FIELDS = {
  id: true,
  title: true,
  label: true,
  value: true,
  chip: true,
  tone: true,
  cause: true,
  status: true,
} satisfies Record<keyof SysRow, true>;

/** The same rows, field for field? Every SysRow field is a primitive, so this
 *  is the whole comparison. The publisher hands us a fresh array on every one
 *  of its renders; without this guard each would notify subscribers and
 *  re-render the warnings card for news that has not changed. */
function sameRows(a: SysRow[], b: SysRow[]): boolean {
  const fields = Object.keys(SYS_ROW_FIELDS) as (keyof SysRow)[];
  return (
    a.length === b.length && a.every((r, i) => fields.every((k) => r[k] === b[i]![k]))
  );
}

export const useSystemRowsStore = create<SystemRowsState>((set, get) => ({
  rows: [],
  publish: (rows) => {
    if (!sameRows(get().rows, rows)) set({ rows });
  },
  clear: () => {
    if (get().rows.length > 0) set({ rows: [] });
  },
}));

/** Mounted publishers, for the development-only single-publisher check. Holds
 *  identities, never rows, and is not consulted by anything that renders. */
const publishers = new Set<symbol>();

/** Exported for tests only: the registry outlives a test file's renders. */
export function __resetPublishers(): void {
  publishers.clear();
}

/**
 * Publish the rows this render produced, and drop them when the publisher
 * unmounts.
 *
 * The clear matters: a warnings card outliving the system card must fall back
 * to "no rows to speak for" rather than to a frozen last set, which would be
 * the same class of stale claim this store exists to remove.
 *
 * Exactly one mounted component may call this — see the single-publisher note
 * at the top of the file. A second one is a warning in development and
 * last-writer-wins everywhere; the check adds no runtime behaviour.
 */
export function usePublishSystemRows(rows: SysRow[]): void {
  const publish = useSystemRowsStore((s) => s.publish);
  const clear = useSystemRowsStore((s) => s.clear);
  // Identity for this component instance. A ref, not a module counter: React
  // may mount, unmount and remount it (StrictMode does exactly that), and the
  // same instance must not look like a rival to itself.
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol('systemRowsPublisher');
  const id = idRef.current;

  useEffect(() => {
    if (import.meta.env.DEV && publishers.size > 0 && !publishers.has(id)) {
      console.warn(
        'systemRowsStore: a second System status publisher mounted. This store ' +
          'holds ONE set of rows — last write wins, and either publisher ' +
          'unmounting clears them — so the Active warnings card may end up ' +
          "speaking for the wrong card's rows, or for none at all.",
      );
    }
    publishers.add(id);
    return () => {
      publishers.delete(id);
    };
  }, [id]);

  useEffect(() => {
    publish(rows);
  }, [rows, publish]);
  useEffect(() => clear, [clear]);
}

/** The rows the system card last derived. Empty before it has rendered. */
export function useSharedSystemRows(): SysRow[] {
  return useSystemRowsStore((s) => s.rows);
}
