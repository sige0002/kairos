// Record tab: a config-driven topic picker + live record status.
//
// Topics to record are no longer typed by hand. The picker merges the backend
// RECORDING_CONFIG's `default_topics` (GET /api/v1/config -> defaults) with live
// ROS 2 graph discovery (GET /api/v1/topics): configured topics are pre-checked,
// any other live topic can be added, and "Record all topics" sends `"all"`.
// Status is kept fresh by polling and by SSE `record_status` events writing the
// same query key. Double-start is disabled while recording/stopping.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  RecordStartRequest,
  RecordStartResponse,
  RecordStatus,
  TopicInfo,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import type { RuntimeConfig } from '../../config';
import { buildCandidates } from './topics';

const ACTIVE_STATES = new Set(['created', 'recording', 'stopping']);

// Infra topics that are never useful to record; hidden from the picker.
const INFRA_TOPICS = new Set(['/rosout', '/parameter_events']);

function asTopicList(data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }) {
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

export function RecordTab({ config }: { config: RuntimeConfig }) {
  const queryClient = useQueryClient();
  const defaultTopics = config.defaults.default_topics ?? [];
  const robotName = config.defaults.robot_name;

  const statusQuery = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  const status = statusQuery.data;
  const isActive = status ? ACTIVE_STATES.has(status.state) : false;

  // Live ROS 2 graph discovery so the operator sees what is actually flowing.
  const topicsQuery = useQuery({
    queryKey: queryKeys.topics,
    queryFn: ({ signal }) =>
      apiGet<TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] }>('/topics', {
        signal,
      }),
    refetchInterval: 5000,
  });

  const liveTopics = useMemo(
    () =>
      asTopicList(topicsQuery.data ?? [])
        .filter((t) => !INFRA_TOPICS.has(t.name))
        .map((t) => ({ name: t.name, type: t.type })),
    [topicsQuery.data],
  );

  const { candidates, unmatchedPatterns } = useMemo(
    () => buildCandidates(defaultTopics, liveTopics),
    [defaultTopics, liveTopics],
  );

  const [recordAll, setRecordAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Show selected topics first (then configured, then alphabetical) so the
  // chosen set is visible at the top of a long list.
  const orderedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      const sa = selected.has(a.name);
      const sb = selected.has(b.name);
      if (sa !== sb) return sa ? -1 : 1;
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [candidates, selected]);
  // Seed the selection from configured topics once candidates first appear; do
  // not clobber the operator's edits afterwards.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || candidates.length === 0) return;
    setSelected(new Set(candidates.filter((c) => c.configured).map((c) => c.name)));
    seeded.current = true;
  }, [candidates]);

  const [compression, setCompression] = useState<'none' | 'zstd'>('none');
  const [operator, setOperator] = useState('');
  const [task, setTask] = useState('');

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

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectedCount = selected.size;
  const canStart =
    !isActive && !busy && (recordAll || selectedCount > 0);

  function start() {
    const body: RecordStartRequest = {
      topics: recordAll ? 'all' : [...selected],
      compression,
    };
    // Optional session metadata — only sent when filled in.
    if (operator.trim()) body.operator = operator.trim();
    if (task.trim()) body.task = task.trim();
    startMutation.mutate(body);
  }

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
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Start recording</h2>
          {robotName && (
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              config: {robotName}
            </span>
          )}
        </div>
        {startMutation.isError && <ErrorMessage error={startMutation.error} />}
        {stopMutation.isError && <ErrorMessage error={stopMutation.error} />}

        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Operator (データ取得者)</span>
            <input
              type="text"
              aria-label="operator"
              value={operator}
              disabled={isActive || busy}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="e.g. yuki"
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Task (タスク名)</span>
            <input
              type="text"
              aria-label="task"
              value={task}
              disabled={isActive || busy}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. pick-and-place"
              className="rounded border px-2 py-1"
            />
          </label>
        </div>

        <label className="mb-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="all topics"
            checked={recordAll}
            disabled={isActive || busy}
            onChange={(e) => setRecordAll(e.target.checked)}
          />
          Record all topics on the graph
        </label>

        {!recordAll && (
          <fieldset
            aria-label="topics"
            disabled={isActive || busy}
            className="mb-3 rounded border"
          >
            <div className="flex items-center justify-between border-b bg-gray-50 px-3 py-1.5 text-xs text-gray-600">
              <span>
                {selectedCount} selected · {candidates.length} available
                {topicsQuery.isError ? ' · discovery offline' : ''}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="underline disabled:opacity-40"
                  onClick={() =>
                  setSelected(new Set(candidates.map((c) => c.name)))
                }
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="underline disabled:opacity-40"
                  onClick={() => setSelected(new Set())}
                >
                  Select none
                </button>
              </span>
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {candidates.length === 0 ? (
                <li className="px-3 py-3 text-sm text-gray-500">
                  {topicsQuery.isPending
                    ? 'Discovering topics…'
                    : 'No topics on the graph yet. Start the robot or replay a bag.'}
                </li>
              ) : (
                orderedCandidates.map((c) => (
                  <li key={c.name} className="border-t first:border-t-0">
                    <label className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <input
                        type="checkbox"
                        aria-label={c.name}
                        checked={selected.has(c.name)}
                        onChange={() => toggle(c.name)}
                      />
                      <span className="font-mono">{c.name}</span>
                      {c.configured && (
                        <span className="rounded bg-blue-100 px-1.5 text-xs text-blue-800">
                          configured
                        </span>
                      )}
                      {!c.live && (
                        <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">
                          offline
                        </span>
                      )}
                      {c.type && (
                        <span className="ml-auto truncate text-xs text-gray-400">
                          {c.type}
                        </span>
                      )}
                    </label>
                  </li>
                ))
              )}
            </ul>
          </fieldset>
        )}

        {!recordAll && unmatchedPatterns.length > 0 && (
          <p className="mb-3 text-xs text-amber-700">
            Configured but not flowing yet:{' '}
            <span className="font-mono">{unmatchedPatterns.join(', ')}</span>
          </p>
        )}

        <label className="mb-3 flex items-center gap-2 text-sm">
          Compression
          <select
            value={compression}
            disabled={isActive || busy}
            onChange={(e) => setCompression(e.target.value as 'none' | 'zstd')}
            className="rounded border px-2 py-1"
          >
            <option value="none">none</option>
            <option value="zstd">zstd</option>
          </select>
        </label>

        <button
          type="button"
          onClick={start}
          disabled={!canStart}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {startMutation.isPending ? 'Starting…' : 'Start recording'}
        </button>

        {isActive && (
          <p className="mt-2 text-sm text-amber-700">
            A recording session is active; stop it before starting another.
          </p>
        )}
      </section>
    </div>
  );
}
