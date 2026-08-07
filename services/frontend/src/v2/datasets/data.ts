// Pure aggregation / search / sort helpers for the Datasets tab.
//
// A dataset is a NAME and a SET OF MEMBERSHIPS (§6). It carries no directory,
// no export time and no condition, so the only things that can be said about
// one are said about its MEMBERS: how many there are, how much they weigh, what
// the operator labelled them, and whether their bytes are on this machine at
// all. Everything below aggregates over the member captures.
//
// The 2026-07-13 honesty directive is what makes so much of this nullable:
// every number rendered comes from a real field. A total is only shown when
// something actually reported it, a scope with no labels says "no labels"
// rather than a fabricated success/failure split, and a member whose capture is
// not in the loaded catalog is COUNTED as unresolved rather than dropped — a
// quiet drop would shrink the denominator and make every rate look better than
// it is.

import type { CaptureListItem, Dataset, DatasetMember } from '../../api/types';
import type { Tone } from '../../components/ui';
import {
  availabilityOf,
  isCapturePresent,
  type AvailabilityKind,
} from '../captures/availability';
import { formatHms } from '../review/format';
import { spanMs } from '../review/mapCaptures';

/** Operator-facet sentinel meaning "don't filter by operator". */
export const ANY_OPERATOR = '__any__';

/** How many member rows the center table builds at once.
 *
 *  Deliberately a page + pager, never a hard truncation: a dataset must stay
 *  fully reachable however large it grows — the rows just aren't all built up
 *  front, and the boundary is stated rather than silent. */
export const MEMBER_PAGE_SIZE = 200;

export type SortMode = 'recent' | 'alpha';
export type TaskResultFilter = 'all' | 'success' | 'failure';

// ---- formatting ----------------------------------------------------------

export { formatBytes, formatWhen } from '../review/format';
import { formatBytes } from '../review/format';

/** "21 Jul 09:00:00" — when the recording was taken, date included: unlike the
 *  Review table (which is usually read inside one batch's day), the dataset
 *  rails mix captures from any date, so time-of-day alone is ambiguous. Not
 *  `formatWhen` (below): that is the full locale timestamp for detail prose;
 *  this is the compact row-identity form. */
export function captureWhen(capture: CaptureListItem): string {
  const iso = capture.started_at;
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour12: false });
  return `${date} ${time}`;
}

/** The facts that tell one recording from another — task · operator ·
 *  duration · size — with unknowns dropped rather than rendered as "—" noise.
 *  Empty string when nothing is known. A run_id alone cannot answer "which
 *  data is this?" (2026-08-03 feedback): same-day runs differ only in their
 *  final digits, so every dataset surface leads with these and keeps the run
 *  name as the secondary, on-disk identity (§1: display only). */
export function captureFacts(capture: CaptureListItem): string {
  const parts: string[] = [];
  if (capture.task) parts.push(capture.task);
  if (capture.operator) parts.push(capture.operator);
  const ms = spanMs(capture.started_at, capture.ended_at);
  if (ms !== undefined) parts.push(formatHms(ms));
  if (capture.bytes != null) parts.push(formatBytes(capture.bytes));
  return parts.join(' · ');
}

export function formatCount(n?: number | null): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

/** "member" / "members", agreeing with `n`. One place, because the screen says
 *  it in six — a list row, a scope header, a pager, a stat tile and two
 *  tooltips — and "1 members" in any one of them reads as a rendering bug and
 *  costs the number beside it its credibility. */
export function memberNoun(n: number): string {
  return n === 1 ? 'member' : 'members';
}

/** The count and its noun together ("1 member", "1,204 members"). */
export function memberCount(n: number): string {
  return `${formatCount(n)} ${memberNoun(n)}`;
}



/** Compact "MM/DD" for the list rows ("last 07/21"). */
export function formatShortDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

/** The short form of a capture id used in tables and titles. The full id is
 *  always available as the element's `title`; this is a reading aid only. */
