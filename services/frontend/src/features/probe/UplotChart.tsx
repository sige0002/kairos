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
}: {
  data: (number | null)[][];
  series: UplotSeriesConf[];
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // uPlot series are fixed at construction, so recreate the plot when the SERIES
  // SET changes; data-only changes go through setData (the second effect).
  const seriesKey = series.map((s) => `${s.label}:${s.stroke}`).join('|');
  const safeData = useMemo(
    () => normalizeData(data, series.length),
    [data, series.length],
  );

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
      scales: { x: { time: true } },
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
    // safeData is applied via the setData effect; recreate only on series/height.
  }, [seriesKey, height]);

  useEffect(() => {
    plotRef.current?.setData(safeData);
  }, [safeData]);

  return <div ref={hostRef} className="w-full" />;
}
