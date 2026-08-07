// URL <-> Datasets-tab state.
//
// The tab's selection would otherwise live only in React state inside
// DatasetsScreen, so a dataset + member could not be linked to, would not
// survive a reload, and would not survive a tab round-trip at all — the shell
// unmounts the screen on a tab switch, so coming back would reset the scope to
// "All datasets" and drop both searches and the facets.
//
// The addressable identities are the ones §6 declares stable: `dataset_id` and
// `membership_id`. Nothing here encodes a path, a name or a display number —
// a name can be edited and a display number is retired on removal, so either
// would turn a shared link into a link to something else.
//
// Everything here is a pure string <-> state mapping over the query string, so
// it stays unit-testable with no DOM. Two rules keep it safe next to the shell:
//
//   1. This module owns ONLY the `ds*` keys. It never reads or writes `tab` /
//      `solo` — those belong to src/App.tsx, which rebuilds the query string
//      from window.location.search and therefore carries our keys through a
//      tab switch untouched. That is what makes the round-trip restore work
//      without editing a shared file.
//   2. A default is written as an ABSENT key, so an untouched Datasets tab
//      leaves the URL exactly as it found it (no `?tab=datasets&dsq=&dssort=
//      recent` noise to share around).

import { ANY_OPERATOR, type SortMode, type TaskResultFilter } from './data';

export const PARAM_SEARCH = 'dsq';
export const PARAM_MEMBER_SEARCH = 'dsmq';
export const PARAM_SORT = 'dssort';
export const PARAM_RESULT = 'dsresult';
export const PARAM_OPERATOR = 'dsop';
export const PARAM_DATASET = 'dsid';
export const PARAM_MEMBER = 'dsmem';
export const PARAM_VIEW = 'dsview';

/** The addressable slice of the Datasets tab's state. */
export interface DatasetsUrlState {
  search: string;
  memberSearch: string;
  sort: SortMode;
  taskResultFilter: TaskResultFilter;
  operatorFilter: string;
  /** Which shelf the list shows: the working sets, or the archived record.
   *  Default 'active' — sealed history is opt-in viewing. */
  view: 'active' | 'archived';
  /** Selected dataset's `dataset_id`; null = nothing selected. */
  datasetId: string | null;
  /** Selected member's `membership_id`. Only meaningful when `datasetId` is
   *  non-null: a membership belongs to exactly one dataset. */
  membershipId: string | null;
}

export const DEFAULT_URL_STATE: DatasetsUrlState = {
  search: '',
  memberSearch: '',
  sort: 'recent',
  taskResultFilter: 'all',
  operatorFilter: ANY_OPERATOR,
  view: 'active',
  datasetId: null,
  membershipId: null,
};

/** Parse a query string (with or without the leading '?'). Unknown or invalid
 *  values fall back to the default rather than being trusted — a hand-edited or
 *  truncated link degrades to a sane view instead of an impossible filter. */
export function readDatasetsUrl(search: string): DatasetsUrlState {
  const p = new URLSearchParams(search);
  const sort = p.get(PARAM_SORT);
  const result = p.get(PARAM_RESULT);
  const operator = p.get(PARAM_OPERATOR);
  const datasetId = p.get(PARAM_DATASET) || null;
  const membershipId = p.get(PARAM_MEMBER) || null;
  return {
    search: p.get(PARAM_SEARCH) ?? '',
    memberSearch: p.get(PARAM_MEMBER_SEARCH) ?? '',
    sort: sort === 'alpha' ? 'alpha' : 'recent',
    taskResultFilter: result === 'success' || result === 'failure' ? result : 'all',
    operatorFilter: operator || ANY_OPERATOR,
    view: p.get(PARAM_VIEW) === 'archived' ? 'archived' : 'active',
    datasetId,
    // A membership with no dataset can't identify anything the screen can open
    // — drop it rather than half-restoring a selection that resolves to
    // nothing.
    membershipId: datasetId ? membershipId : null,
  };
}

/** Serialize `state` into `search`, preserving every key this module does not
 *  own (`tab`, `solo`, anything a sibling screen adds later). Returns the query
 *  string WITHOUT a leading '?' — empty when no key survives. */
export function writeDatasetsUrl(search: string, state: DatasetsUrlState): string {
  const p = new URLSearchParams(search);
  const set = (key: string, value: string | null) => {
    if (value) p.set(key, value);
    else p.delete(key);
  };
  set(PARAM_SEARCH, state.search.trim() ? state.search : null);
  set(PARAM_MEMBER_SEARCH, state.memberSearch.trim() ? state.memberSearch : null);
  set(PARAM_SORT, state.sort === 'alpha' ? 'alpha' : null);
  set(PARAM_RESULT, state.taskResultFilter === 'all' ? null : state.taskResultFilter);
  set(PARAM_OPERATOR, state.operatorFilter === ANY_OPERATOR ? null : state.operatorFilter);
  set(PARAM_VIEW, state.view === 'archived' ? 'archived' : null);
  set(PARAM_DATASET, state.datasetId);
  // Never emit a dangling membership — readDatasetsUrl would ignore it anyway.
  set(PARAM_MEMBER, state.datasetId ? state.membershipId : null);
  return p.toString();
}
