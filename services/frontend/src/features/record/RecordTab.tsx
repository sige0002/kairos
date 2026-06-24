// Record tab: build the start form from config.schemas.record_start (or a
// sensible default), POST start/stop, and show live record status. Status is
// kept fresh both by polling and by SSE `record_status` events writing the
// same query key. Double-start is disabled while recording/stopping.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  RecordStartRequest,
  RecordStartResponse,
  RecordStatus,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { SchemaForm } from '../../components/SchemaForm';
import type { JSONSchema } from '../../schema/jsonSchema';
import type { RuntimeConfig } from '../../config';

// Default form schema used only when the backend omits schemas.record_start.
// Mirrors docs/specs/ja/config.md's record_start example.
const DEFAULT_RECORD_SCHEMA: JSONSchema = {
  type: 'object',
  required: ['topics'],
  properties: {
    topics: {
      title: 'Topics',
      oneOf: [{ type: 'array', items: { type: 'string' } }, { const: 'all' }],
    },
    compression: { title: 'Compression', enum: ['none', 'zstd'], default: 'none' },
    split: {
      title: 'Split',
      type: ['object', 'null'],
      properties: {
        max_size_mb: { title: 'Max size (MB)', type: ['integer', 'null'] },
        max_duration_s: { title: 'Max duration (s)', type: ['integer', 'null'] },
      },
    },
  },
};

const ACTIVE_STATES = new Set(['created', 'recording', 'stopping']);

export function RecordTab({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const schema = config.schemas.record_start ?? DEFAULT_RECORD_SCHEMA;

  const statusQuery = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });

  const status = statusQuery.data;
  const isActive = status ? ACTIVE_STATES.has(status.state) : false;

  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) =>
      apiPost<RecordStartResponse>('/record/start', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => apiPost<RecordStatus>('/record/stop', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
  });

  const busy = startMutation.isPending || stopMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="record status" className="rounded border p-3">
        <h2 className="mb-2 font-semibold">Status</h2>
        {statusQuery.isError ? (
          <ErrorMessage error={statusQuery.error} />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-gray-500">State</dt>
            <dd data-testid="record-state">{status?.state ?? 'idle'}</dd>
            <dt className="text-gray-500">Run</dt>
            <dd>{status?.run_id ?? '—'}</dd>
            <dt className="text-gray-500">Messages</dt>
            <dd>{status?.message_count ?? 0}</dd>
            <dt className="text-gray-500">Bytes</dt>
            <dd>{status?.bytes ?? 0}</dd>
          </dl>
        )}
        {isActive && (
          <button
            type="button"
            onClick={() => stopMutation.mutate()}
            disabled={busy}
            className="mt-3 rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {stopMutation.isPending ? 'Stopping…' : 'Stop recording'}
          </button>
        )}
      </section>

      <section aria-label="start recording" className="rounded border p-3">
        <h2 className="mb-2 font-semibold">Start recording</h2>
        {startMutation.isError && <ErrorMessage error={startMutation.error} />}
        {stopMutation.isError && <ErrorMessage error={stopMutation.error} />}
        <SchemaForm
          schema={schema}
          onSubmit={(value) => startMutation.mutate(value as RecordStartRequest)}
          submitLabel={startMutation.isPending ? 'Starting…' : 'Start recording'}
          // Disable starting while a session is active (no double-start) or busy.
          disabled={isActive || busy}
        />
        {isActive && (
          <p className="mt-2 text-sm text-amber-700">
            A recording session is active; stop it before starting another.
          </p>
        )}
      </section>
    </div>
  );
}
