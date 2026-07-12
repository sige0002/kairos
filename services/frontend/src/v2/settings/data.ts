// Mock catalogs for the Settings screen (design mock:
// .dev/kairos-console-v2.dc.html, data-screen-label="Settings", script ~L1563-1665).
// Only the Robots and Plans sections are in scope for Phase 1 (see
// SettingsScreen.tsx); the other five menu items fall back to a placeholder.

/** One selectable settings section (left menu rail). Order/labels are the
 *  mock's `setSections` verbatim — only the first two are wired up. */
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

export interface RobotProfile {
  /** Machine id, e.g. "robot_arm_A" — shown mono in the list and form header. */
  name: string;
  /** List-row secondary line. */
  meta: string;
  /** Form "Display name" field. */
  display: string;
  /** Form "Description" field. */
  desc: string;
  chip: string;
  tone: 'green' | 'gray';
}

// Mock robot catalog (mock script `robotData`). Index 0 is the one profile
// SettingsScreen overlays with live data (see RobotsSection.tsx) — it's the
// only robot the backend actually describes today (GET /api/v1/config has a
// single active robot, not a fleet), so profiles 1-2 stay purely illustrative.
export const MOCK_ROBOTS: RobotProfile[] = [
  {
    name: 'robot_arm_A',
    meta: 'UR5e · 3 cameras · active',
    display: 'Robot Arm A (UR5e)',
    desc: 'UR5e + Robotiq 2F-140 + 3 cameras',
    chip: 'ACTIVE',
    tone: 'green',
  },
  {
    name: 'robot_arm_B',
    meta: 'UR5e · 2 cameras',
    display: 'Robot Arm B (UR5e)',
    desc: 'UR5e + Robotiq 2F-85 + 2 cameras',
    chip: 'IDLE',
    tone: 'gray',
  },
  {
    name: 'mobile_manipulator_X',
    meta: 'custom · 4 cameras',
    display: 'Mobile Manipulator X',
    desc: 'Custom base + arm + 4 cameras',
    chip: 'IDLE',
    tone: 'gray',
  },
];

export const ACTIVE_ROBOT_INDEX = 0;

/** Fallback topic chips (mock script `topicChips`) shown when the runtime
 *  config has no `default_topics` (backend down / not loaded yet). */
export const MOCK_TOPIC_CHIPS = [
  '/camera/top/image_raw',
  '/camera/left/image_raw',
  '/camera/right/image_raw',
  '/joint_states',
  '/tf',
  '/gripper/state',
  '/imu/data',
];
export const MOCK_TOPICS_SUMMARY = '12 required · 3 optional';

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
