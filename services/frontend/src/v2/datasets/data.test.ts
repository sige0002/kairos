// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { describe, expect, test } from 'vitest';
import type { CaptureListItem, Dataset, DatasetMember, ReplicaState } from '../../api/types';
import {
  ANY_OPERATOR,
  aggregate,
  buildDatasetRow,
  buildDatasetRows,
  captureFacts,
  captureWhen,
  datasetMatchesSearch,
  candidateMatchesConditions,
  datasetSummarySegments,
  distinctOperators,
  filterMembers,
  findDataset,
  indexCaptures,
  joinMembers,
  memberMatchesFacets,
  memberMatchesSearch,
  membersByDataset,
  operatorSegment,
  outcomeBreakdown,
  type MemberRow,
} from './data';

/** A minimal finished capture; override the fields a case cares about. */
function capture(over: Partial<CaptureListItem> = {}): CaptureListItem {
  return {
    capture_id: over.capture_id ?? 'cap-1',
    state: over.state ?? 'completed',
    review_status: over.review_status ?? 'pending',
    review_revision: over.review_revision ?? 0,
    ...over,
  };
}

/** A capture whose local replica is in *state* (no replica at all = the bytes
 *  have not reached this host). */
function withReplica(c: CaptureListItem, state: ReplicaState | null): CaptureListItem {
  return {
    ...c,
    replica: state ? { instance_id: 'inst-1', state } : null,
    digest_state: state === 'present_verified' ? 'complete' : 'pending',
  };
}

function dataset(over: Partial<Dataset> = {}): Dataset {
  return {
    dataset_id: over.dataset_id ?? 'ds-1',
    name: over.name ?? 'kitchen picks',
    status: over.status ?? 'active',
    member_count: over.member_count ?? 0,
    ...over,
  };
}

function member(over: Partial<DatasetMember> = {}): DatasetMember {
  return {
    membership_id: over.membership_id ?? 'm-1',
    dataset_id: over.dataset_id ?? 'ds-1',
    capture_id: over.capture_id ?? 'cap-1',
    display_index: over.display_index ?? 1,
    ...over,
  };
}

/** A member row with a capture attached, for the aggregate cases. */
function row(displayIndex: number, c: CaptureListItem | null): MemberRow {
  return {
    membershipId: `m-${displayIndex}`,
    datasetId: 'ds-1',
    captureId: c?.capture_id ?? `missing-${displayIndex}`,
    displayIndex,
    capture: c,
  };
}

