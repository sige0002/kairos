// Stream tab: live WebRTC camera preview. The user picks a topic (seeded from
// discovery / config) and we negotiate a recvonly peer connection directly to
// the streamer. Connection state, retry, and a codec/connection fallback are
// surfaced clearly.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { TopicInfo } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { useWebRtcStream } from './useWebRtcStream';

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

export function StreamTab({ config }: { config: RuntimeConfig }) {
  // Topic candidates for the preview selector come from discovery (best-effort).
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { items: TopicInfo[] }>('/topics', { signal }),
  });
  const topics: TopicInfo[] = Array.isArray(topicsQuery.data)
    ? topicsQuery.data
    : (topicsQuery.data?.items ?? []);
  const imageTopics = topics.filter(
    (t) => /image/i.test(t.type) || /image/i.test(t.name),
  );

  const [topic, setTopic] = useState('');
  // Default to the first discovered image topic once available.
  useEffect(() => {
    if (!topic && imageTopics[0]) setTopic(imageTopics[0].name);
  }, [topic, imageTopics]);

  const { phase, stream, error, retry } = useWebRtcStream({
    webrtcBase: config.endpoints.webrtc,
    topic,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Camera topic</span>
          <input
            list="image-topics"
            className="rounded border px-2 py-1 font-mono"
            value={topic}
            placeholder="/camera/.../image_raw"
            onChange={(e) => setTopic(e.target.value)}
          />
          <datalist id="image-topics">
            {imageTopics.map((t) => (
              <option key={t.name} value={t.name} />
            ))}
          </datalist>
        </label>
        <span
          className="rounded bg-gray-100 px-2 py-0.5 text-xs"
          data-testid="stream-phase"
        >
          {phase}
        </span>
        <button
          type="button"
          onClick={retry}
          className="rounded border px-3 py-1 text-sm"
        >
          Retry
        </button>
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
        <p className="text-sm text-gray-500">
          Select a camera topic to start the preview.
        </p>
      )}
    </div>
  );
}
