// Local state for the Datasets tab (2026-07-21 IA overhaul). Fetches the real
// export catalog (GET /api/v1/datasets) and folds it CLIENT-SIDE into a
// task -> condition tree (see data.ts); owns search / sort / facet filters, the
// selected (task, condition) group + the selected episode within it, the
// selected episode's detail (GET /api/v1/datasets/{op}/{task}/{index}), the
// delete flow (DELETE, behind a confirm modal), the group-scoped manifest
// download, and the toast queue.
//
// No mock data and no fake "build progress" — see data.ts for the 2026-07-13
// directive. "+ New" / "Build dataset" only explain that recipe-based builds are
// a Phase 2 feature (no backend endpoint yet).
//
// 2026-07-26 addressability round: the addressable slice of this state (both
// searches, the facets, the sort, the selected group + episode) is seeded from
// the query string on mount and mirrored back into it on every change, so a
// view is shareable, survives a reload, and survives a tab round-trip — the
// shell unmounts this screen on a tab switch, which used to discard everything.
// See url.ts for the key contract; `replaceState` (not push) keeps a
// keystroke-by-keystroke search out of the browser's history.
//
// Two selections are stored as IDENTITY, not as objects: the group as its
// (task, condition) pair and the episode as its `dataset_dir`. Both are then
// DERIVED from the freshly loaded/filtered data, which is what lets a deep link
// restore a selection before the catalog has finished loading, and what makes a
// vanished row degrade to "nothing selected" instead of showing stale detail.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ArchiveConfig,
  DatasetArchiveResponse,
  DatasetDetail,
  DatasetEntry,
  DatasetsResponse,
  JobStatus,
} from '../../api/types';
import {
  ANY_OPERATOR,
  EPISODE_PAGE_SIZE,
  aggregate,
  buildTaskTree,
  distinctOperators,
  episodeMatchesSearch,
  filterEntries,
  findGroup,
  groupKey,
  sameDataset,
  sortEpisodes,
  type DatasetGroup,
  type GroupAggregate,
  type SortMode,
  type TaskNode,
  type TaskResultFilter,
} from './data';
import { readDatasetsUrl, writeDatasetsUrl } from './url';

export type { TaskResultFilter } from './data';

/** The scope the center's summary view describes: the selected (task, condition)
 *  group, or — when none is selected — the whole filtered catalog. */
export interface ScopeSummary {
  kind: 'group' | 'catalog';
  /** Header label ("kitchen_pick", "All datasets"). */
  label: string;
  /** The group's condition (null for a null-condition group and for catalog). */
  condition: string | null;
  aggregate: GroupAggregate;
}

export interface DatasetsState {
  /** The filtered task -> condition tree the left column renders. */
  tree: TaskNode[];
  /** Episodes surviving the active search + facets (what `tree` is built from). */
  shown: number;
  /** Total episodes before filtering (to say "showing n of m" honestly). */
  total: number;

  search: string;
  setSearch: (s: string) => void;
  sort: SortMode;
  toggleSort: () => void;

  taskResultFilter: TaskResultFilter;
  setTaskResultFilter: (f: TaskResultFilter) => void;
  operatorFilter: string;
  setOperatorFilter: (o: string) => void;
  /** Distinct operators in the catalog (facet dropdown choices). */
  operatorOptions: string[];

  /** Expanded/collapsed state of multi-condition task nodes. */
  isTaskExpanded: (task: string) => boolean;
  toggleTask: (task: string) => void;

  // Selection: a (task, condition) group, then an episode within it. The group
  // is selected BY VALUE (its task + condition), not by its composed key — the
  // key packs both into one string, which can't be split back apart for the URL
  // when a task name itself contains the separator.
  selectedGroupKey: string | null;
  selectedGroup: DatasetGroup | null;
  selectGroup: (group: DatasetGroup) => void;
  isGroupSelected: (key: string) => boolean;

  // Episode selection within the scope. selectEntry TOGGLES: clicking the
  // already-selected row (or the summary row) clears it and returns to summary.
  selected: DatasetEntry | null;
  selectEntry: (entry: DatasetEntry) => void;
  isEntrySelected: (entry: DatasetEntry) => boolean;
  /** Clear the episode selection (the pinned Summary row does this). */
  selectSummary: () => void;
  /** True when no episode is selected — the bottom pane shows the scope summary. */
  isSummaryActive: boolean;

