// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Robots — real robot selection + per-robot config (superseded the
// retired v1 Config tab; the recording-config editor it embeds still lives in
// src/features/config/ConfigTab.tsx). The middle column lists the real robots
// from GET /api/v1/config/options (the active one is marked); selecting a row
// previews it, and an explicit "Use this robot" action POSTs
// /api/v1/config/select {category:'robot'} to switch the live system.
//
// The ACTIVE robot shows its editable recording config + per-aspect option
// pickers. A NON-active robot is shown read-only from GET /api/v1/config/robots/
// {robot} (its config as a template) behind an explicit read-only banner — you
// can read it without switching the live system, and activate it to edit. Both
// robot activation and recording-config saves are recording-aware (they read the
// same /record/status query Collect uses): switching robots while a capture runs
// is confirmed first (it stops the recording), and the recording-config editor
// says a save applies to the next recording, not the current one.

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfigOptions, getRobotConfig, selectConfig } from '../../api/config';
import { stopRecord } from '../../api/record';
import { confirmRecorderStopped } from '../captures/stopConfirm';
import { queryKeys } from '../../api/queryKeys';
import type { AspectOption, ConfigAspect, ConfigOptions } from '../../api/types';
import { useRecordStatus } from '../captures/useRecordStatus';
import type { RuntimeConfig } from '../../config';
import { Badge, Button, Card, Modal, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { RECORDING_CONFIG_KEY } from '../../api/queryKeys';
import { optionLabel, RecordingConfigEditor } from './RecordingConfigEditor';
import { STREAM_CONFIG_PREFIX, StreamConfigEditor } from './StreamConfigEditor';
import { SetupCheckPanel } from './SetupCheckPanel';
import { useTranslation } from 'react-i18next';

const TOPIC_CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-chip bg-interaction-selected px-2.5 py-1 font-mono text-[11.5px] font-semibold text-accent';

const ASPECTS: ConfigAspect[] = ['recording', 'stream', 'validation', 'validators'];
// Aspects whose selection applies without a service restart.
const IMMEDIATE: Record<ConfigAspect, boolean> = {
  recording: false,
  stream: true,
  validation: true,
  validators: false,
};

export function RobotsSection({ config }: { config: RuntimeConfig | undefined }) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  // Local "which row is being viewed" — distinct from the ACTIVE robot. Null
  // until a row is clicked, so the active robot is previewed by default.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // "+ Add robot" opens a persistent explainer (not a toast) in this column.
  const [addingRobot, setAddingRobot] = useState(false);
  // Robot activation is confirmed first when a recording is running.
  const [confirmActivate, setConfirmActivate] = useState(false);
  // Shown after a robot switch in THIS session: the ROS services keep their
  // startup configs until restarted, and pretending the switch was total is
  // exactly how a mixed-config recording gets made without anyone knowing.
  const [switchedRobot, setSwitchedRobot] = useState(false);

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });

  // Switching robots stops whatever is running, so this guard errs towards
  // asking. `anyLive` covers `armed` too — a prepared session the switch would
  // silently throw away — and `live === null` is the "we cannot tell" case,
  // which the hook reports for BOTH a recorder that answered without its live
  // set and one that is not answering at all. Only an explicit empty list
  // switches straight through.
  const recordStatus = useRecordStatus();
  const captureLive = recordStatus.anyLive;
  const liveUnknown = recordStatus.live === null;

  const selectMutation = useMutation({
    mutationFn: (vars: { category: string; id: string }) => selectConfig(vars),
    onSuccess: (data, vars) => {
      // Adopt the fresh options and refresh the runtime config + the editable
      // recording config that a robot / aspect switch re-points.
      queryClient.setQueryData(queryKeys.configOptions, data);
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfig });
      queryClient.invalidateQueries({ queryKey: RECORDING_CONFIG_KEY });
      // A robot or stream-option switch re-points the stream file too.
      queryClient.invalidateQueries({ queryKey: STREAM_CONFIG_PREFIX });
      if (vars.category === 'robot') setSwitchedRobot(true);
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const capture = await stopRecord();
      // A 200 from /record/stop is not proof the recorder stopped (it answers
      // with the last capture when nothing is active). Confirm through the
      // same polling loop Collect's SAVING gate uses — switching configs while
      // the recorder is still flushing would hot-swap the recording's config
      // out from under it mid-write.
      await confirmRecorderStopped(capture?.capture_id ?? null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
  });

  const data = optionsQuery.data;
  const activeId = data?.active_robot;
  const selectedRobotId = selectedId ?? activeId ?? null;
  const selectedRobot = data?.robots.find((r) => r.id === selectedRobotId);
  const isActive = !!selectedRobotId && selectedRobotId === activeId;

  const selectRow = (id: string) => {
    setSelectedId(id);
    setAddingRobot(false);
  };

  const activate = () => {
    if (!selectedRobotId || isActive) return;
    if (captureLive || liveUnknown) {
      setConfirmActivate(true);
      return;
    }
    selectMutation.mutate({ category: 'robot', id: selectedRobotId });
  };

  const stopAndSwitch = async () => {
    if (!selectedRobotId) return;
    try {
      await stopMutation.mutateAsync();
    } catch {
      return; // Keep the modal open; the error surfaces via stopMutation.isError.
    }
    selectMutation.mutate({ category: 'robot', id: selectedRobotId });
    setConfirmActivate(false);
  };

  const switching = selectMutation.isPending || stopMutation.isPending;

  return (
    <>
      <Card className="flex flex-col overflow-auto" data-testid="robots-list">
        <div className="border-b border-border px-4 py-[13px]">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
            {t('robots.title')}
          </h2>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {optionsQuery.isError ? (
            <ErrorMessage error={optionsQuery.error} />
          ) : !data ? (
            <span className="px-1 py-2 text-[12.5px] text-text-muted">
              {t('common.loading')}
            </span>
          ) : (
            data.robots.map((r, i) => {
              const on = !addingRobot && r.id === selectedRobotId;
              const active = r.id === activeId;
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid={`robot-row-${i}`}
                  data-robot-id={r.id}
                  aria-pressed={on}
                  onClick={() => selectRow(r.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-[11px] border px-[13px] py-[11px] text-left',
                    on
                      ? 'border-accent bg-interaction-selected'
                      : 'border-border hover:bg-surface-muted',
                  )}
                >
                  <span className="font-mono text-[13px] font-semibold text-text-primary">
                    {r.id}
                  </span>
                  <div className="flex-1" />
                  {active && (
                    <Badge tone="green" dot>
                      {t('robots.active')}
                    </Badge>
                  )}
                  {r.local && <Badge tone="amber">{t('robots.local')}</Badge>}
                </button>
              );
            })
          )}
          <button
            type="button"
            data-testid="add-robot"
            onClick={() => setAddingRobot(true)}
            className={cn(
              'rounded-control border border-dashed p-2.5 text-[12.5px] font-semibold text-accent hover:bg-interaction-selected',
              addingRobot
                ? 'border-accent bg-interaction-selected'
                : 'border-border-strong bg-surface',
            )}
          >
            {t('robots.add')}
          </button>
        </div>
      </Card>

      <Card className="flex min-w-0 flex-col overflow-auto" data-testid="robot-form">
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-[13px]">
          {addingRobot ? (
            <h2 className="text-[15px] font-bold text-text-primary">
              {t('robots.addTitle')}
            </h2>
          ) : (
            <>
              <h2
                data-testid="robot-form-name"
                className="font-mono text-[15px] font-bold text-text-primary"
              >
                {selectedRobotId ?? '—'}
              </h2>
              {isActive ? (
                <Badge tone="green" dot>
                  {t('robots.active')}
                </Badge>
              ) : (
                selectedRobot?.local && <Badge tone="amber">{t('robots.local')}</Badge>
              )}
              <div className="flex-1" />
              <button
                type="button"
                data-testid="activate-robot"
                disabled={!selectedRobotId || isActive || switching}
                onClick={activate}
                className={cn(
                  'h-9 rounded-control px-[18px] text-[13px] font-bold transition-colors',
                  isActive
                    ? 'cursor-default bg-surface-muted text-text-muted'
                    : 'bg-accent text-text-inverse shadow-btn hover:bg-accent-strong disabled:opacity-50',
                )}
              >
                {isActive
                  ? t('robots.active')
                  : switching
                    ? t('robots.activating')
                    : t('robots.useThis')}
              </button>
            </>
          )}
        </div>

        {selectMutation.isError && (
          <div className="px-[18px] pt-3">
            <ErrorMessage error={selectMutation.error} />
          </div>
        )}

        {addingRobot ? (
          <AddRobotExplainer />
        ) : !selectedRobotId ? (
          <div className="p-[18px] text-sm text-text-muted">{t('robots.select')}</div>
        ) : isActive ? (
          <div className="flex flex-col gap-4 p-[18px]">
            {switchedRobot && (
              <div
                data-testid="robot-switch-note"
                className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[13px] text-status-warning-text"
              >
                {t('robots.restartNote')}{' '}
                <span className="font-mono">{t('robotsRestartCommand')}</span>
              </div>
            )}
            <ActiveRobotDetail config={config} />
            <SetupCheckPanel />
            <AspectPickers
              data={data!}
              selecting={switching}
              onSelect={(category, id) => selectMutation.mutate({ category, id })}
            />
            <div>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                {t('robots.recordingConfig')}
              </h3>
              {config ? (
                <RecordingConfigEditor config={config} />
              ) : (
                <p className="text-sm text-text-muted">{t('common.loading')}</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                {t('robots.streamConfig')}
              </h3>
              {config ? (
                <StreamConfigEditor config={config} />
              ) : (
                <p className="text-sm text-text-muted">{t('common.loading')}</p>
              )}
            </div>
          </div>
        ) : (
          <ReadOnlyRobotDetail robot={selectedRobotId} />
        )}
      </Card>

      <Modal
        open={confirmActivate}
        onClose={() => setConfirmActivate(false)}
        title={t('robots.switchTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmActivate(false)}
              disabled={switching}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={stopAndSwitch} disabled={switching}>
              {stopMutation.isPending
                ? t('robots.stopping')
                : switching
                  ? t('robots.switching')
                  : t('robots.switchStop')}
            </Button>
          </>
        }
      >
        {captureLive ? t('robots.liveWarning') : t('robots.unknownLiveWarning')}
        {stopMutation.isError && (
          <div className="mt-2">
            <ErrorMessage error={stopMutation.error} />
          </div>
        )}
      </Modal>
    </>
  );
}

/** Persistent explainer for "+ Add robot" (no in-console create API yet). */
function AddRobotExplainer() {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-3 p-[18px]" data-testid="robot-add-explainer">
      <p className="text-sm leading-relaxed text-text-secondary">
        {t('robots.addDescription')}
      </p>
    </div>
  );
}

