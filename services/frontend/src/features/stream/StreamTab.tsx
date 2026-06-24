// Stream tab: live WebRTC camera previews. You can run MORE THAN ONE preview at
// once — "Add camera" appends another pane, each with its own camera-topic
// dropdown and its own recvonly peer connection. Topics are seeded from live
// discovery (GET /api/v1/topics) merged with the configured camera topics
// (config.defaults.default_topics) — no hand-typing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { TopicInfo } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { useWebRtcStream } from './useWebRtcStream';

// A topic is a camera/image topic if its type is an (Compressed)Image or its
// name looks like an image stream. `camera_info` (metadata) is excluded.
function isImageType(type?: string): boolean {
  return !!type && /image/i.test(type);
}
function isImageName(name: string): boolean {
  return /image/i.test(name);
}

function asTopicList(data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }) {
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

// Static grid column classes (literal so Tailwind's content scan keeps them).
const GRID_COLS: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
};

interface CameraOption {
  name: string;
  type?: string;
  live: boolean;
}

function VideoSurface({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="aspect-video w-full rounded bg-black"
      data-testid="stream-video"
    />
  );
}

/** One independent camera preview (its own topic + peer connection). */
function CameraPane({
  options,
  defaultTopic,
  webrtcBase,
  removable,
  onRemove,
}: {
  options: CameraOption[];
  defaultTopic: string;
  webrtcBase: string;
  removable: boolean;
  onRemove: () => void;
}) {
  const [topic, setTopic] = useState(defaultTopic);
  // Keep a valid selection as discovery changes.
  useEffect(() => {
    if (topic && options.some((o) => o.name === topic)) return;
    const first = options.find((o) => o.live) ?? options[0];
    if (first) setTopic(first.name);
  }, [topic, options]);

  const { phase, stream, error, retry } = useWebRtcStream({ webrtcBase, topic });

  return (
    <div className="flex flex-col gap-2 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="camera topic"
          className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-sm"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        >
          {options.length === 0 ? (
            <option value="">No camera topics — start a bag/robot</option>
          ) : (
            options.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name}
                {o.live ? '' : ' (offline)'}
              </option>
            ))
          )}
        </select>
        <span
          className="rounded bg-gray-100 px-2 py-0.5 text-xs"
          data-testid="stream-phase"
        >
          {phase}
        </span>
        <button type="button" onClick={retry} className="rounded border px-2 py-1 text-xs">
          Retry
        </button>
        {removable && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="remove camera"
            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
          >
            Remove
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{error}</p>
          <p className="mt-1 text-red-600">
            If the camera codec is unsupported by this browser or the connection cannot
            be established, try a different topic or retry.
          </p>
        </div>
      )}

      {topic ? (
        <VideoSurface stream={stream} />
      ) : (
        <p className="text-sm text-gray-500">Select a camera topic to start the preview.</p>
      )}
    </div>
  );
}

export function StreamTab({ config }: { config: RuntimeConfig }) {
  const defaultTopics = config.defaults.default_topics ?? [];

  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', {
        signal,
      }),
    refetchInterval: 5000,
  });

  const options: CameraOption[] = useMemo(() => {
    const live = asTopicList(topicsQuery.data ?? []).filter(
      (t) => isImageType(t.type) || isImageName(t.name),
    );
    const byName = new Map<string, CameraOption>();
    for (const t of live) byName.set(t.name, { name: t.name, type: t.type, live: true });
    for (const name of defaultTopics) {
      if (isImageName(name) && !byName.has(name)) {
        byName.set(name, { name, live: false });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [topicsQuery.data, defaultTopics]);

  const firstLive = (options.find((o) => o.live) ?? options[0])?.name ?? '';

  // Initial panes come from STREAM_CONFIG (config.stream.panes): how many open
  // and what each shows. With none configured, open one empty pane. Add/remove
  // works at runtime regardless.
  const nextId = useRef(1);
  const [panes, setPanes] = useState<{ id: number; topic: string }[]>(() => {
    const configured = config.stream?.panes ?? [];
    const init =
      configured.length > 0
        ? configured.map((p, i) => ({ id: i, topic: p.topic ?? '' }))
        : [{ id: 0, topic: '' }];
    nextId.current = init.length;
    return init;
  });

  const gridCols = GRID_COLS[config.stream?.columns ?? 2] ?? 'lg:grid-cols-2';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setPanes((ps) => [...ps, { id: nextId.current++, topic: '' }])
          }
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
        >
          + Add camera
        </button>
        <span className="text-xs text-gray-500">{panes.length} preview(s)</span>
      </div>

      {panes.length === 0 ? (
        <p className="text-sm text-gray-500">No previews. Add a camera.</p>
      ) : (
        <div className={`grid grid-cols-1 gap-3 ${gridCols}`}>
          {panes.map((pane) => (
            <CameraPane
              key={pane.id}
              options={options}
              defaultTopic={pane.topic || firstLive}
              webrtcBase={config.endpoints.webrtc}
              removable={panes.length > 1}
              onRemove={() => setPanes((ps) => ps.filter((p) => p.id !== pane.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
