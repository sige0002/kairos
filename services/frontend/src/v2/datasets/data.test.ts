import { describe, expect, test } from 'vitest';
import type { DatasetEntry } from '../../api/types';
import {
  ANY_OPERATOR,
  aggregate,
  buildTaskTree,
  distinctOperators,
  entryMatchesFacets,
  entryMatchesSearch,
  episodeMatchesSearch,
  filterEntries,
  findGroup,
  groupKey,
  groupSummarySegments,
  isLeafTask,
  isMixedSchema,
  isSchemaOutlier,
  majoritySchema,
  operatorSegment,
  outcomeBreakdown,
  rowEpisode,
  schemaOf,
} from './data';

/** A minimal exported-dataset row; override the fields a case cares about. */
function entry(over: Partial<DatasetEntry> = {}): DatasetEntry {
  const operator = over.operator ?? 'op_a';
  const task = over.task ?? 'pick_place';
  const index = over.index ?? '001';
  return {
    operator,
    task,
    index,
    dataset_dir: over.dataset_dir ?? `${operator}/${task}/${index}`,
    ...over,
  };
}

describe('buildTaskTree', () => {
  test('groups by task, then by condition; a single-condition task is a leaf', () => {
    const rows = [
      entry({ task: 'pick_place', condition: 'dim', index: '001' }),
      entry({ task: 'pick_place', condition: 'bright', index: '002' }),
      entry({ task: 'stack', condition: null, index: '003' }),
    ];
    const tree = buildTaskTree(rows, 'alpha');
    const pick = tree.find((n) => n.task === 'pick_place')!;
    const stack = tree.find((n) => n.task === 'stack')!;

    expect(pick.conditions.map((c) => c.condition)).toEqual(['bright', 'dim']); // alpha
    expect(isLeafTask(pick)).toBe(false); // two conditions -> collapsible

    expect(stack.conditions).toHaveLength(1);
    expect(stack.conditions[0]!.condition).toBeNull();
    expect(isLeafTask(stack)).toBe(true); // single null condition -> leaf
  });

  test('the unknown_task bucket always sorts to the bottom, either sort mode', () => {
    const rows = [
      entry({ task: 'unknown_task', operator: 'unknown_operator', index: '001' }),
      entry({ task: 'aaa_first', index: '002', exported_at: '2026-07-01T00:00:00Z' }),
      entry({ task: 'zzz_last', index: '003', exported_at: '2026-07-20T00:00:00Z' }),
    ];
    for (const sort of ['recent', 'alpha'] as const) {
      const tree = buildTaskTree(rows, sort);
      expect(tree[tree.length - 1]!.task).toBe('unknown_task');
      expect(tree[tree.length - 1]!.isLegacy).toBe(true);
    }
  });

  test('recent sort orders tasks by newest export; alpha sort by name', () => {
    const rows = [
      entry({ task: 'older', index: '001', exported_at: '2026-07-01T00:00:00Z' }),
      entry({ task: 'newer', index: '002', exported_at: '2026-07-20T00:00:00Z' }),
    ];
    expect(buildTaskTree(rows, 'recent').map((n) => n.task)).toEqual(['newer', 'older']);
    expect(buildTaskTree(rows, 'alpha').map((n) => n.task)).toEqual(['newer', 'older']); // n<o
  });

  test('a group key round-trips through findGroup', () => {
    const rows = [entry({ task: 'stack', condition: 'dim' })];
    const tree = buildTaskTree(rows, 'alpha');
    const key = groupKey('stack', 'dim');
    expect(findGroup(tree, key)?.condition).toBe('dim');
    expect(findGroup(tree, 'nope')).toBeNull();
    expect(findGroup(tree, null)).toBeNull();
  });
});

