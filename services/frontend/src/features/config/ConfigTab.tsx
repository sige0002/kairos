// Config tab: select which config each category uses (Phase 1 = validation).
// Picking a validation template applies immediately — the orchestrator injects
// the active one into template-less fast_validation jobs (no restart). Other
// categories (record / robot / stream / convert) land in later phases.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigOptions } from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';

export function ConfigTab() {
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
      <section aria-label="validation config" className="rounded border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Validation</h2>
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
            applies immediately
          </span>
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
                className="rounded border px-2 py-1 font-mono"
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
                <h3 className="mb-1 text-sm font-medium">
                  Required topics ({activeOption.required_topics.length})
                </h3>
                <ul className="max-h-72 overflow-auto rounded border text-xs">
                  {activeOption.required_topics.map((t) => (
                    <li
                      key={t.name}
                      className="flex justify-between gap-2 border-t px-2 py-1 first:border-t-0"
                    >
                      <span className="font-mono">{t.name}</span>
                      <span className="text-gray-500">{t.type ?? 'any type'}</span>
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
