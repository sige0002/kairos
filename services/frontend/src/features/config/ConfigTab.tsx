// Recording-config editing pieces shared by v2 Settings (the v1 Config tab
// that used to live here was removed once Settings reached parity). Exports:
// RecordingConfigEditor — editable JSON for the ACTIVE robot's RECORDING_CONFIG
// (PUT /api/v1/config/recording; default_topics / robot_name apply immediately,
// recorder QoS + monitor expected_hz load at startup so they apply on restart —
// the UI says so honestly); optionLabel — human label for an aspect option;
// RECORDING_CONFIG_KEY — the recording-config query key.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, getApiBase } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ApiErrorBody,
  AspectOption,
  ConfigAspect,
  RecordingConfigPayload,
} from '../../api/types';
import { useRecordStatus } from '../../v2/captures/useRecordStatus';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';

// Local key (queryKeys is shared and owned elsewhere); the recording-config
// query is Config-tab-local, so a plain stable tuple is enough.
export const RECORDING_CONFIG_KEY = ['config', 'recording'] as const;

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
export function RecordingConfigEditor({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();

  const recordingQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) => apiGet<RecordingConfigPayload>('/config/recording', { signal }),
  });

  // Three different things, three different sentences. `recording` is bytes
  // actually being written; `armed` is a prepared session holding
  // subscriptions that has written NOTHING, so calling it "recording in
  // progress" claims data that does not exist; and an unconfirmed live set
  // (unreachable recorder, or an answer without the array) is not evidence
  // that nothing is running.
  const recordStatus = useRecordStatus();
  const recording = recordStatus.recording;
  const armed = recordStatus.armed;
  const liveUnknown = recordStatus.live === null;

  const [text, setText] = useState('');
  // Inline JSON validity (debounced ~300ms below): null = valid, else the parse
  // message. Disables Save while the buffer isn't valid JSON, before the server
  // ever sees it.
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the buffer from the fetched config (pretty-printed). Re-seed when the
  // fetched payload identity changes (e.g. after a robot/recording switch).
  useEffect(() => {
    if (recordingQuery.data) {
      const cfg = recordingQuery.data.config ?? {};
      setText(JSON.stringify(cfg, null, 2));
      setJsonError(null);
    }
  }, [recordingQuery.data]);

  // Debounced client-side JSON validation on every edit — surfaces a parse error
  // (and disables Save) before the operator ever clicks Save.
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
      setJsonError(e instanceof Error ? e.message : 'JSON parse error');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonError('config must be an object ({ … })');
      return;
    }
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
          setSaved(false);
        }}
      />

      {jsonError ? (
        <p className="mt-2 text-sm text-red-700">Invalid JSON — {jsonError}</p>
      ) : (
        <p className="mt-2 text-xs text-gray-400">Valid JSON</p>
      )}

      {recording && (
        <div className="mt-2 rounded-control border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          A recording is in progress — saving recording config won&apos;t change the
          current one; it applies to the next.
        </div>
      )}

      {armed && (
        <div
          data-testid="config-armed-note"
          className="mt-2 rounded-control border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800"
        >
          A session is armed and waiting to start — nothing is being written yet.
          It already holds the current topic selection, so a save applies to the
          recording after it.
        </div>
      )}

      {liveUnknown && (
        <div
          data-testid="config-live-unknown"
          className="mt-2 rounded-control border border-gray-200 bg-gray-50 p-2 text-sm text-gray-600">
          The recorder has not confirmed what is running, so whether a session is
          in progress is unknown. A save still only applies to the next recording.
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
          disabled={saveMutation.isPending || jsonError !== null}
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
export function optionLabel(aspect: ConfigAspect, o: AspectOption): string {
  const m = o.meta;
  if (aspect === 'recording') return `${o.id} · ${m.default_topics ?? 0} topics`;
  if (aspect === 'stream') return `${o.id} · ${m.columns ?? '?'} col / ${m.panes ?? 0} panes`;
  if (aspect === 'validation')
    return `${m.name ?? o.id} (v${m.version ?? 1}) · ${m.required_topics?.length ?? 0} topics`;
  return o.id;
}
