// Centralized TanStack Query keys so SSE dispatch and components agree on the
// cache locations they read/write.
//
// Everything recording-shaped is keyed by capture_id (contract §10). There are
// no `runs` or `episodes` keys: those resources are retired, and a stale key
// would be an invitation to fetch them again.

export const queryKeys = {
  runtimeConfig: ['runtime-config'] as const,
  recordStatus: ['record', 'status'] as const,
  topics: ['topics'] as const,
  topicsStatus: ['topics', 'status'] as const,
  metrics: ['metrics'] as const,
  alerts: ['alerts'] as const,
  // Monitor "Logs": session-local ring buffer of received SSE events, written by
  // useEventStream (never fetched). Read by the Logs sub-view.
  eventLog: ['event-log'] as const,
  // Capture catalog. `captures` is the whole subtree; `captureList(scope)` lets
  // a screen keep its own differently-shaped fetch (e.g. Review's
  // follow-the-cursor sweep) without colliding with a plain list.
  captures: ['captures'] as const,
  captureList: (scope: string) => ['captures', 'list', scope] as const,
  capture: (id: string) => ['captures', 'detail', id] as const,
  pipelines: ['pipelines'] as const,
  validationPresets: ['validation', 'presets'] as const,
  job: (id: string) => ['jobs', id] as const,
  jobResult: (id: string) => ['jobs', id, 'result'] as const,
  configOptions: ['config', 'options'] as const,
  configRobot: (robot: string) => ['config', 'robot', robot] as const,
  // Logical datasets (§6): identity is dataset_id, never a directory string.
  datasets: ['datasets'] as const,
  dataset: (datasetId: string) => ['datasets', 'detail', datasetId] as const,
  // The archive run's progress (§6.x). Its own key, not dataset(id): it is
  // polled every second while a run executes, and invalidating the detail
  // subtree at that rate would rerender the whole screen once a second.
  datasetArchive: (datasetId: string) => ['datasets', 'archive', datasetId] as const,
  // Whether this deployment offers archiving at all, and to which roots
  // (KAIROS_ARCHIVE_ROOTS). Read before any archive control is rendered.
  // Scalar, not per-capture: the endpoint is addressed by a capture id but
  // answers from KAIROS_ARCHIVE_ROOTS alone, so the answer is deployment-wide
  // and a per-capture key would refetch the same reply once per capture.
  archiveConfig: ['captures', 'archive-config'] as const,
  // What the catalog knows about its OWN condition: rebuild warnings, the
  // corrupt list, and the §9-3 SUSPECT latch. None of that is visible in a
  // capture list, which is exactly why this exists.
  storeHealth: ['store', 'health'] as const,
  // Advisory retention candidates for the Review banner. Cheap read.
  retention: ['retention'] as const,
  // Whether the robot->PC pull channel exists (split deploy) + auto-pull opt-in.
  transferStatus: ['transfer', 'status'] as const,
  batches: ['batches'] as const,
  // topic_probe (OL-③.3): topic list + per-topic numeric field introspection.
  probeTopics: ['probe', 'topics'] as const,
  probeFields: (topic: string) => ['probe', 'fields', topic] as const,
} as const;
