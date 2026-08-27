// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Validation — CONFIGURE validation, don't run it. Two things:
//   - pick the active robot's validation template + validators option (the same
//     POST /api/v1/config/select aspect pattern the Robots section uses), and
//   - list the one-click presets (GET /api/v1/validation/presets) with their live
//     "N pending" counts, read-only.
// Execution stays in the Validation TAB (one function, one place) — this view
// links there rather than duplicating the run UI.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { getConfigOptions, selectConfig } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import type { ConfigAspect, ValidationPreset } from '../../api/types';
import { Badge, Card } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { RECORDING_CONFIG_KEY } from '../../api/queryKeys';
import { optionLabel } from './RecordingConfigEditor';
import { useUiStore } from '../../store/uiStore';

interface PresetListResponse {
  items: ValidationPreset[];
}

// Both aspects load at service startup (validators) / inject into template-less
// jobs (validation), so neither is a live hot-swap; label honestly.
const ASPECTS: { id: ConfigAspect; label: string; immediate: boolean }[] = [
  { id: 'validation', label: 'Validation template', immediate: true },
  { id: 'validators', label: 'Validators', immediate: false },
];

export function ValidationSection() {
  const queryClient = useQueryClient();
  const setActiveTab = useUiStore((s) => s.setActiveTab);

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const presetsQuery = useQuery({
    queryKey: queryKeys.validationPresets,
    queryFn: ({ signal }) => apiGet<PresetListResponse>('/validation/presets', { signal }),
  });

  const selectMutation = useMutation({
    mutationFn: (vars: { category: string; id: string }) =>
      selectConfig(vars),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.configOptions, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
      queryClient.invalidateQueries({ queryKey: queryKeys.validationPresets });
    },
  });

  const data = optionsQuery.data;
  const presets = presetsQuery.data?.items ?? [];

  return (
    <Card className="flex min-w-0 flex-col gap-5 overflow-auto p-[18px] lg:col-span-2" data-testid="settings-validation">
      <div className="flex items-center gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          Validation
        </h2>
        {data && (
          <span className="font-mono text-[13px] font-semibold text-text-primary">{data.active_robot}</span>
        )}
      </div>

      {/* Aspect selection */}
      <div className="flex flex-col gap-2.5" data-testid="validation-aspects">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          Active options
        </h3>
        {optionsQuery.isError ? (
          <ErrorMessage error={optionsQuery.error} />
        ) : !data ? (
          <p className="text-sm text-text-muted">Loading options…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ASPECTS.map(({ id, label, immediate }) => {
              const state = data.aspects[id];
              const options = state?.options ?? [];
              return (
                <label key={id} className="flex flex-col gap-1.5 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">{label}</span>
                    <Badge tone={immediate ? 'green' : 'gray'} dot>
                      {immediate ? 'applies immediately' : 'applies on restart'}
                    </Badge>
                  </span>
                  {options.length === 0 ? (
                    <span className="text-[12.5px] text-text-muted">No options for this robot.</span>
                  ) : (
                    <select
                      aria-label={`${id} option`}
                      className="rounded-control border border-border px-2 py-1.5 font-mono text-[12.5px] focus:border-accent focus:outline-none disabled:opacity-50"
                      value={state.active}
                      disabled={selectMutation.isPending}
                      onChange={(e) => selectMutation.mutate({ category: id, id: e.target.value })}
                    >
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {optionLabel(id, o)}
                          {o.local ? ' · local' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {selectMutation.isError && <ErrorMessage error={selectMutation.error} />}
      </div>

      {/* One-click presets (read-only) */}
      <div className="flex flex-col gap-2.5">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
          One-click presets
        </h3>
        {presetsQuery.isError ? (
          <ErrorMessage error={presetsQuery.error} />
        ) : presetsQuery.isPending ? (
          <p className="text-sm text-text-muted">Loading presets…</p>
        ) : presets.length === 0 ? (
          <p className="text-[12.5px] text-text-muted" data-testid="validation-presets-empty">
            No presets configured — add them to <code>config/&lt;robot&gt;/validation_presets.yaml</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="validation-presets">
            {presets.map((p) => (
              <div
                key={p.id}
                data-testid={`preset-${p.id}`}
                className="flex items-center gap-3 rounded-control border border-border px-3.5 py-2.5"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-semibold text-text-primary">{p.name}</span>
                  {p.description && (
                    <span className="truncate text-[11.5px] text-text-muted" title={p.description}>
                      {p.description}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-text-muted">pipeline: {p.pipeline}</span>
                </div>
                <div className="flex-1" />
                {p.pending > 0 ? (
                  <Badge tone="amber">{p.pending} pending</Badge>
                ) : (
                  <Badge tone="green" dot>
                    up to date
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-control border border-border bg-surface-muted px-3.5 py-2.5">
        <span className="text-[12px] text-text-muted">
          Run pipelines and see results in the Validation tab.
        </span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="validation-goto-tab"
          onClick={() => setActiveTab('validation')}
          className="rounded-control bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-text-inverse hover:bg-accent-strong"
        >
          Open Validation tab →
        </button>
      </div>
    </Card>
  );
}
