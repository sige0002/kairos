// Settings > Data quality — what "good" and "important" mean for the active
// robot. The top card is a READ-ONLY view sourced from GET /api/v1/config/robots/
// {robot} (RobotConfig): expected-Hz reference rates + the monitor's shortfall
// status thresholds from the recording aspect, and the active validation
// template's required topics. Below it is the per-robot alert-rules EDITOR
// (AlertsCard → /config/alerts) that used to be "not exposed by the API".
// (The Review Signals defaults editor was retired with the Review waveform
// chart it configured — the integrity view has no per-field selection.)

import { useQuery } from '@tanstack/react-query';
import { getConfigOptions, getRobotConfig } from '../../api/config';
import { queryKeys } from '../../api/queryKeys';
import type { RuntimeConfig } from '../../config';
import { Card } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import { AlertsCard } from './AlertsCard';

interface RecordingContentView {
  expected_hz_patterns?: { pattern: string; hz?: number | null }[];
  monitor?: { warn_shortfall?: number; danger_shortfall?: number };
}
interface ValidationContentView {
  required_topics?: { name: string; type?: string | null }[];
}

function pct(fraction: number | undefined, fallback: number): string {
  return `${((fraction ?? fallback) * 100).toFixed(0)}%`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.04em] text-gray-500">{title}</h3>
      {children}
    </div>
  );
}

export function DataQualitySection({ config }: { config: RuntimeConfig | undefined }) {
  // Need the active robot's directory id to request its config-robots view.
  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => getConfigOptions({ signal }),
  });
  const active = optionsQuery.data?.active_robot;

  const robotQuery = useQuery({
    queryKey: queryKeys.configRobot(active ?? ''),
    queryFn: ({ signal }) =>
      getRobotConfig(active!, { signal }),
    enabled: !!active,
  });
  const robotCfg = robotQuery.data;

  const rec = (robotCfg?.aspects.recording?.content ?? null) as RecordingContentView | null;
  const val = (robotCfg?.aspects.validation?.content ?? null) as ValidationContentView | null;
  const patterns = rec?.expected_hz_patterns ?? [];
  const warn = rec?.monitor?.warn_shortfall;
  const danger = rec?.monitor?.danger_shortfall;
  const requiredTopics = val?.required_topics ?? [];

  // The robot DIRECTORY id (config/<robot>/…), not the friendly robot_name.
  const robot = robotCfg?.robot ?? active ?? config?.defaults.robot_name ?? '<robot>';

  return (
    <div className="flex min-w-0 flex-col gap-2.5 overflow-auto lg:col-span-2 lg:min-h-0" data-testid="settings-data-quality">
      <Card className="flex min-w-0 flex-col gap-5 p-[18px]">
      <div className="flex items-center gap-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Data quality
        </h2>
        <span className="font-mono text-[13px] font-semibold text-gray-900">{robot}</span>
        <span className="text-[11px] text-gray-400">read-only</span>
      </div>

      {optionsQuery.isError ? (
        <ErrorMessage error={optionsQuery.error} />
      ) : robotQuery.isError ? (
        <ErrorMessage error={robotQuery.error} />
      ) : (
        <>
          <Section title="Expected rates (monitor reference)">
            {patterns.length === 0 ? (
              <p className="text-[12.5px] text-gray-400">
                No expected-Hz patterns configured — topics without a reference rate learn a
                baseline after subscribe (status stays &quot;unknown&quot; while learning).
              </p>
            ) : (
              <div className="overflow-hidden rounded-control border border-gray-200" data-testid="dq-expected-hz">
                {patterns.map((p) => (
                  <div
                    key={p.pattern}
                    className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-[12px] last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-gray-800" title={p.pattern}>
                      {p.pattern}
                    </span>
                    <span className="font-mono text-gray-600">
                      {p.hz != null ? `${p.hz} Hz` : 'learn baseline'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Health thresholds">
            <p className="text-[12.5px] leading-relaxed text-gray-600" data-testid="dq-thresholds">
              A measured topic is flagged <strong className="text-amber-700">warning</strong> when its
              rate falls <strong>{pct(warn, 0.02)}</strong> below the expected/learned rate, and{' '}
              <strong className="text-red-700">danger</strong> at <strong>{pct(danger, 0.05)}</strong>{' '}
              below. A configured topic that goes fully silent is <strong className="text-red-700">
              danger (inactive)</strong>. These are the monitor&apos;s live status colours in the
              Monitor tab — observed shortfall, not true message loss.
            </p>
          </Section>

          <Section title={`Validation — required topics (${requiredTopics.length})`}>
            {requiredTopics.length === 0 ? (
              <p className="text-[12.5px] text-gray-400">
                The active validation template lists no required topics.
              </p>
            ) : (
              <ul className="max-h-64 overflow-auto rounded-control border border-gray-200 text-[12px]" data-testid="dq-required-topics">
                {requiredTopics.map((t) => (
                  <li
                    key={t.name}
                    className="flex justify-between gap-2 border-b border-gray-50 px-3 py-1.5 last:border-b-0"
                  >
                    <span className="font-mono text-gray-800">{t.name}</span>
                    <span className="font-mono text-gray-400">{t.type ?? 'any type'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

        </>
      )}
      </Card>

      {/* Alert rules — editable surface for config/<robot>/monitoring/alerts.yaml
          (F2''): replaces the old "not exposed by the API" note. */}
      <Card className="flex min-w-0 flex-col p-[18px]">
        <AlertsCard />
      </Card>

    </div>
  );
}
