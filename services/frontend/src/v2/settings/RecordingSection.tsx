// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > Recording — a form-FIRST view of the ACTIVE robot's recording
// config (GET /api/v1/config/recording), with the raw-JSON editor demoted to an
// "Advanced" disclosure (spec §12: JSON is Advanced). Everything shown is read
// from the live config object: the default record/monitor topics with their
// configured expected Hz and any per-topic QoS override, plus the compression,
// start-gate and in-recorder cache settings. Edits still go through the same
// RecordingConfigEditor (PUT /api/v1/config/recording) — this view just makes the
// common facts legible without reading JSON. Apply-timing is stated honestly.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRecordingConfig } from '../../api/config';
import type { RuntimeConfig } from '../../config';
import { Badge, Card, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { matchesTopic } from '../../features/record/topics';
import { RECORDING_CONFIG_KEY } from '../../api/queryKeys';
import { RecordingConfigEditor } from './RecordingConfigEditor';
import { useTranslation } from 'react-i18next';

/** The subset of the RecordingConfig (kairos_common) this view renders. The full
 *  object is opaque JSON; these are the fields the form surfaces. */
interface RecordingConfigView {
  robot_name?: string;
  default_topics?: string[];
  expected_hz_patterns?: { pattern: string; hz?: number | null }[];
  topic_qos_overrides?: {
    pattern: string;
    reliability?: string;
    durability?: string;
    depth?: number;
  }[];
  recording?: {
    start_paused?: boolean;
    pre_arm?: boolean;
    compression?: string;
    max_cache_size_mb?: number;
  };
  transfer?: {
    auto_pull_on_save?: boolean;
  };
}

/** First matching expected-Hz pattern for a topic (glob, first-match-wins). */
function expectedHzFor(cfg: RecordingConfigView, topic: string): number | null {
  const hit = (cfg.expected_hz_patterns ?? []).find((p) =>
    matchesTopic(p.pattern, topic),
  );
  return hit?.hz ?? null;
}

/** Whether any QoS override matches a topic (glob, first-match-wins). */
function hasQosOverride(cfg: RecordingConfigView, topic: string): boolean {
  return (cfg.topic_qos_overrides ?? []).some((o) => matchesTopic(o.pattern, topic));
}

function SummaryField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="text-xs font-semibold text-text-primary">{label}</span>
      <div className="rounded-[9px] border border-border bg-surface px-[11px] py-2 text-[13px] text-text-primary">
        {children}
      </div>
    </div>
  );
}