  /** Episode-row search inside the top pane (distinct from the tree search). */
  episodeSearch: string;
  setEpisodeSearch: (s: string) => void;
  /** Every episode in the current scope (group's rows, else the filtered catalog),
   *  sorted newest-first — the denominator for "n of m" in the top pane. */
  scopeEpisodes: DatasetEntry[];
  /** scopeEpisodes narrowed by episodeSearch and CAPPED at the current render
   *  limit — the rows actually built into the DOM. */
  episodeRows: DatasetEntry[];
  /** How many episodes match in the scope before the cap (>= episodeRows.length)
   *  — the honest denominator for the table's overflow line. */
  episodeMatchCount: number;
  /** True when the cap is holding matches back (the overflow line shows). */
  hasMoreEpisodes: boolean;
  /** How many more rows the next "show more" would build. */
  nextPageSize: number;
  /** Raise the cap by one more page. */
  showMoreEpisodes: () => void;
  /** The summary the bottom pane shows when no episode is selected. */
  scope: ScopeSummary;

  detail: DatasetDetail | null;
  detailLoading: boolean;
  detailError: boolean;

  /** Rows the manifest will export: the selected group's rows when one is
   *  selected, else every filtered row. */
  manifestCount: number;
  downloadManifest: () => void;

  isLoading: boolean;
  isError: boolean;

  confirmingDelete: boolean;
  requestDelete: () => void;
  cancelDelete: () => void;
  confirmDelete: () => void;
  deleting: boolean;
  deleteError: Error | null;
  /** Free-text reason kept in the lifecycle ledger (optional, both flows). */
  departureReason: string;
  setDepartureReason: (s: string) => void;

  // ---- archive ----------------------------------------------------------
  // Archiving copies the dataset to an allow-listed path, verifies it, and
  // only then removes it here. `archiveEnabled` is false when the deployment
  // set no roots — the control is then not rendered at all.
  archiveEnabled: boolean;
  archiveRoots: string[];
  archiving: boolean;
  archiveOpen: boolean;
  openArchive: () => void;
  cancelArchive: () => void;
  /** Chosen root (defaults to the first) + the subpath under it. */
  archiveRoot: string;
  setArchiveRoot: (root: string) => void;
  archiveSubpath: string;
  setArchiveSubpath: (path: string) => void;
  /** The absolute destination the two fields add up to (shown before sending). */
  archiveDestination: string;
  confirmArchive: () => void;
  archiveError: Error | null;
  /** Terminal state of the running archive job, or null when none is running. */
  archiveJobState: string | null;

  toast: string;
  toastNewDataset: () => void;
  toastBuild: () => void;
}

const TOAST_MS = 2400;

/** Job states that end the archive poll (mirrors features/inspect's TERMINAL). */
const ARCHIVE_TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

/** A selected group's identity: the (task, condition) pair itself, kept apart
 *  from the composed `groupKey` string so each half survives a URL round-trip
 *  (the key packs both into one string and a task name may contain the
 *  separator, so the key alone cannot be split back apart). */
interface GroupId {
  task: string;
  condition: string | null;
}

