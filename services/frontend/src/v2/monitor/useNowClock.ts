// A 1 Hz wall-clock tick used as the chart's window anchor, so the visible time
// window scrolls smoothly between SSE snapshots (the same idiom the v1 Graph tab
// and Live Scope band use). When `active` is false the clock FREEZES at its
// current value — the Monitor chart uses this to freeze the window on Pause so
// the chart truly stops instead of scrolling the frozen samples off-screen.

import { useEffect, useState } from 'react';

export function useNowClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Re-baseline on (re)activation so the first tick isn't stale from a long
    // paused stretch.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
