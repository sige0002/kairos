// URL <-> Datasets-tab state (2026-07-26 addressability round).
//
// The tab's selection used to live only in React state inside DatasetsScreen,
// so a (task, condition) group + episode could not be linked to, did not
// survive a reload, and did not survive a tab round-trip at all — the shell
// unmounts the screen on a tab switch, so coming back reset the scope to "All
// datasets" and dropped both searches and the facets.
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
export const PARAM_EPISODE_SEARCH = 'dsepq';
export const PARAM_SORT = 'dssort';
export const PARAM_RESULT = 'dsresult';
export const PARAM_OPERATOR = 'dsop';
export const PARAM_TASK = 'dstask';
export const PARAM_CONDITION = 'dscond';
export const PARAM_EPISODE = 'dsep';

/** The addressable slice of the Datasets tab's state. */
export interface DatasetsUrlState {
  search: string;
  episodeSearch: string;
  sort: SortMode;
  taskResultFilter: TaskResultFilter;
  operatorFilter: string;
  /** Selected group's task; null = no group selected (whole-catalog scope). */
  task: string | null;
  /** Selected group's condition; null = that task's null-condition bucket.
   *  Only meaningful when `task` is non-null. */
  condition: string | null;
  /** Selected episode's `dataset_dir` (its stable identity in the catalog). */
  datasetDir: string | null;
}

export const DEFAULT_URL_STATE: DatasetsUrlState = {
  search: '',
  episodeSearch: '',
  sort: 'recent',
  taskResultFilter: 'all',
  operatorFilter: ANY_OPERATOR,
  task: null,
  condition: null,
  datasetDir: null,
};

/** Parse a query string (with or without the leading '?'). Unknown or invalid
 *  values fall back to the default rather than being trusted — a hand-edited or
 *  truncated link degrades to a sane view instead of an impossible filter. */
export function readDatasetsUrl(search: string): DatasetsUrlState {
  const p = new URLSearchParams(search);
  const sort = p.get(PARAM_SORT);
  const result = p.get(PARAM_RESULT);
  const operator = p.get(PARAM_OPERATOR);
  const task = p.get(PARAM_TASK) || null;
  const condition = p.get(PARAM_CONDITION) || null;
  return {
    search: p.get(PARAM_SEARCH) ?? '',
    episodeSearch: p.get(PARAM_EPISODE_SEARCH) ?? '',
    sort: sort === 'alpha' ? 'alpha' : 'recent',
    taskResultFilter: result === 'success' || result === 'failure' ? result : 'all',
    operatorFilter: operator || ANY_OPERATOR,
    task,
    // A condition with no task can't identify a group — drop it rather than
    // half-restoring a selection that would resolve to nothing.
    condition: task ? condition : null,
    datasetDir: p.get(PARAM_EPISODE) || null,
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
  set(PARAM_EPISODE_SEARCH, state.episodeSearch.trim() ? state.episodeSearch : null);
  set(PARAM_SORT, state.sort === 'alpha' ? 'alpha' : null);
  set(PARAM_RESULT, state.taskResultFilter === 'all' ? null : state.taskResultFilter);
  set(PARAM_OPERATOR, state.operatorFilter === ANY_OPERATOR ? null : state.operatorFilter);
  set(PARAM_TASK, state.task);
  // Never emit a dangling condition — readDatasetsUrl would ignore it anyway.
  set(PARAM_CONDITION, state.task ? state.condition : null);
  set(PARAM_EPISODE, state.datasetDir);
  return p.toString();
}