export function shortCaptureId(captureId: string): string {
  return captureId.slice(0, 8);
}

// ---- members -------------------------------------------------------------

/** One membership, joined to the capture it cites. */
export interface MemberRow {
  membershipId: string;
  datasetId: string;
  captureId: string;
  /** The number shown beside this capture INSIDE this dataset. Display-only,
   *  and never reused after a removal (§6) — so it is a label, never an index
   *  into an array and never a key. */
  displayIndex: number;
  /** The capture this membership cites, or null when the loaded catalog holds
   *  no row for it. Kept as a row rather than dropped: the membership is real
   *  even when our view of the catalog cannot describe it. */
  capture: CaptureListItem | null;
}

// A membership makes two claims about a capture, and the rail must not offer to
// write one before both hold:
//
//   * the BYTES are on this host. §6 regenerates views/ as symlinks into
//     objects/<capture_id>; a capture that never landed here has no target for
//     that link, so the entry would name a path this machine cannot produce.
//   * REVIEW ADOPTED it. A dataset is a training set, and `review_status` is
//     the only record that a human judged the recording fit for one. Pending
//     and excluded are both "not yet", for opposite reasons.
//
// The candidate stays LISTED when either fails — the operator has to be able to
// see the recording to understand why it cannot join — and the control carries
// the reason instead of the row quietly disappearing.

const ADD_BLOCKED_NOT_HERE =
  "This recording's bytes are not on this machine, so the dataset's views/ " +
  'tree would have no file to link to. It can be added once the copy lands ' +
  'here.';

const ADD_BLOCKED_NOT_ADOPTED =
  'This recording has not been adopted in Review, so nothing has judged it fit ' +
  'for a training set. Adopt it in Review first.';

/** Why this capture cannot join a dataset right now, or null when it can. Both
 *  causes are named when both apply — fixing one and finding the button still
 *  dead is worse than being told twice. */
export function addBlockedReason(capture: CaptureListItem): string | null {
  const reasons: string[] = [];
  if (!isCapturePresent(capture)) reasons.push(ADD_BLOCKED_NOT_HERE);
  if (capture.review_status !== 'adopted') reasons.push(ADD_BLOCKED_NOT_ADOPTED);
  return reasons.length > 0 ? reasons.join(' ') : null;
}

/** Members ascending by `display_index` — the order the dataset is read in. */
function byDisplayIndex(a: MemberRow, b: MemberRow): number {
  return a.displayIndex - b.displayIndex;
}

/** Join a dataset's authoritative member list to the loaded captures. */
export function joinMembers(
  members: DatasetMember[],
  capturesById: Map<string, CaptureListItem>,
): MemberRow[] {
  return members
    .map((m) => ({
      membershipId: m.membership_id,
      datasetId: m.dataset_id,
      captureId: m.capture_id,
      displayIndex: m.display_index,
      capture: capturesById.get(m.capture_id) ?? null,
    }))
    .sort(byDisplayIndex);
}

/**
 * Every dataset's members, read off the captures themselves.
 *
 * `GET /api/v1/captures` returns each capture's `memberships`, which is what
 * lets the left column summarise EVERY dataset from the two list calls it
 * already makes. Fetching each dataset's detail to count its members would be
 * one request per row.
 */
export function membersByDataset(captures: CaptureListItem[]): Map<string, MemberRow[]> {
  const byDataset = new Map<string, MemberRow[]>();
  for (const capture of captures) {
    for (const m of capture.memberships ?? []) {
      const rows = byDataset.get(m.dataset_id) ?? [];
      rows.push({
        membershipId: m.membership_id,
        datasetId: m.dataset_id,
        captureId: capture.capture_id,
        displayIndex: m.display_index,
        capture,
      });
      byDataset.set(m.dataset_id, rows);
    }
  }
  for (const rows of byDataset.values()) rows.sort(byDisplayIndex);
  return byDataset;
}