export function useDatasetsState(): DatasetsState {
  const queryClient = useQueryClient();
  // Seed every addressable field from the query string ONCE — this is what a
  // deep link, a reload, and a return to the tab (the shell unmounts this
  // screen on a tab switch) all restore from.
  const [seed] = useState(() => readDatasetsUrl(window.location.search));

  const [selectedGroupId, setSelectedGroupId] = useState<GroupId | null>(
    seed.task !== null ? { task: seed.task, condition: seed.condition } : null,
  );
  // Raw click state, held as IDENTITY (`dataset_dir`) rather than as the row
  // object, so a deep link can carry it before the catalog has loaded.
  // `selectedEntry` resolves it against the loaded rows; `selected` below is
  // that reconciled against the filter.
  const [selectedDir, setSelectedDir] = useState<string | null>(seed.datasetDir);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [departureReason, setDepartureReason] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveRoot, setArchiveRoot] = useState('');
  const [archiveSubpath, setArchiveSubpath] = useState('');
  const [archiveJobId, setArchiveJobId] = useState<string | null>(null);
  const [archiveJobState, setArchiveJobState] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [search, setSearch] = useState(seed.search);
  const [episodeSearch, setEpisodeSearch] = useState(seed.episodeSearch);
  const [sort, setSort] = useState<SortMode>(seed.sort);
  const [taskResultFilter, setTaskResultFilter] = useState<TaskResultFilter>(
    seed.taskResultFilter,
  );
  const [operatorFilter, setOperatorFilter] = useState<string>(seed.operatorFilter);
  // A restored group under a multi-condition task must arrive EXPANDED, or its
  // selected child row would be invisible inside a collapsed task.
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set(seed.task !== null ? [seed.task] : []),
  );
  // How many episode rows the center table may build right now — see
  // EPISODE_PAGE_SIZE (the default scope is the WHOLE filtered catalog).
  const [rowLimit, setRowLimit] = useState(EPISODE_PAGE_SIZE);

  const selectedGroupKey = selectedGroupId
    ? groupKey(selectedGroupId.task, selectedGroupId.condition)
    : null;

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
  });
  const datasets = useMemo(() => listQuery.data?.datasets ?? [], [listQuery.data]);

  // Resolve the raw click identity against the loaded catalog. A dir that no
  // longer exists (deleted, or a shared link that outlived its export) resolves
  // to null — the tab degrades to its summary instead of showing a phantom row.
  const selectedEntry = useMemo(
    () => datasets.find((entry) => entry.dataset_dir === selectedDir) ?? null,
    [datasets, selectedDir],
  );

  const operatorOptions = useMemo(() => distinctOperators(datasets), [datasets]);

  const filtered = useMemo(
    () => filterEntries(datasets, { search, taskResultFilter, operatorFilter }),
    [datasets, search, taskResultFilter, operatorFilter],
  );
  const tree = useMemo(() => buildTaskTree(filtered, sort), [filtered, sort]);

  // The selected group is DERIVED from the current tree, so a filter/search that
  // hides it degrades honestly (selectedGroup becomes null -> the center says so)
  // rather than showing stale rows.
  const selectedGroup = useMemo(
    () => findGroup(tree, selectedGroupKey),
    [tree, selectedGroupKey],
  );

  // The selected EPISODE is derived the same way, and for a sharper reason than
  // stale rows: the detail pane carries a live Delete. Without this, narrowing
  // the catalog left that Delete bound to an episode the list no longer shows —
  // the operator reads "quickcheck-smoke, 1 episode" on screen and deletes
  // something else entirely. A filter must never leave a destructive control
  // pointed at an off-screen target.
  const selected = useMemo(
    () =>
      selectedEntry &&
      filtered.some((entry) => sameDataset(entry, selectedEntry)) &&
      (!selectedGroup ||
        selectedGroup.entries.some((entry) => sameDataset(entry, selectedEntry)))
        ? selectedEntry
        : null,
    [selectedEntry, filtered, selectedGroup],
  );

  const selectGroup = useCallback((group: DatasetGroup) => {
    setSelectedGroupId({ task: group.task, condition: group.condition });
    setSelectedDir(null); // switching groups clears the episode selection
    setEpisodeSearch(''); // and its one-shot episode search
  }, []);

  // Toggle: clicking the already-selected episode clears it (back to summary).
  const selectEntry = useCallback((entry: DatasetEntry) => {
    setSelectedDir((cur) => (cur === entry.dataset_dir ? null : entry.dataset_dir));
  }, []);
  const selectSummary = useCallback(() => setSelectedDir(null), []);

  // Scope for the top-pane episode list + the bottom-pane summary: the selected
  // group, else the whole filtered catalog (this replaces the old "no group
  // selected" empty state with a useful whole-catalog overview).
  const scopeEpisodes = useMemo(
    () => (selectedGroup ? selectedGroup.entries : sortEpisodes(filtered)),
    [selectedGroup, filtered],
  );
  const scopeAggregate = useMemo(
    () => (selectedGroup ? selectedGroup.aggregate : aggregate(filtered)),
    [selectedGroup, filtered],
  );
  const scope: ScopeSummary = useMemo(
    () =>
      selectedGroup
        ? {
            kind: 'group',
            label:
              selectedGroup.task === 'unknown_task'
                ? 'task not recorded'
                : selectedGroup.task,
            condition: selectedGroup.condition,
            aggregate: scopeAggregate,
          }
        : { kind: 'catalog', label: 'All datasets', condition: null, aggregate: scopeAggregate },
    [selectedGroup, scopeAggregate],
  );
  const matchedEpisodes = useMemo(
    () => scopeEpisodes.filter((e) => episodeMatchesSearch(e, episodeSearch)),
    [scopeEpisodes, episodeSearch],
  );
  // Anything that changes WHICH episodes are on screen restarts at page one —
  // otherwise a limit raised to see the tail of one group would silently rebuild
  // the next group at that size.
  useEffect(() => {
    setRowLimit(EPISODE_PAGE_SIZE);
  }, [selectedGroupKey, episodeSearch, search, taskResultFilter, operatorFilter]);
  const episodeRows = useMemo(
    () =>
      matchedEpisodes.length > rowLimit ? matchedEpisodes.slice(0, rowLimit) : matchedEpisodes,
    [matchedEpisodes, rowLimit],
  );
  const showMoreEpisodes = useCallback(
    () => setRowLimit((limit) => limit + EPISODE_PAGE_SIZE),
    [],
  );

  const toggleTask = useCallback((task: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(task)) next.delete(task);
      else next.add(task);
      return next;
    });
  }, []);

  const toggleSort = useCallback(
    () => setSort((s) => (s === 'recent' ? 'alpha' : 'recent')),
    [],
  );

  // Mirror the addressable state back into the query string, so the view is
  // shareable, survives a reload, and is still there after a tab round-trip.
  // `replaceState` (not push) — a search box typed character by character must
  // not fill the history stack. `tab` / `solo` are carried through untouched:
  // they belong to the shell, which likewise rebuilds the query string from
  // window.location.search and so preserves these keys in return.
  //
  // The episode is written from the STORED identity rather than the resolved
  // row, so a deep link isn't erased by the catalog still loading (or by a
  // filter that is temporarily hiding the row).
  useEffect(() => {
    const current = window.location.search;
    const next = writeDatasetsUrl(current, {
      search,
      episodeSearch,
      sort,
      taskResultFilter,
      operatorFilter,
      task: selectedGroupId?.task ?? null,
      condition: selectedGroupId?.condition ?? null,
      datasetDir: selectedDir,
    });
    if (next === current.replace(/^\?/, '')) return;
    window.history.replaceState(
      null,
      '',
      next ? `${window.location.pathname}?${next}` : window.location.pathname,
    );
  }, [
    search,
    episodeSearch,
    sort,
    taskResultFilter,
    operatorFilter,
    selectedGroupId,
    selectedDir,
  ]);

  // Manifest scope: the selected group's rows, else every filtered row.
  const manifestRows = selectedGroup ? selectedGroup.entries : filtered;

  const downloadManifest = useCallback(() => {
    const manifest = {
      generated_at: new Date().toISOString(),
      filter: {
        search: search || null,
        task_result: taskResultFilter,
        operator: operatorFilter === ANY_OPERATOR ? null : operatorFilter,
        group: selectedGroup
          ? { task: selectedGroup.task, condition: selectedGroup.condition }
          : null,
      },
      count: manifestRows.length,
      episodes: manifestRows.map((d) => ({
        // data_dir-relative path (portable across machines/mounts).
        path: `${d.operator}/${d.task}/${d.index}`,
        run_id: d.run_id ?? null,
        task_result: d.task_result ?? null,
        failure_reason: d.failure_reason ?? null,
        quality: d.quality ?? null,
        review_status: d.review_status ?? null,
        condition: d.condition ?? null,
        // batch_id stays in the manifest (ML-facing, per 2026-07-14 decision).
        batch_id: d.batch_id ?? null,
        batch_seq: d.batch_seq ?? null,
        index_in_batch: d.index_in_batch ?? null,
        exported_at: d.exported_at ?? null,
        bytes: d.bytes ?? null,
        message_count: d.message_count ?? null,
      })),
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kairos-manifest-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Manifest downloaded — ${manifestRows.length} episode(s)`);
  }, [
    manifestRows,
    selectedGroup,
    search,
    taskResultFilter,
    operatorFilter,
    showToast,
  ]);

  const detailQuery = useQuery({
    queryKey: queryKeys.dataset(
      selected?.operator ?? '',
      selected?.task ?? '',
      selected?.index ?? '',
    ),
    queryFn: ({ signal }) =>
      apiGet<DatasetDetail>(
        `/datasets/${encodeURIComponent(selected?.operator ?? '')}/${encodeURIComponent(
          selected?.task ?? '',
        )}/${encodeURIComponent(selected?.index ?? '')}`,
        { signal },
      ),
    enabled: selected !== null,
  });

  // Capability first: with no roots configured the archive control never
  // renders (honesty rule — do not offer what cannot run).
  const archiveConfigQuery = useQuery({
    queryKey: queryKeys.archiveConfig,
    queryFn: ({ signal }) => apiGet<ArchiveConfig>('/datasets/archive/config', { signal }),
  });
  const archiveRoots = useMemo(
    () => archiveConfigQuery.data?.roots ?? [],
    [archiveConfigQuery.data],
  );
  const archiveEnabled = (archiveConfigQuery.data?.enabled ?? false) && archiveRoots.length > 0;

  const effectiveRoot = archiveRoot || archiveRoots[0] || '';
  // Default subpath mirrors the catalog layout, so an archive tree stays
  // navigable by the same <operator>/<task>/<NNN> coordinates.
  const defaultSubpath = selected
    ? `${selected.operator}/${selected.task}/${selected.index}`
    : '';
  const subpath = archiveSubpath || defaultSubpath;
  const archiveDestination = effectiveRoot
    ? `${effectiveRoot.replace(/\/+$/, '')}/${subpath.replace(/^\/+/, '')}`
    : '';

  const archiveMutation = useMutation({
    mutationFn: (entry: DatasetEntry) =>
      apiPost<DatasetArchiveResponse>(
        `/datasets/${encodeURIComponent(entry.operator)}/${encodeURIComponent(
          entry.task,
        )}/${encodeURIComponent(entry.index)}/archive`,
        { destination: archiveDestination, reason: departureReason || null },
      ),
    onSuccess: (res) => {
      setArchiveJobId(res.job_id);
      setArchiveOpen(false);
      showToast('Archiving — copying, then verifying before anything is removed');
    },
  });

  // Poll the copy job. The dataset only leaves the catalog once the job has
  // SUCCEEDED, so the list is refetched then and not before.
  useQuery({
    queryKey: queryKeys.job(archiveJobId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(archiveJobId ?? '')}/status`, { signal }),
    enabled: archiveJobId !== null,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      if (!state || !ARCHIVE_TERMINAL.has(state)) return 1500;
      setArchiveJobState(state);
      setArchiveJobId(null);
      if (state === 'succeeded') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
        setSelectedDir(null);
        setDepartureReason('');
        showToast('Archived — verified at the destination, then removed here');
      } else {
        showToast(`Archive ${state} — the dataset is still here`);
      }
      return false;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: DatasetEntry) =>
      apiDelete(
        `/datasets/${encodeURIComponent(entry.operator)}/${encodeURIComponent(
          entry.task,
        )}/${encodeURIComponent(entry.index)}` +
          (departureReason ? `?reason=${encodeURIComponent(departureReason)}` : ''),
      ),
    onSuccess: (_data, entry) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
      queryClient.removeQueries({
        queryKey: queryKeys.dataset(entry.operator, entry.task, entry.index),
      });
      setSelectedDir(null);
      setConfirmingDelete(false);
      setDepartureReason('');
      showToast('Dataset deleted — recorded in the lifecycle ledger');
    },
  });

  return {
    tree,
    shown: filtered.length,
    total: datasets.length,
    search,
    setSearch,
    sort,
    toggleSort,
    taskResultFilter,
    setTaskResultFilter,
    operatorFilter,
    setOperatorFilter,
    operatorOptions,
    isTaskExpanded: (task) => expandedTasks.has(task),
    toggleTask,
    selectedGroupKey,
    selectedGroup,
    selectGroup,
    isGroupSelected: (key) => selectedGroupKey === key,
    selected,
    selectEntry,
    isEntrySelected: (entry) => sameDataset(selected, entry),
    selectSummary,
    isSummaryActive: selected === null,
    episodeSearch,
    setEpisodeSearch,
    scopeEpisodes,
    episodeRows,
    episodeMatchCount: matchedEpisodes.length,
    hasMoreEpisodes: matchedEpisodes.length > episodeRows.length,
    nextPageSize: Math.min(EPISODE_PAGE_SIZE, matchedEpisodes.length - episodeRows.length),
    showMoreEpisodes,
    scope,
    detail: detailQuery.data ?? null,
    detailLoading: selected !== null && detailQuery.isPending,
    detailError: selected !== null && detailQuery.isError,
    manifestCount: manifestRows.length,
    downloadManifest,
    isLoading: listQuery.isPending,
    isError: listQuery.isError,
    confirmingDelete,
    requestDelete: () => setConfirmingDelete(selected !== null),
    cancelDelete: () => setConfirmingDelete(false),
    confirmDelete: () => {
      if (selected) deleteMutation.mutate(selected);
    },
    deleting: deleteMutation.isPending,
    deleteError: deleteMutation.isError ? deleteMutation.error : null,
    departureReason,
    setDepartureReason,
    archiveEnabled,
    archiveRoots,
    archiving: archiveMutation.isPending || archiveJobId !== null,
    archiveOpen,
    openArchive: () => setArchiveOpen(selected !== null),
    cancelArchive: () => setArchiveOpen(false),
    archiveRoot: effectiveRoot,
    setArchiveRoot,
    archiveSubpath: subpath,
    setArchiveSubpath,
    archiveDestination,
    confirmArchive: () => {
      if (selected) archiveMutation.mutate(selected);
    },
    archiveError: archiveMutation.isError ? archiveMutation.error : null,
    archiveJobState,
    toast,
    toastNewDataset: () => showToast('New dataset is a Phase 2 feature'),
    toastBuild: () => showToast('Building datasets requires the Phase 2 recipe model'),
  };
}
