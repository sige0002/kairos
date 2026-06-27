// Thin uPlot wrapper for the Probe overlay: a time-series chart with axis ticks,
// a legend, hover crosshair, and multiple overlaid series — the things the
// hand-rolled SVG charts lacked (axis numbers + overlay). Guarded so a
// canvas-less environment (jsdom in unit tests) renders an empty container
// instead of throwing.

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface UplotSeriesConf {
  label: string;
  stroke: string;
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
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
    // Skip entirely in a canvas-less env (jsdom unit tests): even a caught
    // construction leaves uPlot async callbacks that crash on a null context.
    let ctx: unknown = null;
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const plot = new uPlot(opts, data as uPlot.AlignedData, host);
    plotRef.current = plot;
    const onResize = () =>
      plot.setSize({ width: host.clientWidth || 600, height });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plot.destroy();
      plotRef.current = null;
    };
    // data is applied via the setData effect; recreate only on series/height.
  }, [seriesKey, height]);

  useEffect(() => {
    plotRef.current?.setData(data as uPlot.AlignedData);
  }, [data]);

  return <div ref={hostRef} className="w-full" />;
}