/** Captures indexed for the join above. */
export function indexCaptures(captures: CaptureListItem[]): Map<string, CaptureListItem> {
  return new Map(captures.map((c) => [c.capture_id, c]));
}

// ---- aggregation ---------------------------------------------------------

/**
 * A total, kept beside the number of members that did NOT report the field.
 *
 * A bare sum cannot be read honestly: adding up five members of which two carry
 * no size and printing it as "the size" states a total that describes three
 * recordings while looking like it describes five. `known === 0` means there is
 * no total to show at all.
 */
export interface Sum {
  total: number;
  known: number;
  unknown: number;
}

/** One availability state present among a scope's members. */
export interface AvailabilitySlice {
  kind: AvailabilityKind;
  label: string;
  tone: Tone;
  detail: string;
  count: number;
  warn: boolean;
}

export interface AvailabilityBreakdown {
  /** Non-empty states only, most members first. */
  slices: AvailabilitySlice[];
  /** Members whose bytes are readable on this host right now. */
  usable: number;
  /** Members whose bytes have not reached this host. A dataset may legitimately
   *  cite these: on a split deploy the review happens before the pull (§12), so
   *  they are counted apart from `warn` and never presented as broken. */
  awaiting: number;
  /** Members in a state the operator should look at (missing / corrupt). */
  warn: number;
  /** Members with no capture row in the loaded catalog — nothing at all can be
   *  said about where their bytes are. */
  unresolved: number;
}

export interface DatasetAggregate {
  /** Member rows this aggregate was computed from. */
  memberCount: number;
  /** Members carrying a real task_result (only these feed success/failure). */
  labeledCount: number;
  successCount: number;
  failureCount: number;
  qualityGood: number;
  qualityNeedsReview: number;
  qualityNotUsable: number;
  qualityLabeledCount: number;
  bytes: Sum;
  messages: Sum;
  /** Distinct operators across the member captures, sorted. */
  operators: string[];
  /** Members whose capture records no operator at all. */
  operatorUnknown: number;
  availability: AvailabilityBreakdown;
  /** Newest `started_at` across the member captures (ISO), or null. */
  lastRecordedAt: string | null;
}

/** True when `a` is strictly later than `b` (both ISO8601); NaN-safe. */
function isoLater(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b; // lexical fallback
  return ta > tb;
}

function emptySum(): Sum {
  return { total: 0, known: 0, unknown: 0 };
}

function addTo(sum: Sum, value: number | null | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    sum.total += value;
    sum.known++;
  } else {
    sum.unknown++;
  }
}

/** Fold the members' availability into ranked slices (most members first, kind
 *  as the deterministic tiebreak so the order never flickers). */
