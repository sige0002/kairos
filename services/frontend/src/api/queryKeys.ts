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
  // The dataset's LeRobot export (§6.2). Its own key for the same reason the
  // archive run has one: polled every second while a conversion runs.
  datasetExport: (datasetId: string) => ['datasets', 'export', datasetId] as const,
  // What a conversion WOULD do. Keyed by everything that changes the answer —
  // the dataset, the profile, and the memo (it is the output name's last
  // segment) — so the dialog's preview follows what is typed instead of
  // showing a cached reply for a different name.
  exportPreflight: (datasetId: string, profile: string, memo: string) =>
    ['datasets', 'export-preflight', datasetId, profile, memo] as const,
  // Whether this installation can convert at all (exporter overlay present +
  // a non-empty profile library). Read before any Convert control is drawn.
  exportsConfig: ['exports', 'config'] as const,
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

// The recording-config query key. Lives here (not in the Settings editor):
// four screens read it — the Settings editor, the Robots section, Collect's
// context bar and its pre-arm engine — so it is registry-owned like the rest.
export const RECORDING_CONFIG_KEY = ['config', 'recording'] as const;
