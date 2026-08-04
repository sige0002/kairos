// Settings tab (v2 IA) — absorbs the old Config tab plus robot profiles and
// batch plans. Root mirrors the design mock's 216px / 250px / 1fr three-column
// grid (settings menu, then either a list+detail pair or a single wide section).
//
// All spec §12 sections are built on real data:
//   Robots            — robot select + per-aspect options + recording editor
//   Projects & tasks  — the shared plans catalog editor (also drives Collect)
//   Failure reasons   — the "What failed?" vocabulary editor (also drives Collect)
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
import { OperatorsSection } from './OperatorsSection';
import { RecordingSection } from './RecordingSection';
import { DataQualitySection } from './DataQualitySection';
import { ValidationSection } from './ValidationSection';
import { SystemSection } from './SystemSection';
import { OtherSection } from './OtherSection';
import { SettingsToast } from './Toast';
import { useSettingsState } from './useSettingsState';

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
      <MenuRail settings={settings} />
      {label === 'Robots' ? (
        <RobotsSection config={config} />
      ) : label === 'Projects & tasks' ? (
        <PlansSection settings={settings} />
      ) : label === 'Failure reasons' ? (
        <FailureReasonsSection settings={settings} />
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
      <SettingsToast message={settings.toast} />
    </div>
  );
}
