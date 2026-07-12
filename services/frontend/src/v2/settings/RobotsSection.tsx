// Settings > Robots — profile list (middle column) + profile form (right
// column). Editing is Phase 2 (backend has no writable robot-profile model
// yet), so the form's Save/Discard/Edit-topics/Advanced actions are toasts;
// what's real is display: the currently active robot's name, ROS_DOMAIN_ID
// and recorded topics come straight from the runtime config already fetched
// by the app shell (same GET /api/v1/config as src/v2/collect/CollectScreen.tsx).

import type { ReactNode } from 'react';
import { Card, cn } from '../../components/ui';
import type { RuntimeConfig } from '../../config';
import {
  ACTIVE_ROBOT_INDEX,
  MOCK_ROBOTS,
  MOCK_TOPIC_CHIPS,
  MOCK_TOPICS_SUMMARY,
} from './data';
import type { SettingsState } from './useSettingsState';

const TOPIC_CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-chip bg-teal-100 px-2.5 py-1 font-mono text-[11.5px] font-semibold text-teal-700';

export function RobotsSection({
  settings,
  config,
}: {
  settings: SettingsState;
  config: RuntimeConfig | undefined;
}) {
  const { selectedRobotIndex, selectRobot, showToast } = settings;
  const selected = MOCK_ROBOTS[selectedRobotIndex] ?? MOCK_ROBOTS[ACTIVE_ROBOT_INDEX]!;

  // Only the "active" row (index 0) can carry live data: the backend
  // describes exactly one active robot (GET /api/v1/config), not a saved
  // fleet of profiles, so the other rows are illustrative mock only.
  const isActiveProfile = selectedRobotIndex === ACTIVE_ROBOT_INDEX;
  const liveName = isActiveProfile ? config?.defaults.robot_name : undefined;
  const liveDomain = isActiveProfile ? config?.defaults.ros_domain_id : undefined;
  const liveTopics = isActiveProfile ? config?.defaults.default_topics : undefined;

  const robotName = liveName || selected.name;
  const domainText = liveDomain !== undefined ? String(liveDomain) : '42';
  const hasLiveTopics = !!liveTopics && liveTopics.length > 0;
  const topics = hasLiveTopics ? liveTopics! : MOCK_TOPIC_CHIPS;
  const topicsSummary = hasLiveTopics
    ? `${liveTopics!.length} recorded topic${liveTopics!.length === 1 ? '' : 's'}`
    : MOCK_TOPICS_SUMMARY;

  return (
    <>
      <Card className="flex flex-col overflow-auto" data-testid="robots-list">
        <div className="border-b border-gray-100 px-4 py-[13px]">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
            Robot profiles
          </span>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          {MOCK_ROBOTS.map((r, i) => (
            <button
              key={r.name}
              type="button"
              data-testid={`robot-row-${i}`}
              onClick={() => selectRobot(i)}
              className={cn(
                'flex flex-col gap-0.5 rounded-[11px] border px-[13px] py-[11px] text-left',
                i === selectedRobotIndex ? 'border-teal-200 bg-teal-50' : 'border-gray-100',
              )}
            >
              <span className="font-mono text-[13px] font-semibold text-gray-900">
                {i === ACTIVE_ROBOT_INDEX && liveName ? liveName : r.name}
              </span>
              <span className="text-[11.5px] text-gray-400">{r.meta}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => showToast('New robot profile wizard')}
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
            {robotName}
          </span>
          <span
            className={cn(
              'rounded-chip px-2 py-0.5 text-[11px] font-bold',
              selected.tone === 'green' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600',
            )}
          >
            {selected.chip}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => showToast('Diff: expected_hz right camera 30 → 28')}
            className="text-[12.5px] font-semibold text-teal-700 hover:text-teal-800"
          >
            View diff →
          </button>
          <button
            type="button"
            onClick={() => showToast('Advanced JSON editor (guarded)')}
            className="text-[12.5px] font-semibold text-gray-500 hover:text-gray-700"
          >
            Advanced (JSON) →
          </button>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-3.5 p-[18px]">
          <Field label="Display name">{selected.display}</Field>
          <Field label="Description">{selected.desc}</Field>
          <Field label="ROS_DOMAIN_ID" mono>
            {domainText}
          </Field>
          <Field label="RMW implementation">
            <div className="flex items-center text-gray-700">
              rmw_cyclonedds_cpp
              <div className="flex-1" />
              <span className="text-[10px] text-gray-400">▾</span>
            </div>
          </Field>

          <div className="col-span-2 flex flex-col gap-[7px]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-700">Recorded topics</span>
              <span data-testid="robot-topics-summary" className="font-mono text-[11.5px] text-gray-400">
                {topicsSummary}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => showToast('Topic picker — required / optional per topic')}
                className="text-xs font-semibold text-teal-700 hover:text-teal-800"
              >
                Edit topics →
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="robot-topic-chips">
              {topics.map((t) => (
                <span key={t} className={TOPIC_CHIP_CLASS}>
                  {t}
                </span>
              ))}
            </div>
          </div>

          <Field label="Cameras (max 4)">
            top · left · right <span className="text-gray-400">· + add</span>
          </Field>
          <Field label="Storage path" mono small>
            /data/kairos/recordings
          </Field>

          <div className="col-span-2 flex items-center gap-2.5 rounded-[11px] border border-amber-200 bg-amber-50 px-[14px] py-[11px]">
            <span className="h-[7px] w-[7px] shrink-0 rounded-sm bg-amber-600" />
            <span className="text-[12.5px] leading-[1.45] text-amber-800">
              <strong>Applies from the next episode.</strong> Changing expected Hz thresholds
              does not affect the episode currently being recorded.
            </span>
          </div>
        </div>

        <div className="mt-auto flex items-center gap-2 border-t border-gray-100 px-[18px] py-[13px]">
          <button
            type="button"
            onClick={() => showToast('Saved as config v2.4.2 — applies from next episode')}
            className="h-10 rounded-control bg-teal-600 px-[22px] text-[13.5px] font-bold text-white shadow-btn hover:bg-teal-700"
          >
            Save as v2.4.2
          </button>
          <button
            type="button"
            onClick={() => showToast('Local changes discarded')}
            className="h-10 rounded-control border border-gray-200 bg-white px-[18px] text-[13px] font-semibold text-gray-500 hover:bg-gray-50"
          >
            Discard changes
          </button>
          <div className="flex-1" />
          <span className="self-center text-xs text-gray-400">
            last change by Robot Eng · 2026-05-16 09:15
          </span>
        </div>
      </Card>
    </>
  );
}

function Field({
  label,
  children,
  mono,
  small,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[5px]">
      <span className="text-xs font-semibold text-gray-700">{label}</span>
      <div
        className={cn(
          'rounded-[9px] border border-gray-200 bg-white px-[11px] py-2 text-gray-900',
          mono ? 'font-mono' : '',
          small ? 'text-[12.5px]' : 'text-[13px]',
        )}
      >
        {children}
      </div>
    </div>
  );
}
