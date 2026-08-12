// Generic, backend-driven result view. Renders ANY pipeline's summary.json
// without knowing its shape, so a plugin author never edits the UI to surface a
// new pipeline's output (see docs/specs/ja/dora_plugins.md §「UI 非依存の契約」).
//
// The kairos summary contract is a loose convention — {pipeline, version,
// result?, message?, metrics?, checked_at, ...} — so we render the few known
// fields prominently (PASS/FAIL badge, headline message) and everything else as
// a nested key/value tree, with the raw JSON always available underneath. The
// bundled fast_validation keeps its own bespoke card; every other pipeline
// (loss_report, video_check, and any plugin) lands here.

import type { ReactNode } from 'react';
import { getApiBase } from '../../api/client';
import { Badge, Card, SectionLabel } from '../../components/ui';

/** A job summary is free-form JSON; only a handful of keys are conventional. */
export interface Summary {
  pipeline?: string;
  version?: string | number;
  result?: 'pass' | 'fail' | string;
  message?: string;
  checked_at?: string;
  [key: string]: unknown;
}

// Top-level keys rendered in the header/footer, so the key/value body skips them.
const HEADER_KEYS = new Set(['pipeline', 'version', 'result', 'message', 'checked_at']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function Scalar({ value }: { value: unknown }) {
  return <span className="break-words font-mono text-[12.5px] text-gray-700">{formatScalar(value)}</span>;
}

/** Render one summary value: scalar inline, object as nested rows, array smartly. */
function Value({ value }: { value: unknown }): ReactNode {
  if (isRecord(value)) return <KeyValueRows data={value} nested />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Scalar value="—" />;
    // Array of scalars -> comma list; array of objects -> raw JSON block.
    if (value.every((item) => !isRecord(item) && !Array.isArray(item))) {
      return <Scalar value={value.map(formatScalar).join(', ')} />;
    }
    return (
      <pre className="overflow-x-auto rounded-control bg-gray-50 p-2 font-mono text-[11px] text-gray-600">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <Scalar value={value} />;
}

// ---- Artifacts ---------------------------------------------------------------
// The zero-UI-edit visualisation channel for plugins: the orchestrator returns
// artifact paths RELATIVE to the data dir (JobResult normalisation), which makes
// each one fetchable via GET /api/v1/files/{path}. An image artifact (a plot a
// pipeline wrote next to its summary.json) renders inline; any other fetchable
// file becomes a download link; a path that couldn't be normalised (absolute =
// outside the data dir) stays plain text — we never fabricate a link that 404s.

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

/** `/api/v1/files/…` URL for a data-relative artifact path; null when absolute. */
export function artifactHref(path: string): string | null {
  if (path.startsWith('/')) return null;
  return `${getApiBase()}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function Artifact({ path }: { path: string }) {
  const href = artifactHref(path);
  if (!href) {
    return <p className="truncate font-mono text-[11px] text-gray-500">{path}</p>;
  }
  if (IMAGE_EXT.test(path)) {
    return (
      <figure className="my-1.5">
        <img
          src={href}
          alt={path}
          loading="lazy"
          className="max-h-64 max-w-full rounded-control border border-gray-100"
        />
        <figcaption className="mt-0.5 truncate font-mono text-[11px] text-gray-500">
          {path}
        </figcaption>
      </figure>
    );
  }
  return (
    <p className="truncate font-mono text-[11px]">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-teal-700 underline decoration-dotted hover:text-teal-800"
      >
        {path}
      </a>
    </p>
  );
}

function KeyValueRows({ data, nested = false }: { data: Record<string, unknown>; nested?: boolean }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <Scalar value="—" />;
  return (
    <div className={nested ? 'flex flex-col' : 'flex flex-col'}>
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="grid grid-cols-[minmax(0,168px)_1fr] items-start gap-3 border-b border-gray-50 py-2 last:border-b-0"
        >
          <span className="truncate font-mono text-[11.5px] text-gray-500">{key}</span>
          <div className="min-w-0">
            <Value value={value} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Render a pipeline's summary.json generically. `pipeline` is the id used only
 * as a header fallback when the summary omits its own `pipeline` field.
 */
export function SummaryResult({
  pipeline,
  summary,
  artifacts = [],
}: {
  pipeline: string;
  summary: Summary;
  artifacts?: string[];
}) {
  const result = summary.result;
  const badgeTone = result === 'pass' ? 'green' : result === 'fail' ? 'red' : 'gray';
  const name = summary.pipeline ?? pipeline;
  // Body = every non-header key (metrics, params, and any plugin-specific field).
  const body = Object.fromEntries(
    Object.entries(summary).filter(([key]) => !HEADER_KEYS.has(key)),
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>Result</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-500">
          {name}
          {summary.version != null && ` · v${summary.version}`}
        </span>
        <div className="flex-1" />
        {result != null && (
          <Badge tone={badgeTone} dot>
            {String(result).toUpperCase()}
          </Badge>
        )}
      </div>

      {typeof summary.message === 'string' && (
        <p className="border-b border-gray-100 px-[18px] py-4 font-mono text-[15px] text-gray-800">
          {summary.message}
        </p>
      )}

      {Object.keys(body).length > 0 && (
        <div className="px-[18px] py-1.5">
          <KeyValueRows data={body} />
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="border-t border-gray-100 px-[18px] py-3">
          <p className="mb-1 text-[10px] uppercase tracking-[0.05em] text-gray-500">Artifacts</p>
          {artifacts.map((path) => (
            <Artifact key={path} path={path} />
          ))}
        </div>
      )}

      <details className="border-t border-gray-100 px-[18px] py-3">
        <summary className="cursor-pointer text-[11px] text-gray-500">Raw summary.json</summary>
        <pre className="mt-2 overflow-x-auto rounded-control bg-gray-50 p-2 font-mono text-[11px] text-gray-600">
          {JSON.stringify(summary, null, 2)}
        </pre>
      </details>
    </Card>
  );
}