function collectAvailability(rows: MemberRow[]): AvailabilityBreakdown {
  const byKind = new Map<AvailabilityKind, AvailabilitySlice>();
  let usable = 0;
  let awaiting = 0;
  let warn = 0;
  let unresolved = 0;
  for (const row of rows) {
    if (!row.capture) {
      unresolved++;
      continue;
    }
    const availability = availabilityOf(row.capture);
    const slice = byKind.get(availability.kind);
    if (slice) slice.count++;
    else
      byKind.set(availability.kind, {
        kind: availability.kind,
        label: availability.label,
        tone: availability.tone,
        detail: availability.detail,
        count: 1,
        warn: availability.warn,
      });
    if (availability.usable) usable++;
    if (availability.kind === 'awaiting_transfer') awaiting++;
    if (availability.warn) warn++;
  }
  const slices = [...byKind.values()].sort(
    (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
  );
  return { slices, usable, awaiting, warn, unresolved };
}

export function aggregate(rows: MemberRow[]): DatasetAggregate {
  let labeledCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let qualityGood = 0;
  let qualityNeedsReview = 0;
  let qualityNotUsable = 0;
  let operatorUnknown = 0;
  let lastRecordedAt: string | null = null;
  const bytes = emptySum();
  const messages = emptySum();
  const operators = new Set<string>();

  for (const row of rows) {
    const capture = row.capture;
    if (!capture) continue;
    if (capture.task_result === 'success') {
      successCount++;
      labeledCount++;
    } else if (capture.task_result === 'failure') {
      failureCount++;
      labeledCount++;
    }
    if (capture.quality === 'good') qualityGood++;
    else if (capture.quality === 'needs_review') qualityNeedsReview++;
    else if (capture.quality === 'not_usable') qualityNotUsable++;
    addTo(bytes, capture.bytes);
    addTo(messages, capture.message_count);
    if (capture.operator) operators.add(capture.operator);
    else operatorUnknown++;
    if (
      capture.started_at &&
      (lastRecordedAt === null || isoLater(capture.started_at, lastRecordedAt))
    ) {
      lastRecordedAt = capture.started_at;
    }
  }

  return {
    memberCount: rows.length,
    labeledCount,
    successCount,
    failureCount,
    qualityGood,
    qualityNeedsReview,
    qualityNotUsable,
    qualityLabeledCount: qualityGood + qualityNeedsReview + qualityNotUsable,
    bytes,
    messages,
    operators: [...operators].sort(),
    operatorUnknown,
    availability: collectAvailability(rows),
    lastRecordedAt,
  };
}

/** Success/failure breakdown for a scope summary: the rate is over LABELED
 *  members only, and unlabeled ones are surfaced separately — never folded into
 *  the denominator or counted as successes. `successRate` is null when nothing
 *  is labeled, so the UI shows an honest note instead of a fabricated 0%. */
export interface OutcomeBreakdown {
  labeled: number;
  success: number;
  failure: number;
  /** success / labeled in 0..1, or null when labeled === 0. */
  successRate: number | null;
  /** Members with no task_result (excluded from the rate). */
  unlabeled: number;
}

export function outcomeBreakdown(agg: DatasetAggregate): OutcomeBreakdown {
  const labeled = agg.labeledCount;
  return {
    labeled,
    success: agg.successCount,
    failure: agg.failureCount,
    successRate: labeled > 0 ? agg.successCount / labeled : null,
    unlabeled: agg.memberCount - labeled,
  };
}

// ---- the dataset list ----------------------------------------------------

/** One row of the left column: a dataset plus everything derivable about it. */
export interface DatasetRow {
  dataset: Dataset;
  /** Members this view could resolve, ascending by display_index. */
  members: MemberRow[];
  /** Members the server counts but this view cannot describe: `member_count`
   *  minus what was joined, plus any joined row with no capture. Surfaced as
   *  its own figure, because folding it into the totals would present a
   *  partial dataset as a complete one. */
  unresolved: number;
  aggregate: DatasetAggregate;
}

export function buildDatasetRow(dataset: Dataset, members: MemberRow[]): DatasetRow {
  const agg = aggregate(members);
  // Negative would mean the capture list is ahead of the dataset list; the two
  // reconcile on the next refetch, so clamp rather than render a negative gap.
  const unjoined = Math.max(0, dataset.member_count - members.length);
  return {
    dataset,
    members,
    unresolved: unjoined + agg.availability.unresolved,
    aggregate: agg,
  };
}

function compareRecent(a: Dataset, b: Dataset): number {
  const va = a.created_at ? Date.parse(a.created_at) : NaN;
  const vb = b.created_at ? Date.parse(b.created_at) : NaN;
  const na = Number.isNaN(va) ? -Infinity : va;
  const nb = Number.isNaN(vb) ? -Infinity : vb;
  return nb - na; // newest first
}

export function buildDatasetRows(
  datasets: Dataset[],
  membersByDatasetId: Map<string, MemberRow[]>,
  sort: SortMode,
): DatasetRow[] {
  return datasets
    .map((dataset) =>
      buildDatasetRow(dataset, membersByDatasetId.get(dataset.dataset_id) ?? []),
    )
    .sort((a, b) => {
      if (sort === 'alpha') {
        return (
          a.dataset.name.localeCompare(b.dataset.name) ||
          a.dataset.dataset_id.localeCompare(b.dataset.dataset_id)
        );
      }
      return (
        compareRecent(a.dataset, b.dataset) ||
        a.dataset.name.localeCompare(b.dataset.name)
      );
    });
}

/** Locate a row by dataset_id (null when the search/filters hid it). */
export function findDataset(rows: DatasetRow[], datasetId: string | null): DatasetRow | null {
  if (!datasetId) return null;
  return rows.find((r) => r.dataset.dataset_id === datasetId) ?? null;
}

// ---- search + facets -----------------------------------------------------

/**
 * Per-row lowercase haystacks, built ONCE per data change rather than per
 * keystroke. Rebuilding them inside the predicate re-allocated, joined and
 * lowercased a string for every row on every character typed; at catalog scale
 * that put the UI more than a tenth of a second behind a typist. The strings are
 * keyed by identity, so refetched data simply builds fresh ones.
 */
const _datasetHay = new WeakMap<Dataset, string>();
const _memberHay = new WeakMap<MemberRow, string>();

function haystack<K extends object>(
  cache: WeakMap<K, string>,
  key: K,
  parts: () => (string | null | undefined)[],
): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const built = parts()
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' ')
    .toLowerCase();
  cache.set(key, built);
  return built;
}

