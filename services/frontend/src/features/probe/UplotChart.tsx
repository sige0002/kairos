// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
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

/**
 * y-scale range: the data extremes extended by any reference-line values, with a
 * degenerate (collapsed) range padded so it still renders. A custom uPlot range
 * fn bypasses uPlot's own padding, so FLAT data — a single constant-value series
 * (e.g. a status/error field that sits at 0) — yields min === max, a zero-height
 * scale, and a blank chart until a second, different-valued series widens the
 * range. Exported for tests.
 */
export function yRange(
  dataMin: number | null,
  dataMax: number | null,
  refValues: number[],
): [number | null, number | null] {
  let lo: number | null = dataMin;
  let hi: number | null = dataMax;
  if (refValues.length > 0) {
    // Reference lines must stay visible even when the data sits away from them
    // (and provide the scale when there is no data at all yet).
    lo = Math.min(...refValues, ...(lo == null ? [] : [lo]));
    hi = Math.max(...refValues, ...(hi == null ? [] : [hi]));
  }
  if (lo == null || hi == null) return [lo, hi]; // no data, no refLines
  if (lo === hi) {
    // Collapsed range: pad relative to the value (±1 around zero) so a flat
    // series draws as a centred horizontal line.
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    return [lo - pad, hi + pad];
  }
  return [lo, hi];
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
  yAxis,
  xTime = true,
  playhead,
  onSeek,
}: {
  data: (number | null)[][];
  series: UplotSeriesConf[];
  height?: number;
  /** REC/STOP markers overlaid on every panel (t in milliseconds). */
  markers?: ChartMarker[];
  /** Dashed horizontal reference lines (e.g. expected_hz, 2%/5% thresholds). */
  refLines?: RefLine[];
  /** Optional y-axis tuning passed from the caller: a wider gutter (`size`, px)
   *  and a tick formatter (`format`) so labels don't clip a leading digit (I-10).
   *  Behaviour is baked at construction; keep it stable per chart. */
  yAxis?: { size?: number; format?: (v: number) => string };
  /** Whether x is a wall-clock time scale (default) or a plain numeric axis.
   *  The Review Signals chart uses `false`: x is episode-elapsed SECONDS, so it
   *  labels ticks as "12s" instead of a 1970 HH:MM:SS. Baked at construction. */
  xTime?: boolean;
  /** A vertical playhead line at this x value (same units as the data x — for
   *  the Signals chart, elapsed seconds). Drawn via a ref, so updating it just
   *  redraws (no plot teardown). null/undefined draws nothing. */
  playhead?: number | null;
  /** Click/drag on the plot to seek: called with the x value under the cursor
   *  (data units). When set, uPlot's drag-zoom is disabled so the drag seeks. */
  onSeek?: (xVal: number) => void;
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
  // Playhead + seek callback are read from refs by the draw hook / drag handlers
  // (both fixed at construction, so they can't close over fresh props).
  const playheadRef = useRef<number | null>(playhead ?? null);
  playheadRef.current = playhead ?? null;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const seekable = !!onSeek;

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
      // Seek owns the drag when onSeek is set; otherwise uPlot's drag-zoom stays.
      ...(seekable ? { cursor: { drag: { x: false, y: false } } } : {}),
      scales: {
        x: { time: xTime },
        y: {
          // uPlot passes the raw data extremes (null before any data arrives);
          // yRange guards the flat-data degenerate case in EVERY path — the
          // old inline version only padded when refLines were present, so the
          // Probe tab (no refLines) drew nothing for a constant-value series.
          range: (_u, dataMin, dataMax) =>
            yRange(dataMin, dataMax, refLinesRef.current.map((r) => r.v)),
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
      // Default y-axis, optionally given a wider gutter + a precision-limited tick
      // formatter by the caller so a tight range (e.g. 29.975) keeps its leading
      // digit instead of clipping in the default-width gutter (I-10).
      axes: [
        // Elapsed-seconds x (xTime=false) labels ticks as "12s"; the time scale
        // keeps uPlot's default HH:MM:SS formatting.
        xTime
          ? {}
          : {
              values: (_u, splits) =>
                splits.map((v) => (v == null ? '' : `${v}s`)),
            },
        {
          ...(yAxis?.size != null ? { size: yAxis.size } : {}),
          ...(yAxis?.format
            ? {
                values: (_u, splits) =>
                  splits.map((v) => (v == null ? '' : yAxis.format!(v))),
              }
            : {}),
        },
      ],
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

            // Playhead: a solid teal line tracking the synced video's position.
            const ph = playheadRef.current;
            if (ph != null && ph >= xMin && ph <= xMax) {
              const x = u.valToPos(ph, 'x', true);
              c.strokeStyle = '#0d9488';
              c.lineWidth = 2;
              c.setLineDash([]);
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

    // Click/drag anywhere on the plot to seek (drag-zoom is off when seekable):
    // translate the pointer x to a data value via posToVal and hand it up. The
    // move/up listeners are on window so a drag that leaves the plot still seeks.
    let dragging = false;
    const seekAt = (clientX: number) => {
      const rect = plot.over.getBoundingClientRect();
      onSeekRef.current?.(plot.posToVal(clientX - rect.left, 'x'));
    };
    const onDown = (e: MouseEvent) => {
      if (!onSeekRef.current) return;
      dragging = true;
      seekAt(e.clientX);
    };
    const onMove = (e: MouseEvent) => {
      if (dragging) seekAt(e.clientX);
    };
    const onUp = () => {
      dragging = false;
    };
    if (seekable) {
      plot.over.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      if (seekable) {
        plot.over.removeEventListener('mousedown', onDown);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      plot.destroy();
      plotRef.current = null;
    };
    // safeData is applied via the setData effect; recreate only on series/refLines/height/xTime/seekable.
  }, [seriesKey, refLinesKey, height, xTime, seekable]);

  useEffect(() => {
    plotRef.current?.setData(safeData);
  }, [safeData]);

  // Markers change independently of the series set (new REC/STOP events) — just
  // redraw the existing plot rather than tearing it down and losing zoom/state.
  //
  // NEVER redraw() a plot whose buffer is still empty. A no-arg redraw() forces
  // uPlot's shouldConvergeSize=false, so the next (microtask) _commit draws axes
  // whose tick ranges (`axis._found`) were never computed and throws — and the
  // throw skips `queuedCommit = false`, PERMANENTLY bricking the instance:
  // every later setData()/redraw() no-ops and the chart stays blank forever.
  // This effect also runs on mount, when the first-added probe series has no
  // samples yet — that was the "first series never renders until a second is
  // added" bug (adding one recreated the plot with a warm buffer).
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || (plot.data[0]?.length ?? 0) === 0) return;
    plot.redraw();
  }, [markers, playhead]);

  return <div ref={hostRef} className="w-full" />;
}
