// Centralized TanStack Query keys so SSE dispatch and components agree on the
// cache locations they read/write.

export const queryKeys = {
  runtimeConfig: ['runtime-config'] as const,
  recordStatus: ['record', 'status'] as const,
  topics: ['topics'] as const,
  topicsStatus: ['topics', 'status'] as const,
  metrics: ['metrics'] as const,
  alerts: ['alerts'] as const,
  runs: (cursor?: string) => ['runs', cursor ?? null] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
  pipelines: ['pipelines'] as const,
  validationPresets: ['validation', 'presets'] as const,
  job: (id: string) => ['jobs', id] as const,
  jobResult: (id: string) => ['jobs', id, 'result'] as const,
  configOptions: ['config', 'options'] as const,
  configRobot: (robot: string) => ['config', 'robot', robot] as const,
  datasets: ['datasets'] as const,
  dataset: (operator: string, task: string, index: string) =>
    ['datasets', 'detail', operator, task, index] as const,
  // Advisory retention candidates (old, un-exported recordings) for the Review
  // banner. Cheap read; recomputed on request.
  retention: ['retention'] as const,
  // topic_probe (OL-③.3): topic list + per-topic numeric field introspection.
  probeTopics: ['probe', 'topics'] as const,
  probeFields: (topic: string) => ['probe', 'fields', topic] as const,
} as const;
