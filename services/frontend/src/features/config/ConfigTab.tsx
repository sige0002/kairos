// Config tab — robot-first: pick the active ROBOT, then per ASPECT
// (recording / stream / validation / validators) pick which committed (or local)
// *.yaml option is active. Nothing is hardcoded; robots + options come from
// GET /api/v1/config/options. Selecting a robot re-points recording + stream;
// selecting an aspect option switches that aspect. Recording is editable as JSON
// (PUT /api/v1/config/recording) and writes back to the ACTIVE recording file
// (which may be a gitignored config/local/<robot>/... path). default_topics /
// robot_name apply immediately; recorder QoS + monitor expected_hz load at
// startup, so those apply on restart (the UI says so honestly).

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, getApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ApiErrorBody,
  AspectOption,
  ConfigAspect,
  ConfigOptions,
  RecordingConfigPayload,
} from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, SectionLabel, cn } from '../../components/ui';

// Local key (queryKeys is shared and owned elsewhere); the recording-config
// query is Config-tab-local, so a plain stable tuple is enough.
const RECORDING_CONFIG_KEY = ['config', 'recording'] as const;

const ASPECTS: ConfigAspect[] = ['recording', 'stream', 'validation', 'validators'];
const ASPECT_LABEL: Record<ConfigAspect, string> = {
  recording: 'Recording',
  stream: 'Stream',
  validation: 'Validation',
  validators: 'Validators',
};
// Aspects whose selection applies without a service restart.
const IMMEDIATE: Record<ConfigAspect, boolean> = {
  recording: false,
  stream: true,
  validation: true,
  validators: false,
};

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

/** Editable JSON editor for the active robot's active RECORDING_CONFIG. */
function RecordingConfigEditor({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();

  const recordingQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) => apiGet<RecordingConfigPayload>('/config/recording', { signal }),
  });

  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the buffer from the fetched config (pretty-printed). Re-seed when the
  // fetched payload identity changes (e.g. after a robot/recording switch).
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

  if (recordingQuery.isError) return <ErrorMessage error={recordingQuery.error} />;
  if (recordingQuery.isPending) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div>
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
      <label className="mb-1 block text-sm font-medium text-gray-700">Config (JSON)</label>
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

      {parseError && <p className="mt-2 text-sm text-red-700">JSON error: {parseError}</p>}

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
            default_topics / robot_name apply immediately; expected_hz and QoS apply after a
            service restart.
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
          Edits the active recording file; the server validates on save.
        </span>
      </div>
    </div>
  );
}

/** A human label for an aspect option, using its display metadata. */
function optionLabel(aspect: ConfigAspect, o: AspectOption): string {
  const m = o.meta;
  if (aspect === 'recording') return `${o.id} · ${m.default_topics ?? 0} topics`;
  if (aspect === 'stream') return `${o.id} · ${m.columns ?? '?'} col / ${m.panes ?? 0} panes`;
  if (aspect === 'validation')
    return `${m.name ?? o.id} (v${m.version ?? 1}) · ${m.required_topics?.length ?? 0} topics`;
  return o.id;
}

