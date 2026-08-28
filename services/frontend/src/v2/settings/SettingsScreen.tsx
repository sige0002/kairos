// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings tab (v2 IA) — a stable category rail with durable section IDs.
//
// All spec §12 sections are built on real data:
//   Robots            — robot select + per-aspect options + recording editor
//   Projects & tasks  — the shared plans catalog editor (also drives Collect)
//   Failure reasons   — the "What failed?" vocabulary editor (also drives Collect)
//   External controls — the channel→action mapping editor (also drives Collect)
//   Operators         — the attribution roster (fills the OP picker; not auth)
//   Recording         — form-first active-robot recording config (JSON = Advanced)
//   Data quality      — read-only expected rates + thresholds + required topics
//   Alerts            — per-robot monitor alert rules
//   Generated files   — derived report / preview cleanup
//   Validation        — aspect selection + one-click presets (run in the Val tab)
//   System            — deployment facts + honest component health
//   Appearance        — browser-local System / Light / Dark presentation mode
// Only Dataset profiles and Users & permissions stay honest placeholders — there
// is genuinely nothing to configure for them yet (see OtherSection rationale).

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { fetchRuntimeConfig, type RuntimeConfig } from '../../config';
import { queryKeys } from '../../api/queryKeys';
import type { SettingsSectionId } from './data';
import { MenuRail } from './MenuRail';
import { RobotsSection } from './RobotsSection';
import { PlansSection } from './PlansSection';
import { FailureReasonsSection } from './FailureReasonsSection';
import { ExternalControlsSection } from './ExternalControlsSection';
import { AudioSection } from './AudioSection';
import { OperatorsSection } from './OperatorsSection';
import { RecordingSection } from './RecordingSection';
import { DataQualitySection } from './DataQualitySection';
import { ValidationSection } from './ValidationSection';
import { SystemSection } from './SystemSection';
import { OtherSection } from './OtherSection';
import { AppearanceSection } from './AppearanceSection';
import { LanguageSection } from './LanguageSection';
import { AlertsCard } from './AlertsCard';
import { GeneratedFilesSection } from './GeneratedFilesSection';
import { Card } from '../../components/ui';
import { Toast } from '../shared/Toast';
import { useSettingsState } from './useSettingsState';
import { adoptServerCatalog, usePlansConflict, usePlansUnsynced } from '../plans';
import { ScreenTitle } from '../shared/ScreenTitle';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../i18n';

// Honest rationale for the two sections with nothing to configure yet.
interface SectionRendererContext {
  config: RuntimeConfig | undefined;
  settings: ReturnType<typeof useSettingsState>;
}

const SECTION_RENDERERS: Record<
  SettingsSectionId,
  (context: SectionRendererContext) => ReactNode
> = {
  language: () => <LanguageSection />,
  robots: ({ config }) => <RobotsSection config={config} />,
  'projects-tasks': ({ settings }) => <PlansSection settings={settings} />,
  'failure-reasons': ({ settings }) => <FailureReasonsSection settings={settings} />,
  'external-controls': () => <ExternalControlsSection />,
  operators: ({ settings }) => <OperatorsSection settings={settings} />,
  recording: ({ config }) => <RecordingSection config={config} />,
  'data-quality': ({ config }) => <DataQualitySection config={config} />,
  validation: () => <ValidationSection />,
  'dataset-profiles': () => <PlaceholderSection kind="datasetProfiles" />,
  'users-permissions': () => <PlaceholderSection kind="usersPermissions" />,
  system: ({ config }) => <SystemSection config={config} />,
  appearance: () => <AppearanceSection />,
  audio: () => <AudioSection />,
  alerts: () => (
    <Card
      className="flex min-w-0 flex-col overflow-auto p-[18px] lg:col-span-2"
      data-testid="settings-alerts-panel"
    >
      <AlertsCard />
    </Card>
  ),
  'generated-files': () => (
    <Card
      className="flex min-w-0 flex-col overflow-auto p-[18px] lg:col-span-2"
      data-testid="settings-generated-files"
    >
      <GeneratedFilesSection />
    </Card>
  ),
};

export function SettingsScreen() {
  const { t } = useTranslation('settings');
  // Same cache key CollectScreen reads (see src/v2/collect/CollectScreen.tsx)
  // — the app shell fetches this before any tab renders. `config` is used
  // best-effort only: every field read from it here is optional.
  const { data: config } = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: fetchRuntimeConfig,
  });

  const settings = useSettingsState();
  const renderSection = SECTION_RENDERERS[settings.sectionId];

  return (
    <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:min-h-0 lg:grid-cols-[216px_250px_1fr]">
      <ScreenTitle>{t('screen.title')}</ScreenTitle>
      <MenuRail settings={settings} />
      {renderSection({ config, settings })}
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
  const { t } = useTranslation('settings');
  const conflicted = usePlansConflict();
  if (!conflicted) return null;
  return (
    <div
      data-testid="plans-conflict"
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-control border border-status-danger-border bg-status-danger-bg px-3.5 py-2 text-[12px] text-status-danger-text shadow-card"
    >
      {t('screen.catalogConflict')}
      <button
        type="button"
        data-testid="plans-use-server"
        onClick={adoptServerCatalog}
        className="rounded border border-status-danger-border bg-surface px-2 py-1 font-semibold hover:bg-interaction-hover"
      >
        {i18n.t('common:actions.useServerCatalog')}
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
  const { t } = useTranslation('settings');
  const unsynced = usePlansUnsynced();
  if (!unsynced) return null;
  return (
    <div
      data-testid="plans-unsynced"
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-control border border-status-warning-border bg-status-warning-bg px-3.5 py-2 text-[12px] text-status-warning-text shadow-card"
    >
      {t('screen.catalogUnsynced')}
    </div>
  );
}

function PlaceholderSection({
  kind,
}: {
  kind: 'datasetProfiles' | 'usersPermissions';
}) {
  const { t } = useTranslation('settings');
  return (
    <OtherSection
      label={t(`screen.placeholders.${kind}`)}
      rationale={t(`screen.placeholders.${kind}Rationale`)}
    />
  );
}