export function RecordingSection({ config }: { config: RuntimeConfig | undefined }) {
  const { t } = useTranslation('settings');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const recordingQuery = useQuery({
    queryKey: RECORDING_CONFIG_KEY,
    queryFn: ({ signal }) => getRecordingConfig({ signal }),
  });

  const cfg = (recordingQuery.data?.config ?? null) as RecordingConfigView | null;
  const path = recordingQuery.data?.path;
  const topics = cfg?.default_topics ?? [];
  const rec = cfg?.recording ?? {};
  const cacheMb = rec.max_cache_size_mb ?? 0;

  return (
    <Card
      className="flex min-w-0 flex-col overflow-auto lg:col-span-2"
      data-testid="settings-recording"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted">
          {t('recording.title')}
        </h2>
        <span
          data-testid="recording-robot"
          className="font-mono text-[13px] font-semibold text-text-primary"
        >
          {cfg?.robot_name ?? config?.defaults.robot_name ?? '—'}
        </span>
      </div>

      {recordingQuery.isError ? (
        <div className="p-[18px]">
          <ErrorMessage error={recordingQuery.error} />
        </div>
      ) : recordingQuery.isPending ? (
        <p className="p-[18px] text-sm text-text-muted">{t('common.loading')}</p>
      ) : !cfg ? (
        <p className="p-[18px] text-sm text-text-muted">{t('recording.absent')}</p>
      ) : (
        <div className="flex flex-col gap-4 p-[18px]">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-3">
            <SummaryField label={t('recording.compression')}>
              <span className="font-mono">{rec.compression ?? 'none'}</span>
            </SummaryField>
            <SummaryField label={t('recording.startPaused')}>
              {rec.start_paused ? (
                <Badge tone="green" dot>
                  {t('recording.startPausedArmed')}
                </Badge>
              ) : (
                <Badge tone="gray">{t('recording.startPausedOff')}</Badge>
              )}
            </SummaryField>
            {/* Console pre-arm (two-phase start): the Collect screen keeps a
                recording armed while ready, so Start is a near-instant resume.
                Edited like every other recording field, via Advanced JSON
                (recording.pre_arm) — off is the escape hatch for a robot whose
                receive-side budget can't carry recording-level load while idle. */}
            <SummaryField label={t('recording.preArm')}>
              {rec.pre_arm !== false ? (
                <Badge tone="green" dot>
                  {t('recording.preArmOn')}
                </Badge>
              ) : (
                <Badge tone="gray">{t('recording.preArmOff')}</Badge>
              )}
            </SummaryField>
            <SummaryField label={t('recording.cacheSize')}>
              <span className="font-mono">
                {cacheMb > 0 ? `${cacheMb} MiB` : t('recording.rosbagDefault')}
              </span>
            </SummaryField>
            {/* Cross-host split: pull the run's files from the robot right
                after Collect Save (importer sidecar; compose/recording.yaml).
                Default OFF — nothing transfers without an explicit opt-in.
                Edited like pre_arm, via Advanced JSON
                (transfer.auto_pull_on_save). Inert on a single-host deploy. */}
            <SummaryField label={t('recording.autoPull')}>
              {cfg.transfer?.auto_pull_on_save ? (
                <Badge tone="green" dot>
                  {t('recording.autoPullOn')}
                </Badge>
              ) : (
                <Badge tone="gray">{t('recording.autoPullOff')}</Badge>
              )}
            </SummaryField>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                {t('recording.defaultTopics')}
              </h3>
              <span
                data-testid="recording-topic-count"
                className="font-mono text-[11.5px] text-text-muted"
              >
                {t('recording.topicCount', { count: topics.length })}
              </span>
            </div>
            {topics.length === 0 ? (
              <p className="text-[12.5px] text-text-muted">{t('common.noOptions')}</p>
            ) : (
              <div
                className="overflow-hidden rounded-control border border-border"
                data-testid="recording-topics"
              >
                <div className="flex items-center gap-2 border-b border-border bg-surface-muted px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-muted">
                  <span className="flex-1">{t('alerts.columns.topic')}</span>
                  <span className="w-24 text-right">{t('recording.expectedHz')}</span>
                  <span className="w-20 text-right">{t('recording.qos')}</span>
                </div>
                {topics.map((topic) => {
                  const hz = expectedHzFor(cfg, topic);
                  const qos = hasQosOverride(cfg, topic);
                  return (
                    <div
                      key={topic}
                      data-testid={`recording-topic-${topic}`}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] last:border-b-0"
                    >
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-text-primary"
                        title={topic}
                      >
                        {topic}
                      </span>
                      <span className="w-24 text-right font-mono text-text-secondary">
                        {hz != null ? `${hz} Hz` : '—'}
                      </span>
                      <span className="w-20 text-right">
                        {qos ? (
                          <Badge tone="teal">{t('recording.custom')}</Badge>
                        ) : (
                          <span className="text-text-muted">
                            {t('recording.default')}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-[11.5px] leading-relaxed text-text-muted">
            {t('recording.applyTiming')}
          </p>

          {/* Advanced: the raw JSON editor (spec §12 — JSON is Advanced). */}
          <div className="rounded-control border border-border">
            <button
              type="button"
              data-testid="recording-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-text-primary hover:bg-surface-muted"
            >
              <span
                className={cn(
                  'text-text-muted transition-transform',
                  advancedOpen && 'rotate-90',
                )}
              >
                ▸
              </span>
              {t('recording.advanced')}
              {path && (
                <span className="font-mono text-[11px] font-normal text-text-muted">
                  {path}
                </span>
              )}
            </button>
            {advancedOpen && config && (
              <div
                className="border-t border-border p-3.5"
                data-testid="recording-advanced"
              >
                <RecordingConfigEditor config={config} />
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
