// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Stream-config editor for v2 Settings > Robots — the ACTIVE robot's ACTIVE
// stream option edited in place as JSON, mirroring RecordingConfigEditor
// (GET/PUT /api/v1/config/stream). The file is UI-facing only and served
// per-request by GET /api/v1/config, so a save genuinely applies immediately —
// no restart caveat to state. Honesty note: only `panes` drives the current
// console (Collect seeds its camera panes from it); `columns` is part of the
// file format but no v2 layout reads it, and the UI must not claim otherwise.
//
// The query key is scoped by robot (the alerts editor's lesson: the robot can
// be switched from Settings OR Collect's context bar, and only a robot-named
// key survives that without serving the previous robot's file from cache).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPut } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';

/** GET/PUT /api/v1/config/stream. `config` is null when the file is absent or
 *  failed to load — `error` separates the two (null = absent, a save creates
 *  the file; a message = present but BROKEN, a save replaces it). `path` is
 *  null only when the robot has no config dir at all. */
export interface StreamConfigPayload {
  config: Record<string, unknown> | null;
  path: string | null;
  error: string | null;
}

/** Robot-scoped query key — see the header comment for why not a global one. */
export function streamConfigKey(robot: string): readonly [string, string, string] {
  return ['config', 'stream', robot] as const;
}

/** Prefix key for invalidation after an aspect select re-points the file. */
export const STREAM_CONFIG_PREFIX = ['config', 'stream'] as const;

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

/** Editable JSON editor for the active robot's active STREAM_CONFIG. */
export function StreamConfigEditor({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const robot = config.defaults.robot_name ?? '';

  const streamQuery = useQuery({
    queryKey: streamConfigKey(robot),
    queryFn: ({ signal }) => apiGet<StreamConfigPayload>('/config/stream', { signal }),
  });

  const [text, setText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Same unsaved-edits discipline as RecordingConfigEditor: the buffer is
  // seeded from the fetched payload, and a NEWER server payload is adopted
  // only into a clean buffer — otherwise withheld and surfaced.
  const [seededText, setSeededText] = useState('');
  const seededDataRef = useRef<StreamConfigPayload | null>(null);
  const [pendingServer, setPendingServer] = useState<StreamConfigPayload | null>(null);

  const seedFrom = useCallback((data: StreamConfigPayload) => {
    seededDataRef.current = data;
    const pretty = JSON.stringify(data.config ?? {}, null, 2);
    setText(pretty);
    setSeededText(pretty);
    setJsonError(null);
  }, []);

  const dirty = text !== seededText;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    const data = streamQuery.data;
    if (!data) return;
    if (seededDataRef.current === data) return;
    if (dirtyRef.current) {
      setPendingServer(data);
      return;
    }
    seedFrom(data);
  }, [streamQuery.data, seedFrom]);

  // Debounced client-side JSON validation — disables Save before the server
  // ever sees a syntax error.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        JSON.parse(text);
        setJsonError(null);
      } catch (e) {
        setJsonError(e instanceof Error ? e.message : 'JSON parse error');
      }
    }, 300);
    return () => clearTimeout(id);
  }, [text]);

  const saveMutation = useMutation({
    mutationFn: (parsed: Record<string, unknown>) =>
      apiPut<StreamConfigPayload>('/config/stream', { config: parsed }),
    onSuccess: (data) => {
      setSaved(true);
      seedFrom(data);
      setPendingServer(null);
      queryClient.setQueryData(streamConfigKey(robot), data);
      // The Collect camera grid reads the layout from GET /api/v1/config, and
      // the aspect-picker label ("N col / M panes") from /config/options.
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: queryKeys.configOptions });
    },
  });

  const onSave = () => {
    setSaved(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'JSON parse error');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonError('config must be an object ({ … })');
      return;
    }
    saveMutation.mutate(parsed as Record<string, unknown>);
  };

  const validationDetails = formatValidationDetails(saveMutation.error);

  if (streamQuery.isError) return <ErrorMessage error={streamQuery.error} />;
  if (streamQuery.isPending) return <p className="text-sm text-gray-500">Loading…</p>;

  const path = streamQuery.data.path;
  const loadError = streamQuery.data.error;
  if (path === null) {
    // No config dir at all: nowhere to read or write, so no editor to offer.
    return (
      <p data-testid="stream-config-absent" className="text-sm text-gray-500">
        This robot has no stream config to edit — it has no config folder on the server.
        Create <span className="font-mono">config/&lt;robot&gt;/</span> first.
      </p>
    );
  }

  return (
    <div>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-gray-500">Robot</dt>
        <dd className="font-mono text-gray-800">{robot || '—'}</dd>
        <dt className="text-gray-500">Path</dt>
        <dd className="font-mono text-xs text-gray-500">{path}</dd>
      </dl>
      {loadError && (
        <div
          data-testid="stream-load-error"
          className="mb-2 rounded-control border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800"
        >
          <p className="font-medium">The file on disk exists but failed to load</p>
          <p className="mt-0.5 font-mono text-xs">{loadError}</p>
          <p className="mt-1 text-xs">
            The editor below starts from an empty config, NOT from that file — saving
            REPLACES the broken file. To keep its contents, fix the YAML on disk instead.
          </p>
        </div>
      )}
      <label className="mb-1 block text-sm font-medium text-gray-700">Config (JSON)</label>
      <textarea
        aria-label="stream config json"
        className="h-48 w-full rounded-control border border-gray-200 p-2 font-mono text-xs focus:border-teal-600 focus:outline-none"
        spellCheck={false}
        value={text}
        disabled={saveMutation.isPending}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />

      {jsonError ? (
        <p className="mt-2 text-sm text-red-700">Invalid JSON — {jsonError}</p>
      ) : (
        <p className="mt-2 text-xs text-gray-500">Valid JSON</p>
      )}

      {pendingServer && (
        <div
          data-testid="stream-server-changed"
          className="mt-2 flex flex-col gap-2 rounded-control border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800"
        >
          <p>
            <span className="font-medium">The stream config changed on the server</span> while
            you were editing — another terminal saved it, or the active option changed. Your
            unsaved edits are kept and nothing here was overwritten, but saving now writes over
            that newer file.
          </p>
          <button
            type="button"
            data-testid="stream-load-server"
            onClick={() => {
              seedFrom(pendingServer);
              setPendingServer(null);
              setSaved(false);
            }}
            className="self-start rounded-control border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
          >
            Load the server copy (discards my edits)
          </button>
        </div>
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
        <div
          data-testid="stream-saved-note"
          className="mt-2 rounded-control border border-teal-200 bg-teal-50 p-2 text-sm text-teal-800"
        >
          <p className="font-medium">Saved</p>
          <p className="mt-0.5 text-xs">
            <span className="font-mono">panes</span> applies immediately — the Collect
            camera panes re-read it. <span className="font-mono">columns</span> is stored
            in the file but not used by the current console layout.
          </p>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="stream-config-save"
          aria-label="save stream config"
          onClick={onSave}
          disabled={saveMutation.isPending || jsonError !== null}
          className="rounded-control bg-teal-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <span className="text-xs text-gray-500">
          Edits the active stream file; the server validates on save. Schema:{' '}
          <span className="font-mono">{'{ columns: 1–4, panes: [{ topic }] }'}</span> —
          only <span className="font-mono">panes</span> drives the console.
        </span>
      </div>
    </div>
  );
}
