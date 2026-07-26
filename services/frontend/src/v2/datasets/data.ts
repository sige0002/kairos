// Pure grouping / aggregation / search / sort helpers for the Datasets tab's
// real API data (GET /api/v1/datasets, GET /api/v1/datasets/{op}/{task}/{index}).
//
// 2026-07-21 IA overhaul (user report: "Datasetsの視認性がすごく悪い。データが
// 増えたらアクセスしたいデータセットにたどり着きにくい"): the flat GET /datasets
// list (one row per exported episode) was rendered one-card-per-episode, so
// hundreds of episodes made the left column unnavigable. This module folds the
// flat rows CLIENT-SIDE into a task -> condition tree (the (task, condition)
// pair is the selectable unit; operator is demoted from a hierarchy level to a
// facet). No API change — everything here operates over the rows the list
// endpoint already returns.
//
// 2026-07-13 honesty directive still holds: every number rendered comes from a
// real row field. A group whose rows carry no episode labels shows "no labels",
// never a fabricated success/failure split.

import type { DatasetEntry, RunEpisode } from '../../api/types';

// Sentinels the backend writes when an export predates the episode model, so it
// couldn't attribute an operator/task. Shown as plain-language "not recorded"
// copy rather than the raw token, only when the value matches exactly.
export const UNKNOWN_OPERATOR = 'unknown_operator';
export const UNKNOWN_TASK = 'unknown_task';

/** Operator-facet sentinel meaning "don't filter by operator". */
export const ANY_OPERATOR = '__any__';

/** Rendered where a (task, condition) group has a null condition. */
export const NO_CONDITION_LABEL = '(no condition)';

/** How many episode rows the center table builds at once (2026-07-26).
 *
 *  The table used to render EVERY row of the current scope, and the default
 *  scope is the whole filtered catalog — so the tab's FIRST paint was its worst
 *  case (every exported episode, each with a label-chip subtree, into a ~370px
 *  window). Rendering is capped at this many rows and extended on demand.
 *
 *  Deliberately a cap + "show more", never a hard truncation: the catalog must
 *  stay fully reachable however large it grows (docs/specs/ja/frontend.md,
 *  Datasets section) — the rows just aren't all built up front. */
export const EPISODE_PAGE_SIZE = 200;

export type SortMode = 'recent' | 'alpha';
export type TaskResultFilter = 'all' | 'success' | 'failure';

// ---- formatting ----------------------------------------------------------

