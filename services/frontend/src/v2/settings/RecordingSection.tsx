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

/** The subset of the RecordingConfig (kairos_common) this view renders. The full
 *  object is opaque JSON; these are the fields the form surfaces. */
interface RecordingConfigView {
  robot_name?: string;
  default_topics?: string[];
  expected_hz_patterns?: { pattern: string; hz?: number | null }[];
  topic_qos_overrides?: { pattern: string; reliability?: string; durability?: string; depth?: number }[];
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
  const hit = (cfg.expected_hz_patterns ?? []).find((p) => matchesTopic(p.pattern, topic));
  return hit?.hz ?? null;
}

/** Whether any QoS override matches a topic (glob, first-match-wins). */
function hasQosOverride(cfg: RecordingConfigView, topic: string): boolean {
  return (cfg.topic_qos_overrides ?? []).some((o) => matchesTopic(o.pattern, topic));
}

function SummaryField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="text-xs font-semibold text-gray-700">{label}</span>
      <div className="rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-[13px] text-gray-900">
        {children}
      </div>
    </div>
  );
}

export function RecordingSection({ config }: { config: RuntimeConfig | undefined }) {
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
    <Card className="flex min-w-0 flex-col overflow-auto lg:col-span-2" data-testid="settings-recording">
      <div className="flex items-center gap-2.5 border-b border-gray-100 px-[18px] py-[13px]">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Recording
        </h2>
        <span data-testid="recording-robot" className="font-mono text-[13px] font-semibold text-gray-900">
          {cfg?.robot_name ?? config?.defaults.robot_name ?? '—'}
        </span>
      </div>

      {recordingQuery.isError ? (
        <div className="p-[18px]">
          <ErrorMessage error={recordingQuery.error} />
        </div>
      ) : recordingQuery.isPending ? (
        <p className="p-[18px] text-sm text-gray-500">Loading recording config…</p>
      ) : !cfg ? (
        <p className="p-[18px] text-sm text-gray-500">
          No recording config is loaded for the active robot.
        </p>
      ) : (
        <div className="flex flex-col gap-4 p-[18px]">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-3">
            <SummaryField label="Compression">
              <span className="font-mono">{rec.compression ?? 'none'}</span>
            </SummaryField>
            <SummaryField label="Start gate">
              {rec.start_paused ? (
                <Badge tone="green" dot>
                  start-paused armed
                </Badge>
              ) : (
                <Badge tone="gray">off (record immediately)</Badge>
              )}
            </SummaryField>
            {/* Console pre-arm (two-phase start): the Collect screen keeps a
                recording armed while ready, so Start is a near-instant resume.
                Edited like every other recording field, via Advanced JSON
                (recording.pre_arm) — off is the escape hatch for a robot whose
                receive-side budget can't carry recording-level load while idle. */}
            <SummaryField label="Pre-arm (instant start)">
              {rec.pre_arm !== false ? (
                <Badge tone="green" dot>
                  on — armed while Collect is ready
                </Badge>
              ) : (
                <Badge tone="gray">off (arm on Start)</Badge>
              )}
            </SummaryField>
            <SummaryField label="In-recorder cache">
              <span className="font-mono">
                {cacheMb > 0 ? `${cacheMb} MiB` : 'rosbag2 default'}
              </span>
            </SummaryField>
            {/* Cross-host split: pull the run's files from the robot right
                after Collect Save (importer sidecar; compose/recording.yaml).
                Default OFF — nothing transfers without an explicit opt-in.
                Edited like pre_arm, via Advanced JSON
                (transfer.auto_pull_on_save). Inert on a single-host deploy. */}
            <SummaryField label="Auto-pull on Save (split)">
              {cfg.transfer?.auto_pull_on_save ? (
                <Badge tone="green" dot>
                  on — pull from robot after Save
                </Badge>
              ) : (
                <Badge tone="gray">off (manual import-runs)</Badge>
              )}
            </SummaryField>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                Default topics
              </h3>
              <span data-testid="recording-topic-count" className="font-mono text-[11.5px] text-gray-500">
                {topics.length} topic{topics.length === 1 ? '' : 's'}
              </span>
            </div>
            {topics.length === 0 ? (
              <p className="text-[12.5px] text-gray-500">No default topics configured.</p>
            ) : (
              <div className="overflow-hidden rounded-control border border-gray-200" data-testid="recording-topics">
                <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                  <span className="flex-1">Topic</span>
                  <span className="w-24 text-right">Expected Hz</span>
                  <span className="w-20 text-right">QoS</span>
                </div>
                {topics.map((t) => {
                  const hz = expectedHzFor(cfg, t);
                  const qos = hasQosOverride(cfg, t);
                  return (
                    <div
                      key={t}
                      data-testid={`recording-topic-${t}`}
                      className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-[12px] last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-gray-800" title={t}>
                        {t}
                      </span>
                      <span className="w-24 text-right font-mono text-gray-600">
                        {hz != null ? `${hz} Hz` : '—'}
                      </span>
                      <span className="w-20 text-right">
                        {qos ? <Badge tone="teal">custom</Badge> : <span className="text-gray-500">default</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <p className="text-[11.5px] leading-relaxed text-gray-500">
            <code>default_topics</code> / <code>robot_name</code> apply immediately; expected Hz,
            QoS and the start gate load at service startup, so they apply on the next recorder
            restart.
          </p>

          {/* Advanced: the raw JSON editor (spec §12 — JSON is Advanced). */}
          <div className="rounded-control border border-gray-200">
            <button
              type="button"
              data-testid="recording-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"
            >
              <span className={cn('text-gray-500 transition-transform', advancedOpen && 'rotate-90')}>
                ▸
              </span>
              Advanced — edit raw JSON
              {path && <span className="font-mono text-[11px] font-normal text-gray-500">{path}</span>}
            </button>
            {advancedOpen && config && (
              <div className="border-t border-gray-100 p-3.5" data-testid="recording-advanced">
                <RecordingConfigEditor config={config} />
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
