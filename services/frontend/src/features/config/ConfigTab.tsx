// Config tab: select which config each category uses (Phase 1 = validation).
// Picking a validation template applies immediately — the orchestrator injects
// the active one into template-less fast_validation jobs (no restart). Other
// categories (record / robot / stream / convert) land in later phases.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigOptions } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, SectionLabel } from '../../components/ui';

/** Read-only recording profile sourced from RECORDING_CONFIG (GET /config). */
function ProfileCard({ config }: { config: RuntimeConfig }) {
  const robot = config.defaults.robot_name;
  const topics = config.defaults.default_topics ?? [];
  return (
    <section
      aria-label="recording profile"
      className="rounded-card border border-gray-200 bg-white p-[18px] shadow-card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionLabel>収録プロファイル</SectionLabel>
        <Badge tone="gray">RECORDING_CONFIG（読み取り専用）</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-gray-500">ロボット</dt>
        <dd className="font-mono text-gray-800">{robot || '—'}</dd>
        <dt className="text-gray-500">既定トピック</dt>
        <dd className="font-mono text-gray-800">{topics.length} 件</dd>
      </dl>
      {topics.length > 0 && (
        <ul className="mt-3 max-h-44 overflow-auto rounded-control border border-gray-200 text-xs">
          {topics.map((t) => (
            <li
              key={t}
              className="border-t border-gray-100 px-2 py-1.5 font-mono text-gray-700 first:border-t-0"
            >
              {t}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-gray-400">
        記録/監視トピックの編集はファイル（RECORDING_CONFIG）側で行います。UI からの
        per-topic トグルは未提供です。
      </p>
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
      <ProfileCard config={config} />
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
