// Mock dataset catalog for the Datasets tab. A "dataset" here is a saved
// recipe (query over reviewed episodes) plus its built LeRobot v3 artifact —
// this is frontend-local demo data in Phase 1: the Recipe/Build model has no
// backend yet, mirroring the design mock (.dev/kairos-console-v2.dc.html,
// "Datasets" section).

export interface DatasetInfo {
  name: string;
  ver: string;
  eps: string;
  success: string;
  fail: string;
  review: string;
  ops: string;
  cond: string;
  desc: string;
}

export const DATASETS: DatasetInfo[] = [
  {
    name: 'PickPlace_Left2Center',
    ver: 'v1',
    eps: '1,240',
    success: '1,102',
    fail: '98',
    review: '40',
    ops: 'A, B',
    cond: 'Condition: Left → Center',
    desc: 'A dataset is a saved query (recipe) over reviewed episodes plus its built artifact — recordings regrouped by task and operator, without moving or copying the originals. Source: Batches 1–5 of Tabletop Manipulation.',
  },
  {
    name: 'PickPlace_All',
    ver: 'v2',
    eps: '3,652',
    success: '3,180',
    fail: '312',
    review: '160',
    ops: 'A, B, C',
    cond: 'Condition: all',
    desc: 'All pick-and-place episodes across operators A–C, all conditions. Superset used for pretraining runs.',
  },
  {
    name: 'PickPlace_FailCases',
    ver: 'v1',
    eps: '512',
    success: '0',
    fail: '512',
    review: '0',
    ops: 'A, B, C',
    cond: 'Condition: all',
    desc: 'Failure-only subset for negative examples and failure-mode analysis. Labeled by failure reason.',
  },
];

export interface OperatorRow {
  name: string;
  count: number;
  pct: number;
  opacity: number;
}

// Static across datasets, matching the design mock (operatorRows/coverage
// aren't derived per-dataset there either) — only the header stats, recipe
// chips and description switch with the selected dataset.
export const OPERATOR_ROWS: OperatorRow[] = [
  { name: 'Operator A', count: 720, pct: 58, opacity: 0.85 },
  { name: 'Operator B', count: 520, pct: 42, opacity: 0.55 },
];

export interface CoverageBucket {
  label: string;
  count: number;
  pct: number;
  warn?: boolean;
}

export const COVERAGE: CoverageBucket[] = [
  { label: 'Left → Center', count: 520, pct: 88 },
  { label: 'Center → Center', count: 410, pct: 70 },
  { label: 'Right → Center', count: 130, pct: 24, warn: true },
  { label: 'Other', count: 180, pct: 32 },
];

export function recipeRows(ds: DatasetInfo): Array<{ label: string; value: string }> {
  return [
    { label: 'Source query', value: 'batches 1–5 · adopted' },
    { label: 'Task', value: 'Pick and Place' },
    { label: 'Operators', value: ds.ops },
    { label: 'Export format', value: 'LeRobot v3' },
    { label: 'Converter', value: 'lerobot v3 (external repo)' },
    { label: 'Image size', value: '640×480' },
    { label: 'Frame rate', value: '10 Hz' },
    { label: 'Topics', value: '12' },
    { label: 'Include failures', value: 'yes (labeled)' },
  ];
}
