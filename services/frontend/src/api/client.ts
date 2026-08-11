// Thin typed fetch wrapper around the api_orchestrator REST API. We keep this
// dependency-light (native fetch) and surface the shared error envelope.

import type { ApiErrorBody } from './types';

/** Error thrown for non-2xx responses, carrying the parsed error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    const message = body?.error?.message ?? fallback;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

/**
 * The REST base path, taken from the runtime config `endpoints.api`. Defaults
 * to "/api/v1" so call sites can be created before config resolves.
 */
let apiBase = '/api/v1';

export function setApiBase(base: string): void {
  apiBase = base.replace(/\/$/, '');
}

export function getApiBase(): string {
  return apiBase;
}

function joinUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  if (path.startsWith('/api/')) return path; // already absolute API path
  return `${apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function parseError(resp: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await resp.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return new ApiError(resp.status, body, `HTTP ${resp.status} ${resp.statusText}`);
}

// Default per-request deadline (S3-8). The fetch layer had NO timeout at all,
// so one hung TCP connection — a half-open link to a died host answers
// nothing, ever — became an eternal spinner on whichever screen made the call,
// with every in-flight mutation unable to settle. 30 s is far beyond any
// healthy response here and far short of "the operator gave up and reloaded".
// Calls that legitimately outlive it (a recorder stop waiting out a large
// flush) pass their own `timeoutMs`.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined>;
  /** Per-request deadline override; `0` disables the deadline entirely. */
  timeoutMs?: number;
}

/** The caller's signal combined with the request deadline. Guarded feature
 *  checks keep older test environments (no `AbortSignal.timeout`/`any`)
 *  working — they simply keep the old no-deadline behaviour. */
function requestSignal(opts: RequestOptions): AbortSignal | undefined {
  const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (ms <= 0 || typeof AbortSignal.timeout !== 'function') return opts.signal;
  const deadline = AbortSignal.timeout(ms);
  if (!opts.signal) return deadline;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([opts.signal, deadline])
    : opts.signal;
}

function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

export async function apiGet<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const resp = await fetch(joinUrl(withQuery(path, opts.query)), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: requestSignal(opts),
  });
  if (!resp.ok) throw await parseError(resp);
  return (await resp.json()) as T;
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const resp = await fetch(joinUrl(withQuery(path, opts.query)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal(opts),
  });
  if (!resp.ok) throw await parseError(resp);
  // Some POSTs (stop, cancel) may return 204/empty.
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiPatch<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const resp = await fetch(joinUrl(withQuery(path, opts.query)), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal(opts),
  });
  if (!resp.ok) throw await parseError(resp);
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiPut<T>(
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const resp = await fetch(joinUrl(withQuery(path, opts.query)), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal(opts),
  });
  if (!resp.ok) throw await parseError(resp);
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiDelete(path: string, opts: RequestOptions = {}): Promise<void> {
  const resp = await fetch(joinUrl(withQuery(path, opts.query)), {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    signal: requestSignal(opts),
  });
  if (!resp.ok) throw await parseError(resp);
}
