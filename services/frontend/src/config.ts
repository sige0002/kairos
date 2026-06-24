// Runtime config the frontend fetches from the api_orchestrator before
// rendering (backend-driven). Shape follows docs/specs/ja/config.md.
//
// The tab list, endpoints, default form values and JSON Schemas all come from
// GET /api/v1/config. The frontend never hardcodes the tab set in production;
// a dev fallback is provided only so the UI is usable without a backend.

import type { JSONSchema } from './schema/jsonSchema';

export interface TabConfig {
  id: string;
  enabled: boolean;
  /** Optional human label; falls back to a built-in map then the id. */
  label?: string;
  /** Optional explicit ordering; tabs without an order keep config order. */
  order?: number;
}

export interface RuntimeEndpoints {
  /** REST base, e.g. "/api/v1". */
  api: string;
  /** SSE stream path, e.g. "/api/v1/events". */
  events: string;
  /** Absolute base URL of the webrtc_streamer (WEBRTC_PUBLIC_URL). */
  webrtc: string;
}

export interface RuntimeDefaults {
  /** Pattern -> expected Hz map used to seed the record form / monitor view. */
  expected_hz?: Record<string, number>;
  /** Default stream encoding. */
  encoding?: 'vp8' | 'h264';
  /**
   * Topics recorded / monitored by default (from the backend RECORDING_CONFIG).
   * Pre-checked in the Record tab; flagged as "configured" in the Monitor tab.
   * May contain glob patterns (e.g. "/camera/*&#47;compressed").
   */
  default_topics?: string[];
  /** Robot name from the active RECORDING_CONFIG (shown for operator context). */
  robot_name?: string;
  [key: string]: unknown;
}

/** Stream tab initial layout (from the backend STREAM_CONFIG / config/stream.yaml). */
export interface StreamLayout {
  /** Preview-grid column count (1–4). */
  columns?: number;
  /** Initial panes, each previewing one camera topic (topic may be empty). */
  panes?: { topic?: string | null }[];
}

export interface RuntimeConfig {
  endpoints: RuntimeEndpoints;
  tabs: TabConfig[];
  defaults: RuntimeDefaults;
  /** Stream tab initial panes (optional; absent → one empty pane). */
  stream?: StreamLayout;
  /**
   * Backend-provided JSON Schemas (draft 2020-12). Known keys:
   *  - record_start: the record Start request body schema
   *  - pipeline_forms: { <pipeline_id>: schema } for the Pipelines tab
   */
  schemas: {
    record_start?: JSONSchema;
    pipeline_forms?: Record<string, JSONSchema>;
    [key: string]: JSONSchema | Record<string, JSONSchema> | undefined;
  };
}

// Single source of the config endpoint. The Vite dev server proxies /api to
// the orchestrator; in the served build the orchestrator is reached via the
// same origin / reverse proxy.
export const CONFIG_URL = '/api/v1/config';

/**
 * Dev-only fallback so the SPA is usable when no backend is reachable.
 * Production MUST use the backend response; this mirrors the example in
 * docs/specs/ja/config.md. Enabled only under `import.meta.env.DEV`.
 */
export const DEV_FALLBACK_CONFIG: RuntimeConfig = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [
    { id: 'record', enabled: true },
    { id: 'monitor', enabled: true },
    { id: 'stream', enabled: true },
    { id: 'runs', enabled: true },
    { id: 'pipelines', enabled: false },
  ],
  defaults: { expected_hz: {}, encoding: 'vp8' },
  schemas: {},
};

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  let resp: Response;
  try {
    resp = await fetch(CONFIG_URL);
  } catch (err) {
    // Network failure (no backend). In dev, fall back so the UI renders.
    if (import.meta.env.DEV) {
      return DEV_FALLBACK_CONFIG;
    }
    throw err;
  }
  if (!resp.ok) {
    if (import.meta.env.DEV) {
      return DEV_FALLBACK_CONFIG;
    }
    throw new Error(`Failed to load runtime config: HTTP ${resp.status}`);
  }
  return (await resp.json()) as RuntimeConfig;
}

/**
 * Resolve the ordered, enabled-aware tab list. Order: explicit `order` first
 * (ascending), then config order. Disabled tabs are kept so the UI can show
 * them greyed out, but callers filter as needed.
 */
export function orderTabs(tabs: TabConfig[]): TabConfig[] {
  return [...tabs]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ao = a.t.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.t.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.i - b.i;
    })
    .map(({ t }) => t);
}