describe('aggregate', () => {
  test('counts episodes, distinct sets, labeled success/failure, bytes, last export', () => {
    const rows = [
      entry({
        index: '001',
        task_result: 'success',
        quality: 'good',
        batch_id: 'b1',
        batch_seq: 1,
        bytes: 1_000_000_000,
        exported_at: '2026-07-01T00:00:00Z',
      }),
      entry({
        index: '002',
        task_result: 'failure',
        quality: 'good',
        batch_id: 'b1',
        batch_seq: 1,
        bytes: 500_000_000,
        exported_at: '2026-07-05T00:00:00Z',
      }),
      // Unlabeled row (pre-label export): counted as an episode, NOT a success.
      entry({ index: '003', batch_id: 'b2', batch_seq: 2, bytes: 200_000_000 }),
    ];
    const agg = aggregate(rows);
    expect(agg.episodeCount).toBe(3);
    expect(agg.setCount).toBe(2); // b1, b2
    expect(agg.labeledCount).toBe(2);
    expect(agg.successCount).toBe(1);
    expect(agg.failureCount).toBe(1);
    expect(agg.totalBytes).toBe(1_700_000_000);
    expect(agg.lastExportedAt).toBe('2026-07-05T00:00:00Z');
  });

  test('distinct operators exclude the unknown sentinel but flag it', () => {
    const agg = aggregate([
      entry({ operator: 'op_a' }),
      entry({ operator: 'op_b' }),
      entry({ operator: 'op_a' }),
      entry({ operator: 'unknown_operator' }),
    ]);
    expect(agg.operators).toEqual(['op_a', 'op_b']);
    expect(agg.hasUnknownOperator).toBe(true);
  });
});