/** `#6` and `6` must both match a display number, so queries are tried both
 *  ways. */
function matches(hay: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const qStripped = q.startsWith('#') ? q.slice(1) : q;
  return hay.includes(q) || hay.includes(qStripped);
}

/** Case-insensitive substring search over a dataset's name / operator / task. */
export function datasetMatchesSearch(row: DatasetRow, query: string): boolean {
  if (!query.trim()) return true;
  const hay = haystack(_datasetHay, row.dataset, () => [
    row.dataset.name,
    row.dataset.operator,
    row.dataset.task,
  ]);
  return matches(hay, query);
}

/** Member-row search inside the center pane (distinct from the list search):
 *  the display number, the capture id, the run id, the operator, the task and
 *  the failure reason — the fields you reach for to find one take. */
export function memberMatchesSearch(row: MemberRow, query: string): boolean {
  if (!query.trim()) return true;
  const hay = haystack(_memberHay, row, () => [
    `#${row.displayIndex}`,
    String(row.displayIndex),
    row.captureId,
    row.capture?.run_id,
    row.capture?.operator,
    row.capture?.task,
    row.capture?.failure_reason,
  ]);
  return matches(hay, query);
}

export function memberMatchesFacets(
  row: MemberRow,
  taskResultFilter: TaskResultFilter,
  operatorFilter: string,
): boolean {
  // A member with no capture, or with no label, cannot answer a predicate about
  // one — it passes only the unfiltered choice, and is never counted as an
  // implicit success or as belonging to whoever is selected.
  const okResult =
    taskResultFilter === 'all' || row.capture?.task_result === taskResultFilter;
  const okOperator =
    operatorFilter === ANY_OPERATOR || row.capture?.operator === operatorFilter;
  return okResult && okOperator;
}

export interface MemberFilter {
  search: string;
  taskResultFilter: TaskResultFilter;
  operatorFilter: string;
}

export function filterMembers(rows: MemberRow[], f: MemberFilter): MemberRow[] {
  return rows.filter(
    (row) =>
      memberMatchesSearch(row, f.search) &&
      memberMatchesFacets(row, f.taskResultFilter, f.operatorFilter),
  );
}

/** Distinct operators across the loaded captures (facet dropdown choices).
 *  Captures with no operator contribute nothing: there is no name to offer. */
export function distinctOperators(captures: CaptureListItem[]): string[] {
  const ops = new Set<string>();
  for (const c of captures) if (c.operator) ops.add(c.operator);
  return [...ops].sort();
}

