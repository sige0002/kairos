// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The Settings IA is deliberately data-driven: IDs are durable navigation
// identities; labels are presentation and may be localized independently.
export const SETTINGS_CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'collection', label: 'Collection' },
  { id: 'data', label: 'Data' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

export const SETTINGS_SECTIONS = [
  { id: 'language', label: 'Language', categoryId: 'general', legacyIndex: null },
  { id: 'robots', label: 'Robots', categoryId: 'collection', legacyIndex: 0 },
  { id: 'projects-tasks', label: 'Projects & tasks', categoryId: 'workspace', legacyIndex: 1 },
  { id: 'failure-reasons', label: 'Failure reasons', categoryId: 'workspace', legacyIndex: 2 },
  { id: 'external-controls', label: 'External controls', categoryId: 'collection', legacyIndex: 3 },
  { id: 'operators', label: 'Operators', categoryId: 'workspace', legacyIndex: 4 },
  { id: 'recording', label: 'Recording', categoryId: 'collection', legacyIndex: 5 },
  { id: 'data-quality', label: 'Data quality', categoryId: 'data', legacyIndex: 6 },
  { id: 'validation', label: 'Validation', categoryId: 'data', legacyIndex: 7 },
  { id: 'dataset-profiles', label: 'Dataset profiles', categoryId: 'advanced', legacyIndex: 8 },
  { id: 'users-permissions', label: 'Users & permissions', categoryId: 'advanced', legacyIndex: 9 },
  { id: 'system', label: 'System', categoryId: 'advanced', legacyIndex: 10 },
  { id: 'appearance', label: 'Appearance', categoryId: 'general', legacyIndex: 11 },
  { id: 'audio', label: 'Audio', categoryId: 'general', legacyIndex: 12 },
  { id: 'alerts', label: 'Alerts', categoryId: 'notifications', legacyIndex: null },
  { id: 'generated-files', label: 'Generated files', categoryId: 'data', legacyIndex: null },
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