describe('joinMembers', () => {
  test('joins by capture_id and orders by display_index', () => {
    const captures = [capture({ capture_id: 'cap-a' }), capture({ capture_id: 'cap-b' })];
    const rows = joinMembers(
      [
        member({ membership_id: 'm-9', capture_id: 'cap-b', display_index: 9 }),
        member({ membership_id: 'm-2', capture_id: 'cap-a', display_index: 2 }),
      ],
      indexCaptures(captures),
    );
    expect(rows.map((r) => r.displayIndex)).toEqual([2, 9]);
    expect(rows[0]!.capture?.capture_id).toBe('cap-a');
  });

  test('a member whose capture is not in the catalog is kept, with a null capture', () => {
    // Dropping it would shrink the denominator and make every rate above it
    // look better than it is.
    const rows = joinMembers([member({ capture_id: 'gone' })], indexCaptures([]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capture).toBeNull();
    expect(rows[0]!.captureId).toBe('gone');
  });

  test('display_index is read as a label, never as a position', () => {
    // #1 and #2 were removed; the survivors keep 3 and 4 forever (§6).
    const captures = [capture({ capture_id: 'cap-c' }), capture({ capture_id: 'cap-d' })];
    const rows = joinMembers(
      [
        member({ membership_id: 'm-3', capture_id: 'cap-c', display_index: 3 }),
        member({ membership_id: 'm-4', capture_id: 'cap-d', display_index: 4 }),
      ],
      indexCaptures(captures),
    );
    expect(rows.map((r) => r.displayIndex)).toEqual([3, 4]);
  });
});

describe('membersByDataset', () => {
  test('reads each capture’s memberships, so every dataset can be summarised', () => {
    const captures = [
      capture({
        capture_id: 'cap-a',
        memberships: [
          { membership_id: 'm-1', dataset_id: 'ds-1', display_index: 1 },
          { membership_id: 'm-5', dataset_id: 'ds-2', display_index: 5 },
        ],
      }),
      capture({
        capture_id: 'cap-b',
        memberships: [{ membership_id: 'm-2', dataset_id: 'ds-1', display_index: 2 }],
      }),
      capture({ capture_id: 'cap-c' }),
    ];
    const byDataset = membersByDataset(captures);
    expect(byDataset.get('ds-1')!.map((r) => r.captureId)).toEqual(['cap-a', 'cap-b']);
    expect(byDataset.get('ds-2')!.map((r) => r.displayIndex)).toEqual([5]);
    expect(byDataset.has('ds-3')).toBe(false);
  });
});

describe('aggregate', () => {
  test('counts labels and quality over the members that carry them', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', task_result: 'success', quality: 'good' })),
      row(2, capture({ capture_id: 'b', task_result: 'failure', quality: 'not_usable' })),
      row(3, capture({ capture_id: 'c' })),
    ]);
    expect(agg.memberCount).toBe(3);
    expect(agg.labeledCount).toBe(2);
    expect(agg.successCount).toBe(1);
    expect(agg.failureCount).toBe(1);
    expect(agg.qualityGood).toBe(1);
    expect(agg.qualityNotUsable).toBe(1);
    expect(agg.qualityLabeledCount).toBe(2);
  });

  test('a total is kept beside the members that reported nothing', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', bytes: 1000, message_count: 10 })),
      row(2, capture({ capture_id: 'b' })),
    ]);
    expect(agg.bytes).toEqual({ total: 1000, known: 1, unknown: 1 });
    expect(agg.messages).toEqual({ total: 10, known: 1, unknown: 1 });
  });

  test('nothing reported means there is no total at all', () => {
    const agg = aggregate([row(1, capture()), row(2, capture({ capture_id: 'b' }))]);
    expect(agg.bytes.known).toBe(0);
    expect(agg.bytes.total).toBe(0);
  });

  test('operators are the real ones; a capture with none is counted apart', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', operator: 'op_b' })),
      row(2, capture({ capture_id: 'b', operator: 'op_a' })),
      row(3, capture({ capture_id: 'c' })),
    ]);
    expect(agg.operators).toEqual(['op_a', 'op_b']);
    expect(agg.operatorUnknown).toBe(1);
  });

  test('a member with no capture contributes to nothing but the unresolved count', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', bytes: 500, task_result: 'success' })),
      row(2, null),
    ]);
    expect(agg.memberCount).toBe(2);
    expect(agg.bytes.known).toBe(1);
    expect(agg.labeledCount).toBe(1);
    expect(agg.availability.unresolved).toBe(1);
  });
});

describe('availability breakdown', () => {
  test('a member with no local replica is "not here yet", not a fault', () => {
    // §12: on a split deploy the review precedes the pull, so a dataset citing
    // a capture that has not landed is the expected order of events.
    const agg = aggregate([
      row(1, withReplica(capture({ capture_id: 'a' }), null)),
      row(2, withReplica(capture({ capture_id: 'b' }), 'present_verified')),
    ]);
    expect(agg.availability.awaiting).toBe(1);
    expect(agg.availability.warn).toBe(0);
    expect(agg.availability.usable).toBe(1);
    expect(agg.availability.slices.map((s) => s.kind).sort()).toEqual([
      'awaiting_transfer',
      'verified',
    ]);
  });

  test('missing and corrupt are the only states that ask for a look', () => {
    const agg = aggregate([
      row(1, withReplica(capture({ capture_id: 'a' }), 'missing_unmanaged')),
      row(2, withReplica(capture({ capture_id: 'b' }), 'corrupt')),
      row(3, withReplica(capture({ capture_id: 'c' }), 'absent_managed')),
    ]);
    expect(agg.availability.warn).toBe(2);
    expect(agg.availability.usable).toBe(0);
    expect(agg.availability.awaiting).toBe(0);
  });

  test('slices are ranked by how many members are in each state', () => {
    const agg = aggregate([
      row(1, withReplica(capture({ capture_id: 'a' }), 'present_verified')),
      row(2, withReplica(capture({ capture_id: 'b' }), 'present_verified')),
      row(3, withReplica(capture({ capture_id: 'c' }), 'trashed')),
    ]);
    expect(agg.availability.slices[0]).toMatchObject({ kind: 'verified', count: 2 });
    expect(agg.availability.slices[1]).toMatchObject({ kind: 'trashed', count: 1 });
  });
});

