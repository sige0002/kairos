// Mock catalogs for the Settings screen (design mock:
// .dev/kairos-console-v2.dc.html, data-screen-label="Settings", script ~L1563-1665).
// Robots is now real (RobotsSection.tsx → GET /api/v1/config/options); only the
// Plans section here is still a Phase-2 frontend mock, and the other five menu
// items fall back to a placeholder (see SettingsScreen.tsx).

/** One selectable settings section (left menu rail). Order/labels are the
 *  mock's `setSections` — plus "Failure reasons" (post-mock, 2026-08-04: the
 *  fail-reason vocabulary editor, kept next to the other label vocabulary). */
export const SETTINGS_MENU = [
  'Robots',
  'Projects & tasks',
  'Failure reasons',
  'Recording',
  'Data quality',
  'Validation',
  'Dataset profiles',
  'Users & permissions',
  'System',
] as const;

// The plan catalog (Projects → Tasks → Conditions) is now the SHARED v2/plans
// store — the single source of truth for both Settings and Collect, so an edit
// here reflects in Collect immediately. These re-exports keep the existing
// Settings type names (`PlanProjectData`/`PlanTaskData`).
export type { PlanProject as PlanProjectData, PlanTask as PlanTaskData } from '../plans';
export { DEFAULT_PLANS as INITIAL_PLANS, clonePlans } from '../plans';
