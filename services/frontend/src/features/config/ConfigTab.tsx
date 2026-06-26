// Config tab. Two sections:
//  1. Recording config editor — edits the FULL RECORDING_CONFIG as JSON and
//     PUTs it to /api/v1/config/recording, which persists it on-prem and
//     hot-swaps the orchestrator's in-memory copy. default_topics / robot_name
//     apply immediately (GET /api/v1/config + next start); expected_hz (monitor)
//     and QoS (recorder) only fully apply after a service restart (those caches
//     load at startup) — the UI says so honestly after a save.
//  2. Validation template selector (Phase 1) — picking a template applies
//     immediately (the orchestrator injects it into template-less
//     fast_validation jobs; no restart).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, getApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ApiErrorBody, ConfigOptions, RecordingConfigPayload } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, SectionLabel } from '../../components/ui';

// Local key (queryKeys is shared and owned elsewhere); the recording-config
// query is Config-tab-local, so a plain stable tuple is enough.
const RECORDING_CONFIG_KEY = ['config', 'recording'] as const;

/** PUT the edited config. Inline (no apiPut helper) so client.ts is untouched. */
async function putRecordingConfig(
  config: Record<string, unknown>,
): Promise<RecordingConfigPayload> {
  const resp = await fetch(`${getApiBase()}/config/recording`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (!resp.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await resp.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(resp.status, body, `HTTP ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as RecordingConfigPayload;
}

/** Format the 422 validation details (pydantic errors) into a readable list. */
function formatValidationDetails(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const errors = error.details?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((e) => {
    const rec = e as { loc?: unknown[]; msg?: string };
    const loc = Array.isArray(rec.loc) ? rec.loc.join('.') : '';
    return loc ? `${loc}: ${rec.msg ?? ''}` : (rec.msg ?? '');
  });
}

/** Editable JSON editor for the full RECORDING_CONFIG. */
function RecordingConfigEditor({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();

  const recordingQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) =>
      apiGet<RecordingConfigPayload>('/config/recording', { signal }),
  });

  // The editable text buffer + a client-side JSON parse error (blocks submit).
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the buffer from the fetched config (pretty-printed). Re-seed only when
  // the fetched payload identity changes, so we don't clobber in-progress edits.
  useEffect(() => {
    if (recordingQuery.data) {
      const cfg = recordingQuery.data.config ?? {};
      setText(JSON.stringify(cfg, null, 2));
      setParseError(null);
    }
  }, [recordingQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (parsed: Record<string, unknown>) => putRecordingConfig(parsed),
    onSuccess: (data) => {
      setSaved(true);
      // Reflect the saved state: refetch the recording config and invalidate the
      // runtime config so the Record/Monitor tabs pick up the new defaults.
      queryClient.setQueryData(RECORDING_CONFIG_KEY, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
    },
  });

  const onSave = () => {
    setSaved(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'JSON parse error');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setParseError('Config must be an object ({ ... }).');
      return;
    }
    setParseError(null);
    saveMutation.mutate(parsed as Record<string, unknown>);
  };

  const path = recordingQuery.data?.path;
  const robot = config.defaults.robot_name;
  const topics = config.defaults.default_topics ?? [];
  const validationDetails = formatValidationDetails(saveMutation.error);

  return (
    <section
      aria-label="recording config editor"
      className="rounded-card border border-gray-200 bg-white p-[18px] shadow-card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>Recording config (RECORDING_CONFIG)</SectionLabel>
        <Badge tone="gray">Edit full config</Badge>
      </div>

      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-gray-500">Robot</dt>
        <dd className="font-mono text-gray-800">{robot || '—'}</dd>
        <dt className="text-gray-500">Default topics</dt>
        <dd className="font-mono text-gray-800">{topics.length}</dd>
        {path && (
          <>
            <dt className="text-gray-500">Path</dt>
            <dd className="font-mono text-xs text-gray-500">{path}</dd>
          </>
        )}
      </dl>

      {recordingQuery.isError ? (
        <ErrorMessage error={recordingQuery.error} />
      ) : recordingQuery.isPending ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Config (JSON)
          </label>
          <textarea
            aria-label="recording config json"
            className="h-80 w-full rounded-control border border-gray-200 p-2 font-mono text-xs focus:border-teal-500 focus:outline-none"
            spellCheck={false}
            value={text}
            disabled={saveMutation.isPending}
            onChange={(e) => {
              setText(e.target.value);
              setParseError(null);
              setSaved(false);
            }}
          />

          {parseError && (
            <p className="mt-2 text-sm text-red-700">JSON error: {parseError}</p>
          )}

          {saveMutation.isError && (
            <div className="mt-2">
              <ErrorMessage error={saveMutation.error} />
              {validationDetails.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
                  {validationDetails.map((d, i) => (
                    <li key={i} className="font-mono">
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {saved && !saveMutation.isPending && (
            <div className="mt-2 rounded-control border border-teal-200 bg-teal-50 p-2 text-sm text-teal-800">
              <p className="font-medium">Saved</p>
              <p className="mt-0.5 text-xs">
                default_topics / robot_name apply immediately; expected_hz and QoS apply
                after a service restart.
              </p>
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={saveMutation.isPending}
              className="rounded-control bg-teal-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <span className="text-xs text-gray-400">
              Edit the full RecordingConfig as JSON. The server validates on save.
            </span>
          </div>
        </>
      )}
    </section>
  );
}

export function ConfigTab({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });

  const selectMutation = useMutation({
    mutationFn: (vars: { category: string; id: string }) =>
      apiPost<ConfigOptions>('/config/select', vars),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.configOptions, data),
  });

  const validation = optionsQuery.data?.validation;
  const active = validation?.active ?? '';
  const activeOption = validation?.options.find((o) => o.id === active);

  return (
    <div className="flex flex-col gap-4">
      <RecordingConfigEditor config={config} />
      <section
        aria-label="validation config"
        className="rounded-card border border-gray-200 bg-white p-[18px] shadow-card"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
            Validation
          </h2>
          <Badge tone="green" dot>
            applies immediately
          </Badge>
        </div>
        <p className="mb-3 text-sm text-gray-500">
          The active template is used by <span className="font-mono">fast_validation</span>{' '}
          jobs that don&apos;t pass their own template. Files come from{' '}
          <span className="font-mono">config/validation/</span>.
        </p>

        {optionsQuery.isError ? (
          <ErrorMessage error={optionsQuery.error} />
        ) : optionsQuery.isPending ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (validation?.options.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500">
            No validation templates found in config/validation/.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Active template</span>
              <select
                aria-label="validation template"
                className="rounded-control border border-gray-200 px-2 py-1 font-mono focus:border-teal-500 focus:outline-none"
                value={active}
                disabled={selectMutation.isPending}
                onChange={(e) =>
                  selectMutation.mutate({ category: 'validation', id: e.target.value })
                }
              >
                {validation?.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} (v{o.version}) · {o.required_topics.length} topics
                  </option>
                ))}
              </select>
            </label>
            {selectMutation.isError && (
              <div className="mt-2">
                <ErrorMessage error={selectMutation.error} />
              </div>
            )}

            {activeOption && (
              <div className="mt-3">
                <h3 className="mb-1.5 text-sm font-medium text-gray-700">
                  Required topics ({activeOption.required_topics.length})
                </h3>
                <ul className="max-h-72 overflow-auto rounded-control border border-gray-200 text-xs">
                  {activeOption.required_topics.map((t) => (
                    <li
                      key={t.name}
                      className="flex justify-between gap-2 border-t border-gray-100 px-2 py-1.5 first:border-t-0"
                    >
                      <span className="font-mono text-gray-700">{t.name}</span>
                      <span className="font-mono text-gray-400">{t.type ?? 'any type'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <p className="text-sm text-gray-500">
        Record / robot / stream / convert selection arrives in later phases (record and
        robot apply on restart; stream and convert apply immediately).
      </p>
    </div>
  );
}
