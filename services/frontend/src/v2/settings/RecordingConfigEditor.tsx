// Recording-config editing pieces for v2 Settings (moved here from the v1-era
// features/config/ConfigTab.tsx once nothing v1 was left in it). Exports:
// RecordingConfigEditor — editable JSON for the ACTIVE robot's RECORDING_CONFIG
// (PUT /api/v1/config/recording; default_topics / robot_name apply immediately,
// recorder QoS + monitor expected_hz load at startup so they apply on restart —
// the UI says so honestly); optionLabel — human label for an aspect option.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, getApiBase } from '../../api/client';
import { getRecordingConfig } from '../../api/config';
import { RECORDING_CONFIG_KEY, queryKeys } from '../../api/queryKeys';
import type {
  ApiErrorBody,
  AspectOption,
  ConfigAspect,
  RecordingConfigPayload,
} from '../../api/types';
import { useRecordStatus } from '../captures/useRecordStatus';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';

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
    queryFn: ({ signal }) => getRecordingConfig({ signal }),
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
  // What the buffer was last seeded from — the text to measure "unsaved edits"
  // against, and the payload identity to detect that the FILE moved. (Structural
  // sharing keeps the object identity of a deep-equal refetch, so an unchanged
  // file looks exactly like no refetch at all — which is why identity is the
  // right test here.)
  const [seededText, setSeededText] = useState('');
  const seededDataRef = useRef<RecordingConfigPayload | null>(null);
  // A newer server payload withheld because the operator has unsaved edits.
  const [pendingServer, setPendingServer] = useState<RecordingConfigPayload | null>(null);

  const seedFrom = useCallback((data: RecordingConfigPayload) => {
    seededDataRef.current = data;
    const pretty = JSON.stringify(data.config ?? {}, null, 2);
    setText(pretty);
    setSeededText(pretty);
    setJsonError(null);
  }, []);

  const dirty = text !== seededText;
  // Read by the seeding effect, which must NOT re-run just because dirtiness
  // flipped — typing one character would otherwise look like a server change.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Seed the buffer from the fetched config (pretty-printed), and re-seed when
  // the fetched payload identity changes (a robot/recording switch, or a
  // reconnect: `event: resync` makes the client refetch EVERY query — see
  // sse/useEventStream.ts). Re-seeding unconditionally there silently threw
  // away whatever the operator had typed, so a newer file is adopted only into
  // a CLEAN buffer; otherwise it is withheld and surfaced.
  useEffect(() => {
    const data = recordingQuery.data;
    if (!data) return;
    if (seededDataRef.current === data) return;
    if (dirtyRef.current) {
      setPendingServer(data);
      return;
    }
    seedFrom(data);
  }, [recordingQuery.data, seedFrom]);

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
      // Re-seed from what the server actually wrote, so the buffer and its
      // baseline both become the saved file (and the effect above sees the same
      // payload identity it just seeded from, and stays out of the way).
      seedFrom(data);
      setPendingServer(null);
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

      {pendingServer && (
        <div
          data-testid="recording-server-changed"
          className="mt-2 flex flex-col gap-2 rounded-control border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800"
        >
          <p>
            <span className="font-medium">The recording config changed on the server</span> while
            you were editing — another terminal saved it, or the active robot changed. Your unsaved
            edits are kept and nothing here was overwritten, but saving now writes over that newer
            file.
          </p>
          <button
            type="button"
            data-testid="recording-load-server"
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
