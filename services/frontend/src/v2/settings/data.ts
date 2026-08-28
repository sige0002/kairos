// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The Settings IA is deliberately data-driven: IDs are durable navigation
// identities; labels are presentation and may be localized independently.
export const SETTINGS_CATEGORIES = [
  { id: 'general', label: 'general' },
  { id: 'collection', label: 'collection' },
  { id: 'data', label: 'data' },
  { id: 'workspace', label: 'workspace' },
  { id: 'notifications', label: 'notifications' },
  { id: 'advanced', label: 'advanced' },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

export const SETTINGS_SECTIONS = [
  { id: 'language', label: 'language', categoryId: 'general', legacyIndex: null },
  { id: 'robots', label: 'robots', categoryId: 'collection', legacyIndex: 0 },
  {
    id: 'projects-tasks',
    label: 'projectsTasks',
    categoryId: 'workspace',
    legacyIndex: 1,
  },
  {
    id: 'failure-reasons',
    label: 'failureReasons',
    categoryId: 'workspace',
    legacyIndex: 2,
  },
  {
    id: 'external-controls',
    label: 'externalControls',
    categoryId: 'collection',
    legacyIndex: 3,
  },
  { id: 'operators', label: 'operators', categoryId: 'workspace', legacyIndex: 4 },
  { id: 'recording', label: 'recording', categoryId: 'collection', legacyIndex: 5 },
  { id: 'data-quality', label: 'dataQuality', categoryId: 'data', legacyIndex: 6 },
  { id: 'validation', label: 'validation', categoryId: 'data', legacyIndex: 7 },
  {
    id: 'dataset-profiles',
    label: 'datasetProfiles',
    categoryId: 'advanced',
    legacyIndex: 8,
  },
  {
    id: 'users-permissions',
    label: 'usersPermissions',
    categoryId: 'advanced',
    legacyIndex: 9,
  },
  { id: 'system', label: 'system', categoryId: 'advanced', legacyIndex: 10 },
  { id: 'appearance', label: 'appearance', categoryId: 'general', legacyIndex: 11 },
  { id: 'audio', label: 'audio', categoryId: 'general', legacyIndex: 12 },
  { id: 'alerts', label: 'alerts', categoryId: 'notifications', legacyIndex: null },
  {
    id: 'generated-files',
    label: 'generatedFiles',
    categoryId: 'data',
    legacyIndex: null,
  },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// Compatibility for older unit tests and helpers. Navigation itself uses IDs.
export const SETTINGS_MENU = SETTINGS_SECTIONS.filter(
  (section) => section.legacyIndex !== null,
).map((section) => section.label);

export const DEFAULT_SETTINGS_SECTION_ID: SettingsSectionId = 'robots';

export function getSettingsSection(id: string | null): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id);
}

export function getCategorySections(categoryId: SettingsCategoryId): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.categoryId === categoryId);
}

// The plan catalog (Projects → Tasks → Conditions) is now the SHARED v2/plans
// store — the single source of truth for both Settings and Collect, so an edit
// here reflects in Collect immediately. These re-exports keep the existing
// Settings type names (`PlanProjectData`/`PlanTaskData`).
export type {
  PlanProject as PlanProjectData,
  PlanTask as PlanTaskData,
} from '../plans';
export { DEFAULT_PLANS as INITIAL_PLANS, clonePlans } from '../plans';