describe('outcomeBreakdown', () => {
  test('the rate is over labeled members only', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', task_result: 'success' })),
      row(2, capture({ capture_id: 'b', task_result: 'failure' })),
      row(3, capture({ capture_id: 'c' })),
    ]);
    const out = outcomeBreakdown(agg);
    expect(out.labeled).toBe(2);
    expect(out.successRate).toBe(0.5);
    expect(out.unlabeled).toBe(1);
  });

  test('no labels gives a null rate, never a fabricated 0%', () => {
    const out = outcomeBreakdown(aggregate([row(1, capture())]));
    expect(out.successRate).toBeNull();
    expect(out.labeled).toBe(0);
  });
});

describe('buildDatasetRow', () => {
  test('the server’s member_count is the authority; the shortfall is named', () => {
    const ds = dataset({ member_count: 5 });
    const built = buildDatasetRow(ds, [row(1, capture()), row(2, capture({ capture_id: 'b' }))]);
    expect(built.dataset.member_count).toBe(5);
    expect(built.aggregate.memberCount).toBe(2);
    expect(built.unresolved).toBe(3);
  });

  test('a capture list ahead of the dataset list never shows a negative gap', () => {
    const built = buildDatasetRow(dataset({ member_count: 1 }), [
      row(1, capture()),
      row(2, capture({ capture_id: 'b' })),
    ]);
    expect(built.unresolved).toBe(0);
  });

  test('an unjoinable member and a missing row both count as unresolved', () => {
    const built = buildDatasetRow(dataset({ member_count: 3 }), [row(1, capture()), row(2, null)]);
    expect(built.unresolved).toBe(2); // one never listed + one with no capture
  });
});

