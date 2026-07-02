// Thin uPlot wrapper for the Probe overlay: a time-series chart with axis ticks,
// a legend, hover crosshair, and multiple overlaid series — the things the
// hand-rolled SVG charts lacked (axis numbers + overlay). Guarded so a
// canvas-less environment (jsdom in unit tests) renders an empty container
// instead of throwing.

import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface UplotSeriesConf {
  label: string;
  stroke: string;
}

/** A REC/STOP recording marker drawn as a vertical line. `t` is MILLISECONDS
 *  (converted to seconds internally to match the uPlot time x-scale). */
export interface ChartMarker {
  t: number;
  kind: 'REC' | 'STOP';
}

/** A horizontal dashed reference line at y = v (e.g. expected_hz, a shortfall
 *  threshold). */
export interface RefLine {
  v: number;
  color: string;
}

// Shared overlay-series colour palette — Probe and the Live Scope band both
// cycle through it so series stay visually consistent across the app.
export const PALETTE = [
  '#0d9488',
  '#0891b2',
  '#d97706',
  '#fb7185',
  '#16a34a',
  '#7c3aed',
  '#dc2626',
  '#2563eb',
];

/**
 * uPlot requires the data to have EXACTLY one array per series (x + each y) and
 * every column the same length. When a series is added/removed the `data` prop
 * can briefly lag the `series` prop by one render, so normalize here (pad missing
 * y-columns with nulls, match each to the x length) — otherwise uPlot reads an
 * undefined column and the whole chart goes blank.
 */
function normalizeData(
  data: (number | null)[][],
  nSeries: number,
): uPlot.AlignedData {
  const xs = (data[0] ?? []) as number[];
  const len = xs.length;
  const ys: (number | null)[][] = [];
  for (let i = 0; i < nSeries; i++) {
    const col = data[i + 1] ?? [];
    if (col.length === len) ys.push(col);
    else if (col.length > len) ys.push(col.slice(col.length - len));
    else ys.push([...Array<number | null>(len - col.length).fill(null), ...col]);
  }
  return [xs, ...ys] as uPlot.AlignedData;
}

export function UplotChart({
  data,
  series,
  height = 280,
  markers,
  refLines,
}: {
  data: (number | null)[][];
  series: UplotSeriesConf[];
  height?: number;
  /** REC/STOP markers overlaid on every panel (t in milliseconds). */
  markers?: ChartMarker[];
  /** Dashed horizontal reference lines (e.g. expected_hz, 2%/5% thresholds). */
  refLines?: RefLine[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // uPlot series are fixed at construction, so recreate the plot when the SERIES
  // SET changes; data-only changes go through setData (the second effect).
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}`).join('|');
  // refLines feed the y-scale `range` fn baked into the construction opts, so a
  // change also needs a recreate (unlike markers, which are read from a ref).
  const refLinesKey = (refLines ?? []).map((r) => `${r.v}:${r.color}`).join('|');
  const safeData = useMemo(
    () => normalizeData(data, series.length),
    [data, series.length],
  );

  // Markers/refLines are read by the `draw` hook via a ref (hooks are fixed at
  // construction, so they can't close over fresh props). Kept OUT of the uPlot
  // data arrays so they never affect series autoscale — except refLines, which
  // SHOULD extend the y-range so a threshold stays visible even when the data
  // sits near 0 (handled by the custom y `range` fn below).
  const markersRef = useRef<ChartMarker[]>(markers ?? []);
  markersRef.current = markers ?? [];
  const refLinesRef = useRef<RefLine[]>(refLines ?? []);
  refLinesRef.current = refLines ?? [];

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Skip entirely in a canvas-less env (jsdom unit tests): even a caught
    // construction leaves uPlot async callbacks that crash on a null context.
    let ctx: unknown = null;
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const opts: uPlot.Options = {
      width: host.clientWidth || 600,
      height,
      legend: { show: true },
      scales: {
        x: { time: true },
        y: {
          range: (_u, initMin, initMax) => {
            const vs = refLinesRef.current.map((r) => r.v);
            if (vs.length === 0) return [initMin, initMax];
            let lo = Math.min(initMin, ...vs);
            let hi = Math.max(initMax, ...vs);
            if (lo === hi) {
              lo -= 1;
              hi += 1;
            }
            return [lo, hi];
          },
        },
      },
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.stroke,
          width: 1.5,
          points: { show: false },
        })),
      ],
      axes: [{}, {}],
      hooks: {
        draw: [
          (u) => {
            const c = u.ctx;
            const xMin = u.scales.x?.min ?? -Infinity;
            const xMax = u.scales.x?.max ?? Infinity;
            c.save();
            c.beginPath();
            c.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
            c.clip();

            for (const r of refLinesRef.current) {
              const y = u.valToPos(r.v, 'y', true);
              c.strokeStyle = r.color;
              c.lineWidth = 1;
              c.setLineDash([4, 4]);
              c.beginPath();
              c.moveTo(u.bbox.left, y);
              c.lineTo(u.bbox.left + u.bbox.width, y);
              c.stroke();
            }

            for (const m of markersRef.current) {
              const tSec = m.t / 1000;
              if (tSec < xMin || tSec > xMax) continue; // outside the current window
              const x = u.valToPos(tSec, 'x', true);
              c.strokeStyle = m.kind === 'REC' ? '#dc2626' : '#9ca3af';
              c.lineWidth = 1;
              c.setLineDash(m.kind === 'REC' ? [] : [4, 4]);
              c.beginPath();
              c.moveTo(x, u.bbox.top);
              c.lineTo(x, u.bbox.top + u.bbox.height);
              c.stroke();
            }

            c.setLineDash([]);
            c.restore();
          },
        ],
      },
    };
    const plot = new uPlot(opts, safeData, host);
    plotRef.current = plot;
    const onResize = () =>
      plot.setSize({ width: host.clientWidth || 600, height });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.destroy();
      plotRef.current = null;
    };
    // safeData is applied via the setData effect; recreate only on series/refLines/height.
  }, [seriesKey, refLinesKey, height]);

  useEffect(() => {
    plotRef.current?.setData(safeData);
  }, [safeData]);

  // Markers change independently of the series set (new REC/STOP events) — just
  // redraw the existing plot rather than tearing it down and losing zoom/state.
  useEffect(() => {
    plotRef.current?.redraw();
  }, [markers]);

  return <div ref={hostRef} className="w-full" />;
}