describe('entryMatchesSearch', () => {
  const row = entry({
    task: 'kitchen_pick',
    condition: 'dim-light',
    operator: 'alice',
    index: '017',
    batch_seq: 6,
  });

  test('matches task / condition / operator / index substrings, case-insensitively', () => {
    expect(entryMatchesSearch(row, 'KITCHEN')).toBe(true);
    expect(entryMatchesSearch(row, 'dim')).toBe(true);
    expect(entryMatchesSearch(row, 'ali')).toBe(true);
    expect(entryMatchesSearch(row, '017')).toBe(true);
    expect(entryMatchesSearch(row, 'shelf')).toBe(false);
  });

  test('matches a batch seq with or without the leading #', () => {
    expect(entryMatchesSearch(row, '6')).toBe(true);
    expect(entryMatchesSearch(row, '#6')).toBe(true);
    expect(entryMatchesSearch(row, '#9')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(entryMatchesSearch(row, '')).toBe(true);
    expect(entryMatchesSearch(row, '   ')).toBe(true);
  });
});

describe('facets', () => {
  test('task-result facet: an unlabeled row only passes "all"', () => {
    const labeled = entry({ task_result: 'failure' });
    const unlabeled = entry({});
    expect(entryMatchesFacets(labeled, 'failure', ANY_OPERATOR)).toBe(true);
    expect(entryMatchesFacets(labeled, 'success', ANY_OPERATOR)).toBe(false);
    expect(entryMatchesFacets(unlabeled, 'all', ANY_OPERATOR)).toBe(true);
    expect(entryMatchesFacets(unlabeled, 'success', ANY_OPERATOR)).toBe(false);
    expect(entryMatchesFacets(unlabeled, 'failure', ANY_OPERATOR)).toBe(false);
  });

  test('operator facet narrows to one operator', () => {
    const a = entry({ operator: 'op_a' });
    const b = entry({ operator: 'op_b' });
    expect(entryMatchesFacets(a, 'all', 'op_a')).toBe(true);
    expect(entryMatchesFacets(b, 'all', 'op_a')).toBe(false);
    expect(entryMatchesFacets(b, 'all', ANY_OPERATOR)).toBe(true);
  });

  test('filterEntries composes search + facets', () => {
    const rows = [
      entry({ task: 'pick', operator: 'op_a', task_result: 'success', quality: 'good', index: '1' }),
      entry({ task: 'pick', operator: 'op_b', task_result: 'failure', quality: 'good', index: '2' }),
      entry({ task: 'stack', operator: 'op_a', index: '3' }),
    ];
    const out = filterEntries(rows, {
      search: 'pick',
      taskResultFilter: 'success',
      operatorFilter: 'op_a',
    });
    expect(out.map((r) => r.index)).toEqual(['1']);
  });

  test('distinctOperators sorts the unknown sentinel last', () => {
    const ops = distinctOperators([
      entry({ operator: 'op_b' }),
      entry({ operator: 'unknown_operator' }),
      entry({ operator: 'op_a' }),
    ]);
    expect(ops).toEqual(['op_a', 'op_b', 'unknown_operator']);
  });
});

describe('groupSummarySegments', () => {
  test('a labeled group shows the ✓/✗ split with an accessible title', () => {
    const agg = aggregate([
      entry({ task_result: 'success', quality: 'good', operator: 'op_a', bytes: 1_000_000_000, exported_at: '2026-07-21T00:00:00Z', batch_seq: 1, batch_id: 'b1' }),
      entry({ task_result: 'failure', quality: 'good', operator: 'op_a', batch_seq: 1, batch_id: 'b1' }),
    ]);
    const texts = groupSummarySegments(agg).map((s) => s.text);
    expect(texts).toContain('2 eps');
    expect(texts).toContain('✓1 ✗1');
    expect(texts.some((t) => t.startsWith('last '))).toBe(true);
    const vc = groupSummarySegments(agg).find((s) => s.text === '✓1 ✗1');
    expect(vc?.title).toBe('1 success, 1 failure');
  });

  test('an all-unlabeled group shows "no labels", never a fabricated ✓0 ✗0', () => {
    const agg = aggregate([entry({ index: '1' }), entry({ index: '2' })]);
    const texts = groupSummarySegments(agg).map((s) => s.text);
    expect(texts).toContain('no labels');
    expect(texts.some((t) => t.includes('✓'))).toBe(false);
  });

  test('operatorSegment surfaces the operator name or an N-operators count', () => {
    expect(operatorSegment(aggregate([entry({ operator: 'alice' })])).text).toBe('alice');
    expect(
      operatorSegment(aggregate([entry({ operator: 'a' }), entry({ operator: 'b' })])).text,
    ).toBe('2 operators');
    expect(operatorSegment(aggregate([entry({ operator: 'unknown_operator' })])).text).toBe(
      'operator not recorded',
    );
  });
});

describe('rowEpisode', () => {
  test('adapts a labeled row to a RunEpisode; null when labels are absent', () => {
    expect(
      rowEpisode(entry({ task_result: 'success', quality: 'good', batch_seq: 4 })),
    ).toMatchObject({ task_result: 'success', quality: 'good', batch_seq: 4 });
    expect(rowEpisode(entry({}))).toBeNull();
    // A partial label (result but no quality) still yields nothing fabricated.
    expect(rowEpisode(entry({ task_result: 'success' }))).toBeNull();
  });
});

describe('aggregate — quality + totals (scope summary)', () => {
  test('tallies quality labels and sums messages, independent of task_result', () => {
    const agg = aggregate([
      entry({ quality: 'good', message_count: 10 }),
      entry({ quality: 'good', message_count: 20 }),
      entry({ quality: 'needs_review', message_count: 5 }),
      entry({ quality: 'not_usable', message_count: 1 }),
      entry({ message_count: 4 }), // no quality
    ]);
    expect(agg.qualityGood).toBe(2);
    expect(agg.qualityNeedsReview).toBe(1);
    expect(agg.qualityNotUsable).toBe(1);
    expect(agg.qualityLabeledCount).toBe(4);
    expect(agg.totalMessages).toBe(40);
  });
});

describe('outcomeBreakdown', () => {
  test('rate is over labeled rows only; unlabeled surfaced separately, never a success', () => {
    const agg = aggregate([
      entry({ task_result: 'success' }),
      entry({ task_result: 'success' }),
      entry({ task_result: 'success' }),
      entry({ task_result: 'failure' }),
      entry({}), // unlabeled
    ]);
    const o = outcomeBreakdown(agg);
    expect(o.labeled).toBe(4);
    expect(o.success).toBe(3);
    expect(o.failure).toBe(1);
    expect(o.successRate).toBeCloseTo(0.75, 5);
    expect(o.unlabeled).toBe(1);
  });

  test('successRate is null (not 0) when the scope has no labeled rows', () => {
    const o = outcomeBreakdown(aggregate([entry({}), entry({})]));
    expect(o.labeled).toBe(0);
    expect(o.successRate).toBeNull();
    expect(o.unlabeled).toBe(2);
  });
});

describe('episodeMatchesSearch', () => {
  const row = entry({
    index: '017',
    operator: 'alice',
    failure_reason: 'Grasp missed',
    batch_seq: 6,
  });

  test('matches index, operator, failure reason, and batch seq (# optional)', () => {
    expect(episodeMatchesSearch(row, '017')).toBe(true);
    expect(episodeMatchesSearch(row, 'ali')).toBe(true);
    expect(episodeMatchesSearch(row, 'grasp')).toBe(true); // case-insensitive
    expect(episodeMatchesSearch(row, '6')).toBe(true);
    expect(episodeMatchesSearch(row, '#6')).toBe(true);
    expect(episodeMatchesSearch(row, 'nope')).toBe(false);
    expect(episodeMatchesSearch(row, '')).toBe(true);
  });

  test('does NOT match on task/condition (those live in the tree search)', () => {
    const r = entry({ index: '1', task: 'kitchen_pick', condition: 'dim', operator: 'op' });
    expect(episodeMatchesSearch(r, 'kitchen')).toBe(false);
    expect(episodeMatchesSearch(r, 'dim')).toBe(false);
  });
});

// 2026-07-26 ML finding F1: a (task, condition) group held nine /hsrb/* episodes
// and two /camera/* ones — disjoint observation/action spaces shown as one
// dataset. These pin the comparison that makes the split visible.
describe('topic signature (schema)', () => {
  const HSR = 'a'.repeat(64);
  const MYROBOT = 'b'.repeat(64);

  const hsr = (index: string) =>
    entry({ index, topics_hash: HSR, topic_count: 7 });
  const myrobot = (index: string) =>
    entry({ index, topics_hash: MYROBOT, topic_count: 8 });

  test('one topic set across the rows is not flagged', () => {
    const agg = aggregate([hsr('001'), hsr('002')]);
    expect(agg.schemas).toHaveLength(1);
    expect(agg.schemas[0]).toMatchObject({ hash: HSR, label: 'A', episodeCount: 2, topicCount: 7 });
    expect(isMixedSchema(agg)).toBe(false);
    expect(isSchemaOutlier(hsr('001'), agg)).toBe(false);
  });

  test('two disjoint sets are ranked by frequency and the minority is the outlier', () => {
    const rows = [hsr('001'), hsr('002'), hsr('003'), myrobot('010'), myrobot('011')];
    const agg = aggregate(rows);

    expect(isMixedSchema(agg)).toBe(true);
    expect(agg.schemas.map((s) => [s.label, s.hash, s.episodeCount])).toEqual([
      ['A', HSR, 3],
      ['B', MYROBOT, 2],
    ]);
    // Only the minority rows are marked — the majority is the baseline.
    expect(isSchemaOutlier(rows[0]!, agg)).toBe(false);
    expect(isSchemaOutlier(rows[3]!, agg)).toBe(true);
    expect(schemaOf(rows[3]!, agg)?.label).toBe('B');
  });

  test('the label ranking is deterministic when two sets tie on episode count', () => {
    const first = aggregate([hsr('001'), myrobot('010')]).schemas.map((s) => s.hash);
    const again = aggregate([myrobot('010'), hsr('001')]).schemas.map((s) => s.hash);
    expect(first).toEqual(again); // hash tiebreak — labels never flicker
  });

  test('an unsigned row is counted apart, never treated as a set or an outlier', () => {
    const rows = [hsr('001'), entry({ index: '002' }), entry({ index: '003', topics_hash: null })];
    const agg = aggregate(rows);

    expect(agg.schemas).toHaveLength(1); // the unknowns did NOT become a set
    expect(agg.schemaUnknown).toBe(2);
    expect(isMixedSchema(agg)).toBe(false); // one known set = not a mixed scope
    expect(schemaOf(rows[1]!, agg)).toBeNull();
    expect(isSchemaOutlier(rows[1]!, agg)).toBe(false);
  });

  test('unknown-only rows leave the comparison empty rather than agreeing', () => {
    const agg = aggregate([entry({ index: '1' }), entry({ index: '2' })]);
    expect(agg.schemas).toEqual([]);
    expect(agg.schemaUnknown).toBe(2);
    expect(majoritySchema(agg)).toBeNull();
    expect(isMixedSchema(agg)).toBe(false);
  });

  test('a mixed group is called out on its list row, before it is selected', () => {
    const mixed = groupSummarySegments(aggregate([hsr('001'), myrobot('010')]));
    const seg = mixed.find((s) => s.text === '2 topic sets');
    expect(seg?.warn).toBe(true);

    const clean = groupSummarySegments(aggregate([hsr('001'), hsr('002')]));
    expect(clean.some((s) => s.text.includes('topic set'))).toBe(false);
  });
});