describe('buildDatasetRows', () => {
  const a = dataset({ dataset_id: 'ds-a', name: 'alpha', created_at: '2026-07-20T10:00:00Z' });
  const b = dataset({ dataset_id: 'ds-b', name: 'zulu', created_at: '2026-07-22T10:00:00Z' });
  const c = dataset({ dataset_id: 'ds-c', name: 'mike' });

  test('recent puts the newest first and a dataset with no date last', () => {
    const rows = buildDatasetRows([a, b, c], new Map(), 'recent');
    expect(rows.map((r) => r.dataset.dataset_id)).toEqual(['ds-b', 'ds-a', 'ds-c']);
  });

  test('alpha sorts by name', () => {
    const rows = buildDatasetRows([b, c, a], new Map(), 'alpha');
    expect(rows.map((r) => r.dataset.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  test('findDataset locates a row by dataset_id, and null when it is not there', () => {
    const rows = buildDatasetRows([a, b], new Map(), 'alpha');
    expect(findDataset(rows, 'ds-b')!.dataset.name).toBe('zulu');
    expect(findDataset(rows, 'ds-gone')).toBeNull();
    expect(findDataset(rows, null)).toBeNull();
  });
});

describe('search + facets', () => {
  const built = buildDatasetRow(
    dataset({ name: 'kitchen picks', operator: 'op_a', task: 'pick_place' }),
    [],
  );

  test('a dataset matches on its name, operator or task, case-insensitively', () => {
    expect(datasetMatchesSearch(built, 'KITCHEN')).toBe(true);
    expect(datasetMatchesSearch(built, 'op_a')).toBe(true);
    expect(datasetMatchesSearch(built, 'pick')).toBe(true);
    expect(datasetMatchesSearch(built, 'shelf')).toBe(false);
    expect(datasetMatchesSearch(built, '   ')).toBe(true); // blank matches all
  });

  test("candidate conditions support fielded AND and OR matching", () => {
    const candidate = capture({
      capture_id: "cap-abc",
      run_id: "run_20260721_090000",
      operator: "Alice",
      task: "Pick and Place",
      task_result: "success",
    });
    const operator = {
      id: 1,
      field: "operator" as const,
      operator: "equals" as const,
      value: "alice",
    };
    const task = {
      id: 2,
      field: "task" as const,
      operator: "contains" as const,
      value: "place",
    };
    const failure = {
      id: 3,
      field: "task_result" as const,
      operator: "equals" as const,
      value: "failure",
    };

    expect(candidateMatchesConditions(candidate, [operator, task], "and")).toBe(
      true,
    );
    expect(
      candidateMatchesConditions(candidate, [operator, failure], "and"),
    ).toBe(false);
    expect(candidateMatchesConditions(candidate, [failure, task], "or")).toBe(
      true,
    );
    expect(candidateMatchesConditions(candidate, [], "and")).toBe(true);
    expect(
      candidateMatchesConditions(
        candidate,
        [
          {
            id: 4,
            field: "condition",
            operator: "contains",
            value: "left bin",
          },
        ],
        "and",
        "Object: left bin",
      ),
    ).toBe(true);
  });

  test("the any-field condition checks identifiers and labels without joining fields", () => {
    const candidate = capture({
      capture_id: "cap-abc",
      operator: "op_a",
      task: "pick_place",
    });
    expect(
      candidateMatchesConditions(
        candidate,
        [{ id: 1, field: "any", operator: "contains", value: "cap-ab" }],
        "and",
      ),
    ).toBe(true);
    expect(
      candidateMatchesConditions(
        candidate,
        [{ id: 1, field: "any", operator: "contains", value: "op_a pick" }],
        "and",
      ),
    ).toBe(false);
  });

  test("a member matches on #N, N, capture id, run id, operator and failure reason", () => {
    const r = row(
      12,
      capture({
        capture_id: 'cap-abc',
        run_id: 'run_20260721_090000',
        operator: 'op_b',
        failure_reason: 'Grasp missed',
      }),
    );
    expect(memberMatchesSearch(r, '#12')).toBe(true);
    expect(memberMatchesSearch(r, '12')).toBe(true);
    expect(memberMatchesSearch(r, 'cap-abc')).toBe(true);
    expect(memberMatchesSearch(r, '20260721')).toBe(true);
    expect(memberMatchesSearch(r, 'op_b')).toBe(true);
    expect(memberMatchesSearch(r, 'grasp')).toBe(true);
    expect(memberMatchesSearch(r, 'nope')).toBe(false);
  });

  test('an unlabeled member passes only the unfiltered choice', () => {
    const unlabeled = row(1, capture());
    expect(memberMatchesFacets(unlabeled, 'all', ANY_OPERATOR)).toBe(true);
    expect(memberMatchesFacets(unlabeled, 'success', ANY_OPERATOR)).toBe(false);
    expect(memberMatchesFacets(unlabeled, 'failure', ANY_OPERATOR)).toBe(false);
  });

  test('a member with no capture cannot answer any predicate about one', () => {
    const unresolved = row(1, null);
    expect(memberMatchesFacets(unresolved, 'all', ANY_OPERATOR)).toBe(true);
    expect(memberMatchesFacets(unresolved, 'success', ANY_OPERATOR)).toBe(false);
    expect(memberMatchesFacets(unresolved, 'all', 'op_a')).toBe(false);
  });

  test('filterMembers applies the search and both facets together', () => {
    const rows = [
      row(1, capture({ capture_id: 'a', operator: 'op_a', task_result: 'success' })),
      row(2, capture({ capture_id: 'b', operator: 'op_b', task_result: 'success' })),
      row(3, capture({ capture_id: 'c', operator: 'op_a', task_result: 'failure' })),
    ];
    const kept = filterMembers(rows, {
      search: '',
      taskResultFilter: 'success',
      operatorFilter: 'op_a',
    });
    expect(kept.map((r) => r.captureId)).toEqual(['a']);
  });

  test('distinctOperators offers only names that exist', () => {
    expect(
      distinctOperators([
        capture({ capture_id: 'a', operator: 'op_b' }),
        capture({ capture_id: 'b', operator: 'op_a' }),
        capture({ capture_id: 'c' }),
      ]),
    ).toEqual(['op_a', 'op_b']);
  });
});

describe('datasetSummarySegments', () => {
  function texts(rowsIn: MemberRow[], ds: Partial<Dataset> = {}): string[] {
    return datasetSummarySegments(
      buildDatasetRow(dataset({ member_count: rowsIn.length, ...ds }), rowsIn),
    ).map((s) => s.text);
  }

  test('an unlabeled dataset says "no labels", never a fabricated 0/0 split', () => {
    const out = texts([row(1, capture()), row(2, capture({ capture_id: 'b' }))]);
    expect(out).toContain('2 members');
    expect(out).toContain('no labels');
    expect(out.some((t) => t.includes('✓'))).toBe(false);
  });

  test('a labeled dataset states the real split', () => {
    const out = texts([
      row(1, capture({ capture_id: 'a', task_result: 'success' })),
      row(2, capture({ capture_id: 'b', task_result: 'failure' })),
    ]);
    expect(out).toContain('✓1 ✗1');
  });

  test('no member reports a size, so no size segment is shown', () => {
    const out = texts([row(1, capture())]);
    expect(out.some((t) => /GB|MB|kB| B$/.test(t))).toBe(false);
  });

  test('"not here yet" is stated plainly and is not a warning', () => {
    const segs = datasetSummarySegments(
      buildDatasetRow(dataset({ member_count: 1 }), [row(1, withReplica(capture(), null))]),
    );
    const awaiting = segs.find((s) => s.text === '1 not here yet')!;
    expect(awaiting).toBeDefined();
    expect(awaiting.warn).toBeFalsy();
  });

  test('members the catalog cannot describe are surfaced as a warning', () => {
    const segs = datasetSummarySegments(
      buildDatasetRow(dataset({ member_count: 4 }), [row(1, capture())]),
    );
    const gap = segs.find((s) => s.text === '3 not in the catalog')!;
    expect(gap).toBeDefined();
    expect(gap.warn).toBe(true);
  });
});

describe('operatorSegment', () => {
  test('one operator shows the name', () => {
    expect(operatorSegment(aggregate([row(1, capture({ operator: 'op_a' }))])).text).toBe('op_a');
  });

  test('several show a count, with a "+" when some record none', () => {
    const agg = aggregate([
      row(1, capture({ capture_id: 'a', operator: 'op_a' })),
      row(2, capture({ capture_id: 'b', operator: 'op_b' })),
      row(3, capture({ capture_id: 'c' })),
    ]);
    expect(operatorSegment(agg).text).toBe('2+ operators');
  });

  test('none recorded is said in words, not as an empty name', () => {
    expect(operatorSegment(aggregate([row(1, capture())])).text).toBe('operator not recorded');
  });
});

// A run_id alone cannot answer "which data is this?" (2026-08-03 feedback):
// same-day runs differ only in their final digits. These two are what the
// dataset rows lead with instead.
describe('capture identity for the dataset rows', () => {
  test('captureWhen includes the DATE, not just the time of day', () => {
    const when = captureWhen(capture({ started_at: '2026-07-21T09:00:00Z' }));
    // Locale-format agnostic: the day and month must both be present.
    expect(when).toMatch(/21/);
    expect(when).toMatch(/Jul/);
    expect(when).not.toBe('—');
  });

  test('captureWhen says "—" rather than inventing a time', () => {
    expect(captureWhen(capture())).toBe('—');
    expect(captureWhen(capture({ started_at: 'not-a-date' }))).toBe('—');
  });

  test('captureFacts cites task, operator, duration and size', () => {
    const facts = captureFacts(
      capture({
        task: 'pick_place',
        operator: 'op_a',
        started_at: '2026-07-21T09:00:00Z',
        ended_at: '2026-07-21T09:01:00Z',
        bytes: 1_200_000_000,
      }),
    );
    expect(facts).toBe('pick_place · op_a · 00:01:00 · 1.2 GB');
  });

  test('captureFacts drops unknowns instead of rendering dash noise', () => {
    expect(captureFacts(capture({ task: 'pick_place' }))).toBe('pick_place');
    expect(captureFacts(capture())).toBe('');
  });
});
