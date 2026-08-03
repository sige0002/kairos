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
