// Settings > Robots — real robot selection + per-robot config, at parity with
// the legacy Config tab (src/features/config/ConfigTab.tsx). The middle column
// lists the real robots from GET /api/v1/config/options (the active one is
// marked); selecting a row previews it, and an explicit "Use this robot" action
// POSTs /api/v1/config/select {category:'robot'} to switch the live system —
// the same mutation + cache invalidation as ConfigTab's robot buttons. The
// right column shows the active robot's real read-only runtime values
// (ROS_DOMAIN_ID, recorded topics), real per-aspect option pickers, and the
// embedded recording-config editor (GET/PUT /api/v1/config/recording) — both
// reused from ConfigTab, not reimplemented.
//
// The backend describes exactly one ACTIVE robot: the aspect options and the
// editable recording config it returns are the active robot's. So a non-active
// row can only be activated; its config loads once it is the active robot (we
// say so honestly rather than showing the active robot's values under another
// robot's name). "Add robot" stays a toast — robots are config/<robot>/ folders
// on disk and there is no create API yet.

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AspectOption, ConfigAspect, ConfigOptions } from '../../api/types';
import type { RuntimeConfig } from '../../config';
import { Badge, Card, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  optionLabel,
  RECORDING_CONFIG_KEY,
  RecordingConfigEditor,
} from '../../features/config/ConfigTab';
import type { SettingsState } from './useSettingsState';

const TOPIC_CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-chip bg-teal-100 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-teal-700';

const ASPECTS: ConfigAspect[] = ['recording', 'stream', 'validation', 'validators'];
const ASPECT_LABEL: Record<ConfigAspect, string> = {
  recording: 'Recording',
  stream: 'Stream',
  validation: 'Validation',
  validators: 'Validators',
};
// Aspects whose selection applies without a service restart (mirrors ConfigTab).
const IMMEDIATE: Record<ConfigAspect, boolean> = {
  recording: false,
  stream: true,
  validation: true,
  validators: false,
};

