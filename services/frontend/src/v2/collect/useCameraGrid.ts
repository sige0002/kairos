// Pane/topic wiring for the Collect camera wall, split out of Cameras.tsx:
// seeding the camera store from the robot's configured panes, live topic
// discovery for the add-camera picker, and the main pane's resolution bounds.

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { TopicInfo } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { configSeedKey } from '../seedKey';
import {
  imageTopicOptions,
  resBounds,
  seedCameraPanes,
  useCameraStore,
} from './cameraStore';

export function useCameraGrid(config: RuntimeConfig) {
  // Seed / re-seed the camera store from the robot's configured cameras. Keyed
  // by the configured topic list so a robot switch re-seeds (new cameras),
  // while tab switches keep operator-added panes and per-tile resolutions.
  const configuredTopics = useMemo(() => {
    const panes = config.stream?.panes ?? [];
    const topics = panes.map((p) => p.topic).filter((t): t is string => !!t);
    return Array.from(new Set(topics));
  }, [config.stream]);
  useEffect(() => {
    seedCameraPanes(configuredTopics, configSeedKey(configuredTopics));
  }, [configuredTopics]);

  const { panes, mainId, mainResLabel } = useCameraStore();

  // Live camera-topic discovery for the add-camera dropdown (same source and
  // cadence as v1 StreamTab). Merged with the configured default camera topics.
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', { signal }),
    refetchInterval: 5000,
  });
  const usedTopics = useMemo(() => new Set(panes.map((p) => p.topic)), [panes]);
  const addOptions = useMemo(
    () =>
      imageTopicOptions(topicsQuery.data, config.defaults.default_topics ?? []).filter(
        (o) => !usedTopics.has(o.name),
      ),
    [topicsQuery.data, config.defaults.default_topics, usedTopics],
  );

  const mainPane = panes.find((p) => p.id === mainId) ?? panes[0];
  const mainTopic = mainPane?.topic;
  const { w: mainW, h: mainH } = resBounds(mainResLabel);

  return { panes, mainId, mainResLabel, mainPane, mainTopic, mainW, mainH, addOptions };
}