export function formatBytes(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

export function formatCount(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

export function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Compact "MM/DD" for the group aggregate rows ("last 07/21"). */
export function formatShortDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ---- aggregation ---------------------------------------------------------

/** One distinct topic set (schema) present in a scope.
 *
 *  `label` is assigned by frequency WITHIN the scope being described ('A' is
 *  the most common), so it is a reading aid, not an identity — the identity is
 *  `hash`. Two different scopes may label the same hash differently, which is
 *  why the label is never shown without its counts beside it. */
export interface SchemaVariant {
  hash: string;
  label: string;
  episodeCount: number;
  /** Topics behind the hash; null when no row in the variant reported one. */
  topicCount: number | null;
}

export interface GroupAggregate {
  /** Number of exported episodes (rows) in the group. */
  episodeCount: number;
  /** Distinct recording "sets" (batches). batch_seq resets daily per robot, so
   *  batch_id is preferred as the identity; batch_seq is the fallback. */
  setCount: number;
  /** Rows carrying a real task_result (only these feed success/failure). */
  labeledCount: number;
  successCount: number;
  failureCount: number;
  totalBytes: number;
  /** Sum of message_count across the rows (0 when none report it). */
  totalMessages: number;
  /** Quality-label tallies (over rows that carry a quality value). */
  qualityGood: number;
  qualityNeedsReview: number;
  qualityNotUsable: number;
  /** Rows carrying any quality value (qualityGood+needsReview+notUsable). */
  qualityLabeledCount: number;
  /** Newest exported_at across the rows (ISO), or null. */
  lastExportedAt: string | null;
  /** Distinct REAL operators (excludes the unknown_operator sentinel), sorted. */
  operators: string[];
  /** True when at least one row is unattributed (unknown_operator). */
  hasUnknownOperator: boolean;
  /** Distinct topic sets across the rows, most episodes first. More than one
   *  means the scope mixes observation/action spaces (see SchemaVariant). */
  schemas: SchemaVariant[];
  /** Rows carrying no topic signature — excluded from `schemas` entirely, so an
   *  unknown never masquerades as agreement OR as a disagreement. */
  schemaUnknown: number;
}

/** Scope-local display label for the nth most common topic set: A, B, C … then
 *  a numeric fallback past Z (26 distinct schemas in one scope would already be
 *  a much louder problem than the labelling). */
function schemaLabel(rank: number): string {
  return rank < 26 ? String.fromCharCode(65 + rank) : `#${rank + 1}`;
}

/** Fold the rows' topic signatures into ranked variants (most common first,
 *  hash as the deterministic tiebreak so the labels never flicker). */
function collectSchemas(entries: DatasetEntry[]): {
  schemas: SchemaVariant[];
  schemaUnknown: number;
} {
  const byHash = new Map<string, { episodeCount: number; topicCount: number | null }>();
  let schemaUnknown = 0;
  for (const e of entries) {
    const hash = e.topics_hash;
    if (typeof hash !== 'string' || hash === '') {
      schemaUnknown++;
      continue;
    }
    const cur = byHash.get(hash);
    if (cur) {
      cur.episodeCount++;
      if (cur.topicCount === null && typeof e.topic_count === 'number') {
        cur.topicCount = e.topic_count;
      }
    } else {
      byHash.set(hash, {
        episodeCount: 1,
        topicCount: typeof e.topic_count === 'number' ? e.topic_count : null,
      });
    }
  }
  const schemas = [...byHash.entries()]
    .sort((a, b) => b[1].episodeCount - a[1].episodeCount || a[0].localeCompare(b[0]))
    .map(([hash, v], i) => ({
      hash,
      label: schemaLabel(i),
      episodeCount: v.episodeCount,
      topicCount: v.topicCount,
    }));
  return { schemas, schemaUnknown };
}

/** True when a scope holds more than one topic set — the episodes do NOT share
 *  one observation/action space, so they can't convert into a single dataset. */
export function isMixedSchema(agg: GroupAggregate): boolean {
  return agg.schemas.length > 1;
}

/** The scope's dominant topic set (null when nothing is known). */
export function majoritySchema(agg: GroupAggregate): SchemaVariant | null {
  return agg.schemas[0] ?? null;
}

/** The variant an episode belongs to within `agg`, or null when its signature
 *  is unknown (the honest "can't say", NOT an outlier verdict). */
export function schemaOf(entry: DatasetEntry, agg: GroupAggregate): SchemaVariant | null {
  if (typeof entry.topics_hash !== 'string' || entry.topics_hash === '') return null;
  return agg.schemas.find((s) => s.hash === entry.topics_hash) ?? null;
}

/** True when the episode has a known signature that ISN'T the scope majority —
 *  the row the UI marks, because it is the one that will break a build. Only
 *  ever true in a scope that actually mixes schemas. */
export function isSchemaOutlier(entry: DatasetEntry, agg: GroupAggregate): boolean {
  if (!isMixedSchema(agg)) return false;
  const variant = schemaOf(entry, agg);
  return variant !== null && variant.hash !== agg.schemas[0]!.hash;
}

/** True when `a` is strictly later than `b` (both ISO8601); NaN-safe. */
function isoLater(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b; // lexical fallback
  return ta > tb;
}

export function aggregate(entries: DatasetEntry[]): GroupAggregate {
  let labeledCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let totalBytes = 0;
  let totalMessages = 0;
  let qualityGood = 0;
  let qualityNeedsReview = 0;
  let qualityNotUsable = 0;
  let lastExportedAt: string | null = null;
  const sets = new Set<string>();
  const operators = new Set<string>();
  let hasUnknownOperator = false;

  for (const e of entries) {
    if (e.task_result === 'success') {
      successCount++;
      labeledCount++;
    } else if (e.task_result === 'failure') {
      failureCount++;
      labeledCount++;
    }
    if (e.quality === 'good') qualityGood++;
    else if (e.quality === 'needs_review') qualityNeedsReview++;
    else if (e.quality === 'not_usable') qualityNotUsable++;
    totalBytes += e.bytes ?? 0;
    totalMessages += e.message_count ?? 0;
    if (e.exported_at && (lastExportedAt === null || isoLater(e.exported_at, lastExportedAt))) {
      lastExportedAt = e.exported_at;
    }
    const setId = e.batch_id ?? (e.batch_seq != null ? `seq:${e.batch_seq}` : null);
    if (setId) sets.add(setId);
    if (e.operator === UNKNOWN_OPERATOR) hasUnknownOperator = true;
    else operators.add(e.operator);
  }

  return {
    episodeCount: entries.length,
    setCount: sets.size,
    labeledCount,
    successCount,
    failureCount,
    totalBytes,
    totalMessages,
    qualityGood,
    qualityNeedsReview,
    qualityNotUsable,
    qualityLabeledCount: qualityGood + qualityNeedsReview + qualityNotUsable,
    lastExportedAt,
    operators: [...operators].sort(),
    hasUnknownOperator,
    ...collectSchemas(entries),
  };
}

/** Success/failure breakdown for a scope summary: the rate is over LABELED rows
 *  only (task_result present), and unlabeled rows are surfaced separately —
 *  never folded into the denominator or counted as successes. `successRate` is
 *  null when the scope has no labeled rows (the UI shows an honest note, not a
 *  fabricated 0%). */
export interface OutcomeBreakdown {
  labeled: number;
  success: number;
  failure: number;
  /** success / labeled in 0..1, or null when labeled === 0. */
  successRate: number | null;
  /** Episodes with no task_result (excluded from the rate). */
  unlabeled: number;
}

export function outcomeBreakdown(agg: GroupAggregate): OutcomeBreakdown {
  const labeled = agg.labeledCount;
  return {
    labeled,
    success: agg.successCount,
    failure: agg.failureCount,
    successRate: labeled > 0 ? agg.successCount / labeled : null,
    unlabeled: agg.episodeCount - labeled,
  };
}

// ---- the task -> condition tree ------------------------------------------

export interface DatasetGroup {
  /** Stable identity of the (task, condition) pair (selection key). */
  key: string;
  task: string;
  condition: string | null;
  /** The unattributed-task bucket (unknown_task): rendered muted, at the bottom. */
  isLegacy: boolean;
  /** Episodes in this group, already sorted for the center table (exported DESC). */
  entries: DatasetEntry[];
  aggregate: GroupAggregate;
}

export interface TaskNode {
  task: string;
  isLegacy: boolean;
  /** The (task, condition) groups under this task. */
  conditions: DatasetGroup[];
  /** Aggregate across every condition (shown on the collapsed task header). */
  aggregate: GroupAggregate;
}

const KEY_SEP = '\0';

export function groupKey(task: string, condition: string | null): string {
  return `${task}${KEY_SEP}${condition ?? ''}`;
}

/** True when a task node is a "leaf": it holds exactly one condition group, so
 *  it needs no expand/collapse — the task row itself selects that group (a task
 *  with a single null condition "collapses naturally"). */
export function isLeafTask(node: TaskNode): boolean {
  return node.conditions.length === 1;
}

/** Episodes newest export first (the center table default), index ascending as
 *  a stable tiebreak. Used both within a group and for the whole-catalog scope. */
export function sortEpisodes(entries: DatasetEntry[]): DatasetEntry[] {
  return [...entries].sort((a, b) => {
    const ta = a.exported_at ? Date.parse(a.exported_at) : NaN;
    const tb = b.exported_at ? Date.parse(b.exported_at) : NaN;
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    if (va !== vb) return vb - va;
    return a.index.localeCompare(b.index);
  });
}

function compareRecent(a: GroupAggregate, b: GroupAggregate): number {
  const va = a.lastExportedAt ? Date.parse(a.lastExportedAt) : -Infinity;
  const vb = b.lastExportedAt ? Date.parse(b.lastExportedAt) : -Infinity;
  const na = Number.isNaN(va) ? -Infinity : va;
  const nb = Number.isNaN(vb) ? -Infinity : vb;
  return nb - na; // newest first
}

function sortConditions(groups: DatasetGroup[], sort: SortMode): DatasetGroup[] {
  const label = (g: DatasetGroup) => (g.condition ?? NO_CONDITION_LABEL).toLowerCase();
  return [...groups].sort((a, b) => {
    if (sort === 'alpha') return label(a).localeCompare(label(b));
    return compareRecent(a.aggregate, b.aggregate) || label(a).localeCompare(label(b));
  });
}

function sortTasks(nodes: TaskNode[], sort: SortMode): TaskNode[] {
  return [...nodes].sort((a, b) => {
    // The unattributed-task bucket always sinks to the bottom, either sort.
    if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
    if (sort === 'alpha') return a.task.localeCompare(b.task);
    return compareRecent(a.aggregate, b.aggregate) || a.task.localeCompare(b.task);
  });
}

/** Fold the flat rows into a task -> condition tree, sorted per `sort`. */
export function buildTaskTree(entries: DatasetEntry[], sort: SortMode): TaskNode[] {
  const byTask = new Map<string, DatasetEntry[]>();
  for (const e of entries) {
    const list = byTask.get(e.task) ?? [];
    list.push(e);
    byTask.set(e.task, list);
  }

  const nodes: TaskNode[] = [];
  for (const [task, taskEntries] of byTask) {
    const byCondition = new Map<string, DatasetEntry[]>();
    for (const e of taskEntries) {
      const ck = e.condition ?? '';
      const list = byCondition.get(ck) ?? [];
      list.push(e);
      byCondition.set(ck, list);
    }
    const conditions: DatasetGroup[] = [...byCondition.entries()].map(([ck, es]) => {
      const condition = ck === '' ? null : ck;
      return {
        key: groupKey(task, condition),
        task,
        condition,
        isLegacy: task === UNKNOWN_TASK,
        entries: sortEpisodes(es),
        aggregate: aggregate(es),
      };
    });
    nodes.push({
      task,
      isLegacy: task === UNKNOWN_TASK,
      conditions: sortConditions(conditions, sort),
      aggregate: aggregate(taskEntries),
    });
  }
  return sortTasks(nodes, sort);
}

/** Locate a group by its selection key across the tree (null when not present,
 *  e.g. the current search/filters hid it). */
export function findGroup(nodes: TaskNode[], key: string | null): DatasetGroup | null {
  if (!key) return null;
  for (const node of nodes) {
    for (const group of node.conditions) {
      if (group.key === key) return group;
    }
  }
  return null;
}

// ---- search + facets -----------------------------------------------------

/** Case-insensitive substring search over task / condition / operator / episode
 *  index / batch seq. A leading '#' on the query is optional, so both "6" and
 *  "#6" find batch seq 6. */
/**
 * Per-entry lowercase haystacks, built ONCE per catalog rather than per
 * keystroke. Rebuilding them inside the predicate meant every character typed
 * re-allocated an array, joined it and lowercased it for every row: measured at
 * 10,000 episodes the UI fell 149 ms behind a typist over a seven-character
 * word, against 40 ms at twelve. The strings are keyed by identity, so a
 * refetched catalog simply builds fresh ones.
 */
const _catalogHay = new WeakMap<DatasetEntry, string>();
const _episodeHay = new WeakMap<DatasetEntry, string>();

function haystack(
  cache: WeakMap<DatasetEntry, string>,
  entry: DatasetEntry,
  parts: () => string[],
): string {
  const cached = cache.get(entry);
  if (cached !== undefined) return cached;
  const built = parts().join(' ').toLowerCase();
  cache.set(entry, built);
  return built;
}

/** `#6` and `6` must both match a set number, so queries are tried both ways. */
function matches(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const qStripped = q.startsWith('#') ? q.slice(1) : q;
  return hay.includes(q) || hay.includes(qStripped);
}

export function entryMatchesSearch(entry: DatasetEntry, query: string): boolean {
  if (!query.trim()) return true;
  const hay = haystack(_catalogHay, entry, () => {
    const parts: string[] = [entry.task, entry.condition ?? '', entry.operator, entry.index];
    if (entry.batch_seq != null) {
      parts.push(`#${entry.batch_seq}`, String(entry.batch_seq));
    }
    return parts;
  });
  return matches(hay, query);
}

/** Episode-row search inside the center's top pane (distinct from the left tree
 *  search): case-insensitive substring over episode index ("NNN"/"#NNN"), set
 *  seq ("6"/"#6"), operator, and failure reason — the fields you reach for to
 *  jump to one episode in a large group. */
export function episodeMatchesSearch(entry: DatasetEntry, query: string): boolean {
  if (!query.trim()) return true;
  const hay = haystack(_episodeHay, entry, () => {
    const parts: string[] = [entry.index, entry.operator, entry.failure_reason ?? ''];
    if (entry.batch_seq != null) {
      parts.push(`#${entry.batch_seq}`, String(entry.batch_seq));
    }
    return parts;
  });
  return matches(hay, query);
}

export function entryMatchesFacets(
  entry: DatasetEntry,
  taskResultFilter: TaskResultFilter,
  operatorFilter: string,
): boolean {
  // An unlabeled row can't answer a success/failure predicate — it only passes
  // 'all' (never counted as an implicit success).
  const okResult = taskResultFilter === 'all' || entry.task_result === taskResultFilter;
  const okOperator = operatorFilter === ANY_OPERATOR || entry.operator === operatorFilter;
  return okResult && okOperator;
}

export interface EntryFilter {
  search: string;
  taskResultFilter: TaskResultFilter;
  operatorFilter: string;
}

export function filterEntries(entries: DatasetEntry[], f: EntryFilter): DatasetEntry[] {
  return entries.filter(
    (e) =>
      entryMatchesSearch(e, f.search) &&
      entryMatchesFacets(e, f.taskResultFilter, f.operatorFilter),
  );
}

/** Distinct operators present in the catalog (facet dropdown choices), sorted;
 *  the unknown_operator sentinel sinks to the end (rendered as prose in the UI). */
export function distinctOperators(entries: DatasetEntry[]): string[] {
  const ops = [...new Set(entries.map((e) => e.operator))];
  return ops.sort((a, b) => {
    if (a === UNKNOWN_OPERATOR) return 1;
    if (b === UNKNOWN_OPERATOR) return -1;
    return a.localeCompare(b);
  });
}

// ---- aggregate summary line (honest, testable) ---------------------------

export interface SummarySegment {
  text: string;
  /** Optional tooltip (e.g. spelling out ✓/✗ for accessibility). */
  title?: string;
  /** Render as a warning (amber) rather than muted body text. */
  warn?: boolean;
}

/** The one-line aggregate shown under a group/task row. Every segment is real:
 *  when no row is labeled, the success/failure segment is replaced by an honest
 *  "no labels" rather than a fabricated ✓0 ✗0. */
export function groupSummarySegments(agg: GroupAggregate): SummarySegment[] {
  const segs: SummarySegment[] = [];
  segs.push({ text: `${agg.episodeCount} ${agg.episodeCount === 1 ? 'ep' : 'eps'}` });
  if (agg.setCount > 0) {
    segs.push({ text: `${agg.setCount} ${agg.setCount === 1 ? 'set' : 'sets'}` });
  }
  if (agg.labeledCount > 0) {
    segs.push({
      text: `✓${agg.successCount} ✗${agg.failureCount}`,
      title: `${agg.successCount} success, ${agg.failureCount} failure`,
    });
  } else {
    segs.push({ text: 'no labels', title: 'No episode labels on these exports' });
  }
  if (agg.totalBytes > 0) segs.push({ text: formatBytes(agg.totalBytes) });
  if (agg.lastExportedAt) segs.push({ text: `last ${formatShortDate(agg.lastExportedAt)}` });
  segs.push(operatorSegment(agg));
  // A mixed group is called out HERE, on the list row, because the cost of
  // finding out later is a wasted conversion — you must be able to see it
  // before you select the group, not only after.
  if (isMixedSchema(agg)) {
    segs.push({
      text: `${agg.schemas.length} topic sets`,
      title:
        'These episodes do not share one topic set (observation/action space) — ' +
        'select the group to see the split.',
      warn: true,
    });
  }
  return segs;
}

/** Operator stays visible on every group even though it's no longer a hierarchy
 *  level (user decision): the single operator's name, or "N operators". */
export function operatorSegment(agg: GroupAggregate): SummarySegment {
  const n = agg.operators.length;
  if (n === 0 && agg.hasUnknownOperator) return { text: 'operator not recorded' };
  if (n === 1 && !agg.hasUnknownOperator) return { text: agg.operators[0]! };
  const suffix = agg.hasUnknownOperator ? '+' : '';
  return {
    text: `${n}${suffix} operators`,
    title: agg.operators.join(', ') + (agg.hasUnknownOperator ? ' (+ unattributed)' : ''),
  };
}

// ---- misc ----------------------------------------------------------------

export function sameDataset(a: DatasetEntry | null, b: DatasetEntry): boolean {
  return a !== null && a.dataset_dir === b.dataset_dir;
}

/** The list serves the episode-label subset as FLAT row fields (episode.json is
 *  nested only on the detail payload). Adapt a row into the RunEpisode shape the
 *  shared chips consume; null when no label survived export (pre-label rows), so
 *  the caller shows nothing fabricated. */
export function rowEpisode(entry: DatasetEntry): RunEpisode | null {
  if (entry.task_result == null || entry.quality == null) return null;
  return {
    episode_id: '',
    batch_id: entry.batch_id ?? '',
    index_in_batch: entry.index_in_batch ?? 0,
    task_result: entry.task_result,
    failure_reason: entry.failure_reason ?? null,
    quality: entry.quality,
    review_status: entry.review_status ?? 'pending',
    batch_seq: entry.batch_seq ?? null,
  };
}

/** Selector-safe id fragment for data-testid hooks (task/condition can contain
 *  spaces and punctuation). */
export function slugForTestId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'none';
}

export function taskTestId(task: string): string {
  return `dataset-task-${slugForTestId(task)}`;
}

export function groupTestId(group: DatasetGroup): string {
  return `dataset-group-${slugForTestId(group.task)}-${slugForTestId(group.condition ?? 'none')}`;
}