export function RobotsSection({
  settings,
  config,
}: {
  settings: SettingsState;
  config: RuntimeConfig | undefined;
}) {
  const { showToast } = settings;
  const queryClient = useQueryClient();
  // Local "which row is being viewed" — distinct from the ACTIVE robot. Null
  // until a row is clicked, so the active robot is previewed by default.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });

  const selectMutation = useMutation({
    mutationFn: (vars: { category: string; id: string }) =>
      apiPost<ConfigOptions>('/config/select', vars),
    onSuccess: (data) => {
      // Same cache surgery as ConfigTab.selectMutation: adopt the fresh options
      // and refresh the runtime config + the editable recording config that a
      // robot / aspect switch re-points.
      queryClient.setQueryData(queryKeys.configOptions, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
    },
  });

  const data = optionsQuery.data;
  const activeId = data?.active_robot;
  const selectedRobotId = selectedId ?? activeId ?? null;
  const selectedRobot = data?.robots.find((r) => r.id === selectedRobotId);
  const isActive = !!selectedRobotId && selectedRobotId === activeId;

  return (
    <>
      <Card className="flex flex-col overflow-auto" data-testid="robots-list">
        <div className="border-b border-gray-100 px-4 py-[13px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Robots
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {optionsQuery.isError ? (
            <ErrorMessage error={optionsQuery.error} />
          ) : !data ? (
            <span className="px-1 py-2 text-[12.5px] text-gray-400">Loading robots…</span>
          ) : (
            data.robots.map((r, i) => {
              const on = r.id === selectedRobotId;
              const active = r.id === activeId;
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid={`robot-row-${i}`}
                  data-robot-id={r.id}
                  aria-pressed={on}
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-[11px] border px-[13px] py-[11px] text-left',
                    on ? 'border-teal-200 bg-teal-50' : 'border-gray-100 hover:bg-gray-50',
                  )}
                >
                  <span className="font-mono text-[13px] font-semibold text-gray-900">{r.id}</span>
                  <div className="flex-1" />
                  {active && (
                    <Badge tone="green" dot>
                      active
                    </Badge>
                  )}
                  {r.local && <Badge tone="amber">local</Badge>}
                </button>
              );
            })
          )}
          <button
            type="button"
            onClick={() =>
              showToast('Robots are config/<robot>/ folders on disk — no create API yet.')
            }
            className="rounded-control border border-dashed border-gray-300 bg-white p-2.5 text-[12.5px] font-semibold text-teal-700 hover:bg-teal-50"
          >
            + Add robot
          </button>
        </div>
      </Card>

      <Card className="flex min-w-0 flex-col overflow-auto" data-testid="robot-form">
        <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
          <span
            data-testid="robot-form-name"
            className="font-mono text-[15px] font-bold text-gray-900"
          >
            {selectedRobotId ?? '—'}
          </span>
          {isActive ? (
            <Badge tone="green" dot>
              active
            </Badge>
          ) : (
            selectedRobot?.local && <Badge tone="amber">local</Badge>
          )}
          <div className="flex-1" />
          <button
            type="button"
            data-testid="activate-robot"
            disabled={!selectedRobotId || isActive || selectMutation.isPending}
            onClick={() =>
              selectedRobotId && selectMutation.mutate({ category: 'robot', id: selectedRobotId })
            }
            className={cn(
              'h-9 rounded-control px-[18px] text-[13px] font-bold transition-colors',
              isActive
                ? 'cursor-default bg-gray-100 text-gray-400'
                : 'bg-teal-600 text-white shadow-btn hover:bg-teal-700 disabled:opacity-50',
            )}
          >
            {isActive ? 'Active' : selectMutation.isPending ? 'Activating…' : 'Use this robot'}
          </button>
        </div>

        {selectMutation.isError && (
          <div className="px-[18px] pt-3">
            <ErrorMessage error={selectMutation.error} />
          </div>
        )}

        {!selectedRobotId ? (
          <div className="p-[18px] text-sm text-gray-500">Select a robot.</div>
        ) : !isActive ? (
          <div className="flex flex-col gap-2 p-[18px]" data-testid="robot-inactive-note">
            <p className="text-sm text-gray-600">
              <strong className="font-semibold text-gray-800">{selectedRobotId}</strong> is not the
              active robot. Its recording, stream and validation config load once it is active — the
              backend exposes config for the active robot only.
            </p>
            <p className="text-[12.5px] text-amber-700">
              Activating switches the live system (recorder / monitor / stream) to this robot.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-[18px]">
            <ActiveRobotDetail config={config} />
            <AspectPickers
              data={data!}
              selecting={selectMutation.isPending}
              onSelect={(category, id) => selectMutation.mutate({ category, id })}
            />
            <div>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                Recording config
              </h3>
              {config ? (
                <RecordingConfigEditor config={config} />
              ) : (
                <p className="text-sm text-gray-500">
                  Recording config is unavailable — the runtime config could not be loaded.
                </p>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

/** The active robot's real, read-only runtime values (GET /api/v1/config). */
function ActiveRobotDetail({ config }: { config: RuntimeConfig | undefined }) {
  const domain = config?.defaults.ros_domain_id;
  const topics = config?.defaults.default_topics ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-5 gap-y-3.5">
        <Field label="ROS_DOMAIN_ID" mono>
          {domain !== undefined ? String(domain) : '—'}
        </Field>
        <Field label="Config source">
          <span className="text-gray-500">GET /api/v1/config · read-only</span>
        </Field>
      </div>
      <div className="flex flex-col gap-[7px]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-700">Recorded topics</span>
          <span
            data-testid="robot-topics-summary"
            className="font-mono text-[11.5px] text-gray-400"
          >
            {topics.length
              ? `${topics.length} recorded topic${topics.length === 1 ? '' : 's'}`
              : 'none configured'}
          </span>
        </div>
        {topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="robot-topic-chips">
            {topics.map((t) => (
              <span key={t} className={TOPIC_CHIP_CLASS}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-aspect option selectors for the active robot (POST /config/select). */
function AspectPickers({
  data,
  selecting,
  onSelect,
}: {
  data: ConfigOptions;
  selecting: boolean;
  onSelect: (category: ConfigAspect, id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5" data-testid="aspect-pickers">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
        Config options
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ASPECTS.map((aspect) => {
          const state = data.aspects[aspect];
          const options = state?.options ?? [];
          return (
            <label key={aspect} className="flex flex-col gap-1.5 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-700">{ASPECT_LABEL[aspect]}</span>
                <Badge tone={IMMEDIATE[aspect] ? 'green' : 'gray'} dot>
                  {IMMEDIATE[aspect] ? 'applies immediately' : 'applies on restart'}
                </Badge>
              </span>
              {options.length === 0 ? (
                <span className="text-[12.5px] text-gray-400">No options for this robot.</span>
              ) : (
                <select
                  aria-label={`${aspect} option`}
                  className="rounded-control border border-gray-200 px-2 py-1.5 font-mono text-[12.5px] focus:border-teal-500 focus:outline-none disabled:opacity-50"
                  value={state.active}
                  disabled={selecting}
                  onChange={(e) => onSelect(aspect, e.target.value)}
                >
                  {options.map((o: AspectOption) => (
                    <option key={o.id} value={o.id}>
                      {optionLabel(aspect, o)}
                      {o.local ? ' · local' : ''}
                    </option>
                  ))}
                </select>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="text-xs font-semibold text-gray-700">{label}</span>
      <div
        className={cn(
          'rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-[13px] text-gray-900',
          mono ? 'font-mono' : '',
        )}
      >
        {children}
      </div>
    </div>
  );
}
