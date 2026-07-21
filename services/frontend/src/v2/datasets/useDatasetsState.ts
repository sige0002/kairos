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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { DatasetDetail, DatasetEntry, DatasetsResponse } from '../../api/types';
import {
  ANY_OPERATOR,
  buildTaskTree,
  distinctOperators,
  filterEntries,
  findGroup,
  sameDataset,
  type DatasetGroup,
  type SortMode,
  type TaskNode,
  type TaskResultFilter,
} from './data';

export type { TaskResultFilter } from './data';

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

  // Selection: a (task, condition) group, then an episode within it.
  selectedGroupKey: string | null;
  selectedGroup: DatasetGroup | null;
  selectGroup: (key: string) => void;
  isGroupSelected: (key: string) => boolean;

  selected: DatasetEntry | null;
  selectEntry: (entry: DatasetEntry) => void;
  isEntrySelected: (entry: DatasetEntry) => boolean;

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

  toast: string;
  toastNewDataset: () => void;
  toastBuild: () => void;
}

const TOAST_MS = 2400;

export function useDatasetsState(): DatasetsState {
  const queryClient = useQueryClient();
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<DatasetEntry | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [taskResultFilter, setTaskResultFilter] = useState<TaskResultFilter>('all');
  const [operatorFilter, setOperatorFilter] = useState<string>(ANY_OPERATOR);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

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

  const selectGroup = useCallback((key: string) => {
    setSelectedGroupKey(key);
    setSelected(null); // switching groups clears the episode selection
  }, []);

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

  const deleteMutation = useMutation({
    mutationFn: (entry: DatasetEntry) =>
      apiDelete(
        `/datasets/${encodeURIComponent(entry.operator)}/${encodeURIComponent(
          entry.task,
        )}/${encodeURIComponent(entry.index)}`,
      ),
    onSuccess: (_data, entry) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasets });
      queryClient.removeQueries({
        queryKey: queryKeys.dataset(entry.operator, entry.task, entry.index),
      });
      setSelected(null);
      setConfirmingDelete(false);
      showToast('Dataset deleted');
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
    selectEntry: setSelected,
    isEntrySelected: (entry) => sameDataset(selected, entry),
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
    toast,
    toastNewDataset: () => showToast('New dataset is a Phase 2 feature'),
    toastBuild: () => showToast('Building datasets requires the Phase 2 recipe model'),
  };
}