// ---- aggregate summary line (honest, testable) ---------------------------

export interface SummarySegment {
  text: string;
  /** Optional tooltip (e.g. spelling out ✓/✗ for accessibility). */
  title?: string;
  /** Render as a warning (amber) rather than muted body text. */
  warn?: boolean;
}

/** Operator stays visible on every dataset row: the single operator's name, or
 *  "N operators". */
export function operatorSegment(agg: DatasetAggregate): SummarySegment {
  const n = agg.operators.length;
  if (n === 0) {
    return agg.operatorUnknown > 0
      ? { text: 'operator not recorded' }
      : { text: 'no operator' };
  }
  if (n === 1 && agg.operatorUnknown === 0) return { text: agg.operators[0]! };
  const suffix = agg.operatorUnknown > 0 ? '+' : '';
  return {
    text: `${n}${suffix} operators`,
    title:
      agg.operators.join(', ') +
      (agg.operatorUnknown > 0 ? ' (+ some with no operator recorded)' : ''),
  };
}

/** The size segment, or null when nothing reported a size. `known < memberCount`
 *  is stated in the tooltip rather than hidden — the total describes only the
 *  members that answered. */
export function bytesSegment(agg: DatasetAggregate): SummarySegment | null {
  if (agg.bytes.known === 0) return null;
  return {
    text: formatBytes(agg.bytes.total),
    title:
      agg.bytes.unknown > 0
        ? `Total over the ${memberCount(agg.bytes.known)} reporting a size; ` +
          `${agg.bytes.unknown} report none.`
        : `Total over all ${memberCount(agg.bytes.known)}.`,
  };
}

/** The one-line aggregate under a dataset row. The member count is the SERVER's
 *  own `member_count`, not the number of rows we managed to join — the dataset
 *  is as big as the server says it is, and any shortfall is named separately. */
export function datasetSummarySegments(row: DatasetRow): SummarySegment[] {
  const agg = row.aggregate;
  const count = row.dataset.member_count;
  const segs: SummarySegment[] = [{ text: memberCount(count) }];
  if (agg.labeledCount > 0) {
    segs.push({
      text: `✓${agg.successCount} ✗${agg.failureCount}`,
      title: `${agg.successCount} success, ${agg.failureCount} failure`,
    });
  } else {
    segs.push({ text: 'no labels', title: 'No task-result labels on these members' });
  }
  const bytes = bytesSegment(agg);
  if (bytes) segs.push(bytes);
  const { usable, awaiting, warn } = agg.availability;
  if (usable > 0) segs.push({ text: `${usable} here` });
  // Stated plainly, never as a warning: on a split deploy the bytes arrive
  // after the review, so a dataset citing a capture that has not landed yet is
  // the expected order of events (§12).
  if (awaiting > 0) {
    segs.push({
      text: `${awaiting} not here yet`,
      title:
        'These members have no local copy yet. On a split deployment the ' +
        'bytes are pulled after the review — expected, not a failure.',
    });
  }
  if (warn > 0) {
    segs.push({
      text: `${warn} need a look`,
      title: 'A member is missing or its manifest cannot be read.',
      warn: true,
    });
  }
  if (row.unresolved > 0) {
    segs.push({
      text: `${row.unresolved} not in the catalog`,
      title:
        'These members are counted by the server but no capture row was ' +
        'loaded for them, so nothing above describes them.',
      warn: true,
    });
  }
  segs.push(operatorSegment(agg));
  if (row.dataset.created_at) {
    segs.push({ text: `created ${formatShortDate(row.dataset.created_at)}` });
  }
  return segs;
}

// ---- testids -------------------------------------------------------------
// Keyed by the stable identities of §6 — dataset_id and membership_id — so a
// selector never depends on a name, a position, or a display number.

export function datasetTestId(datasetId: string): string {
  return `dataset-row-${datasetId}`;
}

export function memberTestId(membershipId: string): string {
  return `dataset-member-${membershipId}`;
}
