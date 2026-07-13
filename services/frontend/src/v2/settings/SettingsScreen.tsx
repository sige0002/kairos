// Settings tab (v2 IA) — absorbs the old Config tab plus robot profiles and
// batch plans (project/task/condition). Root mirrors the design mock's
// 216px / 250px / 1fr three-column grid (settings menu, a list panel whose
// contents depend on the selected menu item, and its detail).
//
// Robots is wired to the real backend — robot select + per-aspect option
// pickers + the recording-config editor, at parity with the legacy Config tab
// (see RobotsSection.tsx). Plans is a Phase-2 frontend mock; the other 6 menu
// items render a placeholder (the mock's own scope, see
// .dev/kairos-console-v2.dc.html "Settings" section).

import { useQuery } from '@tanstack/react-query';
import { fetchRuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import { SETTINGS_MENU } from './data';
import { MenuRail } from './MenuRail';
import { RobotsSection } from './RobotsSection';
import { PlansSection } from './PlansSection';
import { OtherSection } from './OtherSection';
import { SettingsToast } from './Toast';
import { useSettingsState } from './useSettingsState';

export function SettingsScreen() {
  // Same cache key CollectScreen reads (see src/v2/collect/CollectScreen.tsx)
  // — the app shell fetches this before any tab renders. `config` is used
  // best-effort only: every field read from it here is optional, so a
  // backend outage degrades this screen to its mock profile rather than
  // blanking it.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });

  const settings = useSettingsState();

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_250px_1fr]">
      <MenuRail settings={settings} />
      {settings.menuIdx === 0 && <RobotsSection settings={settings} config={config} />}
      {settings.menuIdx === 1 && <PlansSection settings={settings} />}
      {settings.menuIdx > 1 && (
        <OtherSection label={SETTINGS_MENU[settings.menuIdx] ?? 'Settings'} />
      )}
      <SettingsToast message={settings.toast} />
    </div>
  );
}
