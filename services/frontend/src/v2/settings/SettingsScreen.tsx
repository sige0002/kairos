// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings tab (v2 IA) — absorbs the old Config tab plus robot profiles and
// batch plans. Root mirrors the design mock's 216px / 250px / 1fr three-column
// grid (settings menu, then either a list+detail pair or a single wide section).
//
// All spec §12 sections are built on real data:
//   Robots            — robot select + per-aspect options + recording editor
//   Projects & tasks  — the shared plans catalog editor (also drives Collect)
//   Failure reasons   — the "What failed?" vocabulary editor (also drives Collect)
//   External controls — the channel→action mapping editor (also drives Collect)
//   Operators         — the attribution roster (fills the OP picker; not auth)
//   Recording         — form-first active-robot recording config (JSON = Advanced)
//   Data quality      — read-only expected rates + thresholds + required topics
//   Validation        — aspect selection + one-click presets (run in the Val tab)
//   System            — deployment facts + honest component health
// Only Dataset profiles and Users & permissions stay honest placeholders — there
// is genuinely nothing to configure for them yet (see OtherSection rationale).

import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import { SETTINGS_MENU } from './data';
import { MenuRail } from './MenuRail';
import { RobotsSection } from './RobotsSection';
import { PlansSection } from './PlansSection';
import { FailureReasonsSection } from './FailureReasonsSection';
import { ExternalControlsSection } from './ExternalControlsSection';
import { OperatorsSection } from './OperatorsSection';
import { RecordingSection } from './RecordingSection';
import { DataQualitySection } from './DataQualitySection';
import { ValidationSection } from './ValidationSection';
import { SystemSection } from './SystemSection';
import { OtherSection } from './OtherSection';
import { Toast } from '../shared/Toast';
import { useSettingsState } from './useSettingsState';
import { adoptServerCatalog, usePlansConflict, usePlansUnsynced } from '../plans';
import { ScreenTitle } from '../shared/ScreenTitle';

// Honest rationale for the two sections with nothing to configure yet.
const PLACEHOLDER_RATIONALE: Record<string, string> = {
  'Dataset profiles':
    'Dataset profiles arrive with the Phase 3 recipe model (build datasets from a reviewed query). There is nothing to configure yet.',
  'Users & permissions':
    'This deployment is single-team on a trusted LAN with no accounts, so there is nothing to manage yet. Authentication is on the roadmap for beyond-LAN deployments.',
};

export function SettingsScreen() {
  // Same cache key CollectScreen reads (see src/v2/collect/CollectScreen.tsx)
  // — the app shell fetches this before any tab renders. `config` is used
  // best-effort only: every field read from it here is optional.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });

  const settings = useSettingsState();
  const label = SETTINGS_MENU[settings.menuIdx] ?? 'Settings';

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_250px_1fr]">
      <ScreenTitle>Settings</ScreenTitle>
      <MenuRail settings={settings} />
      {label === 'Robots' ? (
        <RobotsSection config={config} />
      ) : label === 'Projects & tasks' ? (
        <PlansSection settings={settings} />
      ) : label === 'Failure reasons' ? (
        <FailureReasonsSection settings={settings} />
      ) : label === 'External controls' ? (
        <ExternalControlsSection />
      ) : label === 'Operators' ? (
        <OperatorsSection settings={settings} />
      ) : label === 'Recording' ? (
        <RecordingSection config={config} />
      ) : label === 'Data quality' ? (
        <DataQualitySection config={config} />
      ) : label === 'Validation' ? (
        <ValidationSection />
      ) : label === 'System' ? (
        <SystemSection config={config} />
      ) : (
        <OtherSection label={label} rationale={PLACEHOLDER_RATIONALE[label] ?? ''} />
      )}
      <UnsyncedCatalogNote />
      <CatalogConflictNote />
      <Toast message={settings.toast} testId="settings-toast" />
    </div>
  );
}

/** A conflict has a different recovery from an unavailable server: retrying
 * stale data would erase a colleague's edit, so only an explicit server adopt
 * is offered here. The local draft remains until that button succeeds. */
function CatalogConflictNote() {
  const conflicted = usePlansConflict();
  if (!conflicted) return null;
  return (
    <div
      data-testid="plans-conflict"
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-control border border-rose-300 bg-rose-50 px-3.5 py-2 text-[12px] text-rose-800 shadow-card"
    >
      The shared catalog changed elsewhere. Your local draft was kept and was not
      retried.
      <button
        type="button"
        data-testid="plans-use-server"
        onClick={adoptServerCatalog}
        className="rounded border border-rose-300 bg-white px-2 py-1 font-semibold hover:bg-rose-100"
      >
        Use server catalog
      </button>
    </div>
  );
}

/** The shared catalog (projects, failure reasons, operators, external controls)
 *  is pushed to the
 *  server best-effort, and the editors report an edit the moment it applies
 *  locally. When that push fails the local copy is still correct FOR THIS
 *  BROWSER — but every other terminal reads the server's copy, so saying
 *  nothing let "Project added" stand for a change nobody else would ever see. */
function UnsyncedCatalogNote() {
  const unsynced = usePlansUnsynced();
  if (!unsynced) return null;
  return (
    <div
      data-testid="plans-unsynced"
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-control border border-amber-300 bg-amber-50 px-3.5 py-2 text-[12px] text-amber-800 shadow-card"
    >
      Saved on this browser only — the shared catalog could not be reached, so other
      terminals still show the previous one. It is retried on the next edit or reload.
    </div>
  );
}