/** Read-only summary of the active option for the non-editable aspects. */
function AspectSummary({ aspect, option }: { aspect: ConfigAspect; option: AspectOption }) {
  if (aspect === 'stream') {
    return (
      <p className="text-sm text-gray-600">
        {option.meta.columns ?? '?'} columns · {option.meta.panes ?? 0} preview panes
      </p>
    );
  }
  if (aspect === 'validation') {
    const topics = option.meta.required_topics ?? [];
    return (
      <div>
        <h3 className="mb-1.5 text-sm font-medium text-gray-700">
          Required topics ({topics.length})
        </h3>
        <ul className="max-h-72 overflow-auto rounded-control border border-gray-200 text-xs">
          {topics.map((t) => (
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
    );
  }
  return <p className="font-mono text-xs text-gray-500">{option.path}</p>;
}

/** One aspect panel: an option selector + the aspect's editor / summary. */
function AspectSection({
  aspect,
  state,
  onSelect,
  selecting,
  config,
}: {
  aspect: ConfigAspect;
  state: { active: string; options: AspectOption[] };
  onSelect: (id: string) => void;
  selecting: boolean;
  config: RuntimeConfig;
}) {
  const active = state.options.find((o) => o.id === state.active);
  return (
    <section
      aria-label={`${aspect} config`}
      className="rounded-card border border-gray-200 bg-white p-[18px] shadow-card"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
          {ASPECT_LABEL[aspect]}
        </h2>
        <Badge tone={IMMEDIATE[aspect] ? 'green' : 'gray'} dot>
          {IMMEDIATE[aspect] ? 'applies immediately' : 'applies on restart'}
        </Badge>
        <div className="flex-1" />
        {state.options.length === 0 ? (
          <span className="text-sm text-gray-400">No options for this robot.</span>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium">Option</span>
            <select
              aria-label={`${aspect} option`}
              className="rounded-control border border-gray-200 px-2 py-1 font-mono focus:border-teal-500 focus:outline-none"
              value={state.active}
              disabled={selecting}
              onChange={(e) => onSelect(e.target.value)}
            >
              {state.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {optionLabel(aspect, o)}
                  {o.local ? ' · local' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {aspect === 'recording' ? (
        <RecordingConfigEditor config={config} />
      ) : active ? (
        <AspectSummary aspect={aspect} option={active} />
      ) : (
        <p className="text-sm text-gray-500">Nothing to show.</p>
      )}
    </section>
  );
}

export function ConfigTab({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const [aspect, setAspect] = useState<ConfigAspect>('recording');

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });

  const selectMutation = useMutation({
    mutationFn: (vars: { category: string; id: string }) =>
      apiPost<ConfigOptions>('/config/select', vars),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.configOptions, data);
      // A robot / recording / stream switch changes the live config (defaults +
      // stream panes) and re-points the editable recording file — refresh both.
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
    },
  });

  const data = optionsQuery.data;

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="robot selector"
        className="rounded-card border border-gray-200 bg-white p-[18px] shadow-card"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <SectionLabel>Robot</SectionLabel>
          {optionsQuery.isError ? (
            <ErrorMessage error={optionsQuery.error} />
          ) : !data ? (
            <span className="text-sm text-gray-500">Loading…</span>
          ) : (
            data.robots.map((r) => {
              const on = r.id === data.active_robot;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-label={`robot ${r.id}`}
                  aria-pressed={on}
                  disabled={selectMutation.isPending}
                  onClick={() => selectMutation.mutate({ category: 'robot', id: r.id })}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-sm transition-colors disabled:opacity-50',
                    on
                      ? 'border-teal-300 bg-teal-50 font-semibold text-teal-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {r.id}
                  {r.local && (
                    <span className="rounded-chip bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700">
                      local
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </section>

      <nav role="tablist" aria-label="config aspects" className="flex flex-wrap gap-[3px]">
        {ASPECTS.map((a) => {
          const on = a === aspect;
          return (
            <button
              key={a}
              role="tab"
              aria-selected={on}
              onClick={() => setAspect(a)}
              className={cn(
                'rounded-control px-4 py-2 text-[13.5px] transition-colors',
                on
                  ? 'bg-teal-600 font-semibold text-white shadow-sm'
                  : 'font-medium text-gray-500 hover:text-gray-700',
              )}
            >
              {ASPECT_LABEL[a]}
            </button>
          );
        })}
      </nav>

      {selectMutation.isError && <ErrorMessage error={selectMutation.error} />}

      {data && (
        <AspectSection
          aspect={aspect}
          state={data.aspects[aspect]}
          onSelect={(id) => selectMutation.mutate({ category: aspect, id })}
          selecting={selectMutation.isPending}
          config={config}
        />
      )}
    </div>
  );
}
