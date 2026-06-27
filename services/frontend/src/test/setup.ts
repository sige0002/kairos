import '@testing-library/jest-dom/vitest';

// jsdom lacks matchMedia, which uPlot calls at import time (and at construction).
// Stub it so importing uPlot-using components doesn't crash unit tests; the chart
// itself is canvas-less in jsdom and falls back to an empty container.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
