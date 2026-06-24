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
  job: (id: string) => ['jobs', id] as const,
  configOptions: ['config', 'options'] as const,
} as const;
