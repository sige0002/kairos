// Loss-location heatmap for the Review Signals section (signal_report v1.1).
// One compact row per topic (all topics from the sidecar, stacked) on the shared
// episode-GLOBAL time axis: each row's bins are coloured from the topic's density
// bins + loss events (see `binColor`) — green ok, amber over a minor loss event,
// red over a major one or an empty bin inside the topic's active range, gray for
// the topic's own silence before it began / after it stopped. Pure divs, no chart
// lib. Hovering a bin shows its time + message count; clicking a bin (or the row
// label) seeks — the label selects that topic as the charted one, a bin asks the
// parent to seek the charted playhead + synced video to the bin's global time.

import {
  type BinColor,
  type SignalReportExt,
  type SignalTopicReportExt,
  binColor,
  episodeSpanNs,
  formatSecondsShort,
  greenIntensity,
  medianNonZero,
  topicActiveRangeNs,
} from './signalReport';

const COLOR_CLASS: Record<BinColor, string> = {
  gray: 'bg-gray-100',
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
};

function TopicRow({
  name,
  topic,
  spanNs,
  selected,
  onSelect,
  onSeekBin,
}: {
  name: string;
  topic: SignalTopicReportExt;
  spanNs: number;
  selected: boolean;
  onSelect: () => void;
  onSeekBin: (globalNs: number) => void;
}) {
  const bins = topic.bins;
  const [activeStart, activeEnd] = topicActiveRangeNs(topic, spanNs);
  const median = bins ? medianNonZero(bins.densities) : 0;
  const lossEvents = topic.loss_events ?? [];

  return (
    <div
      data-testid={`heatmap-row-${name}`}
      className={`flex items-center gap-2 ${selected ? 'rounded-chip bg-teal-50/60' : ''}`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={selected ? 'Charted topic' : 'Chart this topic'}
        className={`w-[150px] shrink-0 truncate text-left font-mono text-[10.5px] ${
          selected ? 'font-semibold text-teal-700' : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        {name}
      </button>
      {bins ? (
        <div
          className="grid h-3 flex-1 overflow-hidden rounded-[3px]"
          style={{ gridTemplateColumns: `repeat(${bins.densities.length}, 1fr)` }}
        >
          {bins.densities.map((density, i) => {
            const cat = binColor({
              binIndex: i,
              binNs: bins.bin_ns,
              density,
              activeStartNs: activeStart,
              activeEndNs: activeEnd,
              lossEvents,
            });
            const opacity =
              cat === 'green' ? 0.4 + 0.6 * greenIntensity(density, median) : 1;
            const atNs = i * bins.bin_ns;
            return (
              <button
                key={i}
                type="button"
                data-testid="heatmap-cell"
                data-color={cat}
                title={`${formatSecondsShort(atNs)} · ${density} msg${density === 1 ? '' : 's'}`}
                onClick={() => onSeekBin(atNs)}
                className={`h-full ${COLOR_CLASS[cat]}`}
                style={{ opacity }}
              />
            );
          })}
        </div>
      ) : (
        <div className="h-3 flex-1 rounded-[3px] bg-gray-100 text-[9px] leading-3 text-gray-400">
          <span className="px-1">no bins (&lt; 2 messages)</span>
        </div>
      )}
    </div>
  );
}

/**
 * The stacked per-topic loss heatmap. Renders nothing (honest) when the sidecar
 * carries no global span (v1.0 sidecar) or no topics — the caller still shows
 * the chart. `onSeekGlobal` receives a global-axis time (ns); `onSelectTopic`
 * makes a row the charted topic.
 */
export function SignalHeatmap({
  report,
  selectedTopic,
  onSelectTopic,
  onSeekGlobal,
}: {
  report: SignalReportExt;
  selectedTopic: string | null;
  onSelectTopic: (topic: string) => void;
  onSeekGlobal: (globalNs: number) => void;
}) {
  const spanNs = episodeSpanNs(report);
  const topics = Object.keys(report.topics);
  if (spanNs <= 0 || topics.length === 0) return null;

  return (
    <div data-testid="review-signal-heatmap" className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.04em] text-gray-400">
          Loss map
        </span>
        <span className="font-mono text-[10px] text-gray-400">
          span {formatSecondsShort(spanNs)}
        </span>
      </div>
      {topics.map((name) => (
        <TopicRow
          key={name}
          name={name}
          topic={report.topics[name]!}
          spanNs={spanNs}
          selected={name === selectedTopic}
          onSelect={() => onSelectTopic(name)}
          onSeekBin={onSeekGlobal}
        />
      ))}
    </div>
  );
}
