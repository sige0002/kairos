// A control that appears under the pointer must not be pressable by the press
// that put it there.
//
// The Collect flow swaps one big button for another in the same corner of the
// card on every phase change, so the second half of a double-click lands on
// whatever took the first one's place. The Stop button answers this with a
// floor on the TAKE (STOP_FLOOR_MS — a take younger than a second cannot be
// stopped); a control with no take behind it, like ARMING's Cancel, needs the
// floor on the CONTROL instead: it ignores its first moments on screen.
//
// Returns `false` until `delayMs` after `active` turned true. Callers put it on
// `disabled`, so the click is not merely ignored — it never fires, and the
// button visibly says it is not ready yet rather than swallowing a press.

import { useEffect, useState } from 'react';

export function useActivationGuard(active: boolean, delayMs: number): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!active) {
      // Re-arming is per activation: leaving and re-entering the phase must
      // serve a fresh guard, not the one the last visit used up.
      setArmed(false);
      return;
    }
    if (delayMs <= 0) {
      setArmed(true);
      return;
    }
    setArmed(false);
    const id = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);
  return armed;
}