/** The active robot's real, read-only runtime values (GET /api/v1/config). */
function ActiveRobotDetail({ config }: { config: RuntimeConfig | undefined }) {
  const { t } = useTranslation('settings');
  const domain = config?.defaults.ros_domain_id;
  const topics = config?.defaults.default_topics ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-5 gap-y-3.5">
        <Field label={t('system.rosDomain')} mono>
          {domain !== undefined ? String(domain) : '—'}
        </Field>
        <Field label={t('robots.configSource')}>
          <span className="text-text-muted">
            GET /api/v1/config · {t('common.readOnly')}
          </span>
        </Field>
      </div>
      <TopicChips
        topics={topics}
        summaryTestId="robot-topics-summary"
        chipsTestId="robot-topic-chips"
      />
    </div>
  );
}

/** A non-active robot's config, read-only, from GET /api/v1/config/robots/{robot}. */
function ReadOnlyRobotDetail({ robot }: { robot: string }) {
  const { t } = useTranslation('settings');
  const query = useQuery({
    queryKey: queryKeys.configRobot(robot),
    queryFn: ({ signal }) => getRobotConfig(robot, { signal }),
  });

  return (
    <div className="flex flex-col gap-4 p-[18px]">
      <div
        data-testid="robot-readonly-banner"
        className="rounded-control border border-status-warning-border bg-status-warning-bg px-3 py-2 text-[13px] text-status-warning-text"
      >
        {t('robots.readOnlyConfig', { robot })}
      </div>

      {query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending ? (
        <p className="text-sm text-text-muted">
          {t('robots.loadingConfig', { robot })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3.5">
            <Field label={t('system.rosDomain')} mono>
              {query.data.summary.ros_domain_id != null
                ? String(query.data.summary.ros_domain_id)
                : '—'}
            </Field>
            <Field label={t('robots.configSource')}>
              <span className="text-text-muted">
                GET /api/v1/config/robots · {t('common.readOnly')}
              </span>
            </Field>
          </div>
          <TopicChips
            topics={query.data.summary.default_topics}
            summaryTestId="robot-readonly-topics-summary"
            chipsTestId="robot-readonly-topic-chips"
          />
          <div>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              {t('robots.recordingConfig')}
            </h3>
            <textarea
              aria-label={t('robots.recordingReadOnlyAria')}
              data-testid="robot-readonly-config"
              readOnly
              disabled
              spellCheck={false}
              value={JSON.stringify(
                query.data.aspects.recording?.content ?? {},
                null,
                2,
              )}
              className="h-80 w-full rounded-control border border-border bg-surface-muted p-2 font-mono text-xs text-text-secondary"
            />
            <p className="mt-1.5 text-xs text-text-muted">
              {t('robots.templateConfig', { robot, aspect: t('recording.title') })}
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
              {t('robots.streamConfig')}
            </h3>
            {query.data.aspects.stream ? (
              <textarea
                aria-label={t('robots.streamReadOnlyAria')}
                data-testid="robot-readonly-stream-config"
                readOnly
                disabled
                spellCheck={false}
                value={JSON.stringify(query.data.aspects.stream.content ?? {}, null, 2)}
                className="h-40 w-full rounded-control border border-border bg-surface-muted p-2 font-mono text-xs text-text-secondary"
              />
            ) : (
              <p className="text-sm text-text-muted">
                {t('robots.noStreamConfig', { robot })}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Recorded-topics summary + chips (shared by active + read-only details). */
function TopicChips({
  topics,
  summaryTestId,
  chipsTestId,
}: {
  topics: string[];
  summaryTestId: string;
  chipsTestId: string;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-[7px]">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-text-primary">
          {t('robots.recordedTopics')}
        </span>
        <span
          data-testid={summaryTestId}
          className="font-mono text-[11.5px] text-text-muted"
        >
          {topics.length
            ? t('robots.recordedTopicCount', { count: topics.length })
            : t('robots.noTopicsConfigured')}
        </span>
      </div>
      {topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={chipsTestId}>
          {topics.map((t) => (
            <span key={t} className={TOPIC_CHIP_CLASS}>
              {t}
            </span>
          ))}
        </div>
      )}
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
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-2.5" data-testid="aspect-pickers">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
        {t('robots.configOptions')}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ASPECTS.map((aspect) => {
          const state = data.aspects[aspect];
          const options = state?.options ?? [];
          return (
            <label key={aspect} className="flex flex-col gap-1.5 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">
                  {t(`robots.aspects.${aspect}`)}
                </span>
                <Badge tone={IMMEDIATE[aspect] ? 'green' : 'gray'} dot>
                  {IMMEDIATE[aspect]
                    ? t('common.applyImmediately')
                    : t('common.applyOnRestart')}
                </Badge>
              </span>
              {options.length === 0 ? (
                <span className="text-[12.5px] text-text-muted">
                  {t('common.noOptions')}
                </span>
              ) : (
                <select
                  aria-label={t('robots.aspectOption', {
                    aspect: t(`robots.aspects.${aspect}`),
                  })}
                  className="rounded-control border border-border px-2 py-1.5 font-mono text-[12.5px] focus:border-accent focus:outline-none disabled:opacity-50"
                  value={state.active}
                  disabled={selecting}
                  onChange={(e) => onSelect(aspect, e.target.value)}
                >
                  {options.map((o: AspectOption) => (
                    <option key={o.id} value={o.id}>
                      {optionLabel(aspect, o)}
                      {o.local ? ` · ${t('common.local')}` : ''}
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
      <span className="text-xs font-semibold text-text-primary">{label}</span>
      <div
        className={cn(
          'rounded-[9px] border border-border bg-surface px-[11px] py-2 text-[13px] text-text-primary',
          mono ? 'font-mono' : '',
        )}
      >
        {children}
      </div>
    </div>
  );
}
