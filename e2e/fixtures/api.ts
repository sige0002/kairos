// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The orchestrator's HTTP API — used for SECONDARY assertions and for setup.
//
// The rule this file exists to keep visible (contract §13): a scenario's
// verdict is always the user-visible outcome in the browser. What the API says
// is corroboration — it answers "and is the sidecar truth consistent with what
// the operator was shown?", never "did it work?". Where a call here is setup
// rather than an assertion (bulk-recording captures for the §13-5 threshold),
// the caller says so at the call site.

import { stackEnv } from './stack';

export type ReplicaState =
  | 'present_unverified'
  | 'present_verified'
  | 'trashed'
  | 'absent_managed'
  | 'missing_unmanaged'
  | 'corrupt';

export interface Capture {
  capture_id: string;
  run_id: string | null;
  state: string;
  operator: string | null;
  task: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number | null;
  bytes: number | null;
  task_result: string | null;
  quality: string | null;
  review_status: string;
  review_revision: number;
  digest_state: 'pending' | 'complete';
  replica: { state: ReplicaState; manifest_digest: string | null } | null;
  delete_kind?: string | null;
  delete_reason?: string | null;
  /** How a capture that did not end cleanly ended. A bare string in the
   *  manifest (§3), widened by the orchestrator into `{code, message}`. Which
   *  message survives is itself a claim under test: the recorder's own account
   *  must win over the status-poll path's generic one. */
  error?: { code: string; message: string } | null;
}

/** One topic as ROS 2 graph discovery sees it — every topic with a publisher,
 *  whether or not the monitor is measuring it. */
export interface DiscoveredTopic {
  name: string;
  type: string | null;
  publisher_count: number;
}

/** The runtime config the whole console boots from (`GET /config`). Only the
 *  fields the acceptance specs read are declared. */
export interface RuntimeConfig {
  defaults: {
    robot_name?: string;
    /** The monitor's subscribe allowlist AND the recorder's default set. A
     *  topic outside it is discovered but never measured (topic_monitor's
     *  RosTopicSubscriber subscribes to this list alone). */
    default_topics: string[];
    expected_hz?: Record<string, number>;
  };
}

/** A selectable config option (`GET /config/options`). The `validation` aspect's
 *  options are the fast_validation templates, and their `meta.required_topics`
 *  is what the Validation screen's checklist is built from. */
export interface AspectOption {
  id: string;
  path: string;
  meta: {
    name?: string;
    version?: number;
    required_topics?: { name: string; type?: string | null }[];
  };
}

export interface ConfigOptions {
  active_robot: string;
  aspects: Record<string, { active: string | null; options: AspectOption[] }>;
}

/** `GET`/`PUT /config/recording` — the live RECORDING_CONFIG plus the file it
 *  was loaded from (a container path under `/config`). */
export interface RecordingConfigPayload {
  config: Record<string, unknown> | null;
  path: string;
}

export interface StoreHealth {
  state: 'ok' | 'suspect';
  suspect_reason: string | null;
  delete_available: boolean;
  rebuilt_at: string | null;
  rebuild_summary: Record<string, unknown> | null;
  last_reconcile: Record<string, unknown> | null;
  corrupt: { capture_id: string | null; path: string; reason: string }[];
}

/** An HTTP answer the server actually gave. Never retried: a 409 or a 500 is
 *  the result, and quietly asking again would hide it. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/** Transport-level attempts before giving up. §13-4 stops and restarts the
 *  orchestrator mid-test, which kills every pooled keep-alive socket Node is
 *  holding; the next request then fails with `SocketError: other side closed`
 *  before it reaches the (perfectly healthy) restarted server. Retrying ONLY
 *  connection failures — never an HTTP status — clears that without hiding a
 *  service that is genuinely down: a real outage still fails, just with a
 *  message that says how many attempts it took. */
const TRANSPORT_ATTEMPTS = 5;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { apiUrl } = stackEnv();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new ApiHttpError(
          res.status,
          text,
          `${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`,
        );
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof ApiHttpError) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(
    `${method} ${path} was unreachable after ${TRANSPORT_ATTEMPTS} attempts: ${String(lastErr)}`,
  );
}

export const api = {
  listCaptures: (query = ''): Promise<{ items: Capture[]; next_cursor: string | null }> =>
    call('GET', `/captures${query}`),

  getCapture: (id: string): Promise<Capture> => call('GET', `/captures/${id}`),

  /** Every capture the catalog holds, tombstones included. */
  async allCaptures(includeDeleted = false): Promise<Capture[]> {
    const q = includeDeleted ? '?limit=200&include_deleted=true' : '?limit=200';
    return (await api.listCaptures(q)).items;
  },

  recordStart: (body: Record<string, unknown>): Promise<Capture> =>
    call('POST', '/record/start', body),

  recordStop: (): Promise<Capture> => call('POST', '/record/stop', {}),

  recordStatus: (): Promise<Record<string, unknown>> => call('GET', '/record/status'),

  saveReview: (id: string, body: Record<string, unknown>): Promise<Capture> =>
    call('PATCH', `/captures/${id}/review`, body),

  storeHealth: (): Promise<StoreHealth> => call('GET', '/store/health'),

  /** Run a reconciler pass now. The background loop is on a 120 s timer; the
   *  endpoint exists so a test drives the pass instead of sleeping through it.
   *  It runs the SAME code path — only the schedule is bypassed. */
  reconcile: (): Promise<Record<string, unknown>> => call('POST', '/store/reconcile', undefined),

  /** The runtime config the console boots from. */
  runtimeConfig: (): Promise<RuntimeConfig> => call('GET', '/config'),

  /** The ROS 2 graph as discovery currently sees it. Distinct from the
   *  monitor's metrics: discovery lists every topic, the monitor measures only
   *  the `default_topics` allowlist. */
  topics: (): Promise<{ topics: DiscoveredTopic[] }> => call('GET', '/topics'),

  /** Robot-first config options + the active selection per aspect. */
  configOptions: (): Promise<ConfigOptions> => call('GET', '/config/options'),

  /** The live recording config + its path. Used by the Settings scenario to
   *  state what the screen must be showing, and to prove a save changed
   *  nothing. */
  recordingConfig: (): Promise<RecordingConfigPayload> => call('GET', '/config/recording'),

  listDatasets: (): Promise<{
    items: {
      dataset_id: string;
      name: string;
      status: string;
      archive_destination: string | null;
    }[];
  }> => call('GET', '/datasets'),
};

/**
 * Record one capture through the API, start to finish.
 *
 * SETUP ONLY. Scenario §13-1 records through the browser, because that is the
 * behaviour under test; this exists for §13-5, which needs six captures purely
 * to reach the missing-copy threshold and would otherwise spend four minutes
 * re-testing the Collect screen it already tested.
 */
export async function recordCaptureViaApi(opts: {
  operator?: string;
  task?: string;
  seconds?: number;
}): Promise<string> {
  const started = await api.recordStart({
    topics: 'all',
    operator: opts.operator ?? 'e2e',
    task: opts.task ?? 'bulk',
  });
  await new Promise((r) => setTimeout(r, (opts.seconds ?? 3) * 1000));
  const stopped = await api.recordStop();
  const id = stopped.capture_id || started.capture_id;
  if (!id) throw new Error('record/stop returned no capture_id');
  return id;
}

/** Poll until `predicate` holds, or throw with what was last seen. */
export async function until<T>(
  what: string,
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = lastErr ? `last error: ${String(lastErr)}` : `last value: ${JSON.stringify(last)}`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} — ${detail}`);
}
