// Measure an element's live content-box height (rounded px) via ResizeObserver.
// The Monitor chart canvas is a fixed-px uPlot surface; a hardcoded height gets
// clipped by a shorter overflow-hidden slot (I-4: the below-expected region of a
// plot vanished). Feeding the MEASURED slot height to UplotChart keeps the whole
// y-range visible. Returns 0 until measured (before layout, or in a jsdom test
// env with no ResizeObserver) so callers can fall back to a fixed height.

import { useEffect, useRef, useState, type RefObject } from 'react';

export function useMeasuredHeight<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      // contentRect excludes padding — exactly the space the inner chart may use.
      const h = Math.round(entries[0]?.contentRect.height ?? 0);
      setHeight((prev) => (prev === h ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, height];
}
