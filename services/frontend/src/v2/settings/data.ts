// Mock catalogs for the Settings screen (design mock:
// .dev/kairos-console-v2.dc.html, data-screen-label="Settings", script ~L1563-1665).
// Robots is now real (RobotsSection.tsx → GET /api/v1/config/options); only the
// Plans section here is still a Phase-2 frontend mock, and the other five menu
// items fall back to a placeholder (see SettingsScreen.tsx).

/** One selectable settings section (left menu rail). Order/labels are the
 *  mock's `setSections` verbatim — only Robots (real) and Plans are wired up. */
export const SETTINGS_MENU = [
  'Robots',
  'Projects & tasks',
  'Recording',
  'Data quality',
  'Validation',
  'Dataset profiles',
  'Users & permissions',
  'System',
] as const;

export interface PlanTaskData {
  name: string;
  conditions: string[];
}

export interface PlanProjectData {
  name: string;
  tasks: PlanTaskData[];
}

// Plan catalog seed. Deliberately the same literal project/task/condition
// values as src/v2/collect/useBatchMachine.ts's `PLANS` (not imported from
// there — each v2 screen owns its directory — so the two screens read as one
// consistent catalog until batch plans grow a real backend, Phase 2).
export const INITIAL_PLANS: PlanProjectData[] = [
  {
    name: 'Tabletop Manipulation',
    tasks: [
      {
        name: 'Pick and Place',
        conditions: [
          'Object: Left → Tray: Center',
          'Object: Center → Tray: Center',
          'Object: Right → Tray: Center',
        ],
      },
      { name: 'Stacking', conditions: ['Blocks: 3', 'Blocks: 5'] },
    ],
  },
  {
    name: 'Bin Picking',
    tasks: [{ name: 'Bin to Tray', conditions: ['Bin: full', 'Bin: sparse'] }],
  },
  {
    name: 'Kitchen Mobile',
    tasks: [{ name: 'Drawer Open', conditions: ['Drawer: top', 'Drawer: bottom'] }],
  },
];

export function clonePlans(plans: PlanProjectData[]): PlanProjectData[] {
  return plans.map((p) => ({
    name: p.name,
    tasks: p.tasks.map((t) => ({ name: t.name, conditions: t.conditions.slice() })),
  }));
}
