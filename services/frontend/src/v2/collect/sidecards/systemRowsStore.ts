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

import { useEffect } from 'react';
import { create } from 'zustand';
import type { SysRow } from './useSystemRows';

interface SystemRowsState {
  rows: SysRow[];
  publish: (rows: SysRow[]) => void;
  clear: () => void;
}

/** The same rows, field for field? Every SysRow field is a primitive, so this
 *  is the whole comparison. The publisher hands us a fresh array on every one
 *  of its renders; without this guard each would notify subscribers and
 *  re-render the warnings card for news that has not changed. */
function sameRows(a: SysRow[], b: SysRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const o = b[i]!;
      return (
        r.label === o.label &&
        r.value === o.value &&
        r.chip === o.chip &&
        r.tone === o.tone &&
        r.title === o.title
      );
    })
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

/**
 * Publish the rows this render produced, and drop them when the publisher
 * unmounts.
 *
 * The clear matters: a warnings card outliving the system card must fall back
 * to "no rows to speak for" rather than to a frozen last set, which would be
 * the same class of stale claim this store exists to remove.
 */
export function usePublishSystemRows(rows: SysRow[]): void {
  const publish = useSystemRowsStore((s) => s.publish);
  const clear = useSystemRowsStore((s) => s.clear);
  useEffect(() => {
    publish(rows);
  }, [rows, publish]);
  useEffect(() => clear, [clear]);
}

/** The rows the system card last derived. Empty before it has rendered. */
export function useSharedSystemRows(): SysRow[] {
  return useSystemRowsStore((s) => s.rows);
}
