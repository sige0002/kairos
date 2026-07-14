// Local state for the Datasets tab: fetches the real export catalog
// (GET /api/v1/datasets), the selected entry's detail
// (GET /api/v1/datasets/{operator}/{task}/{index}), owns the delete flow
// (DELETE /api/v1/datasets/{operator}/{task}/{index} behind a confirm modal),
// and owns the toast queue.
// No mock data and no fake "build progress" animation — see data.ts for the
// 2026-07-13 user directive that removed the fabricated PickPlace_* catalog.
// "Build dataset" and "+ New" both just explain that recipe-based builds are
// a Phase 2 feature; there is no backend endpoint for them yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { DatasetDetail, DatasetEntry, DatasetsResponse } from '../../api/types';
import { groupByOperator, sameDataset, type OperatorGroup } from './data';

export type TaskResultFilter = 'all' | 'success' | 'failure';

export interface DatasetsState {
  groups: OperatorGroup[];
  /** Rows surviving the active filters (what `groups` is built from). */
  filtered: DatasetEntry[];
  /** Total rows before filtering (to say "n of m" honestly). */
  total: number;
  taskResultFilter: TaskResultFilter;
  setTaskResultFilter: (f: TaskResultFilter) => void;
  conditionFilter: string | null;
  setConditionFilter: (c: string | null) => void;
  /** Distinct conditions present in the catalog (filter chip choices). */
  conditions: string[];
  /** Download the filtered rows as a manifest JSON (the versionable
   *  training-set definition — 2026-07-14 batch-label decision). */
  downloadManifest: () => void;
  isLoading: boolean;
  isError: boolean;
  selected: DatasetEntry | null;
  isSelected: (entry: DatasetEntry) => boolean;
  select: (entry: DatasetEntry) => void;
  detail: DatasetDetail | null;
  detailLoading: boolean;
  detailError: boolean;
  // Delete (DELETE /datasets/{op}/{task}/{index}) behind a confirm modal —
  // the same UX as the Recordings delete.
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
  const [selected, setSelected] = useState<DatasetEntry | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const datasets = listQuery.data?.datasets ?? [];

  // ---- label filters (task result / condition) -----------------------------
  // Filtering happens client-side over the catalog rows the list already has;
  // a row with NO label (pre-label export) only survives 'all' — an unlabeled
  // row must not pass a success/failure predicate it can't answer.
  const [taskResultFilter, setTaskResultFilter] = useState<TaskResultFilter>('all');
  const [conditionFilter, setConditionFilter] = useState<string | null>(null);
  const conditions = useMemo(
    () =>
      [
        ...new Set(datasets.map((d) => d.condition).filter((c): c is string => !!c)),
      ].sort(),
    [datasets],
  );
  const filtered = useMemo(
    () =>
      datasets.filter(
        (d) =>
          (taskResultFilter === 'all' || d.task_result === taskResultFilter) &&
          (conditionFilter === null || d.condition === conditionFilter),
      ),
    [datasets, taskResultFilter, conditionFilter],
  );
  const groups = useMemo(() => groupByOperator(filtered), [filtered]);

  // The manifest is the materialized filter: a versionable file that defines a
  // training set (commit it next to the training config to reproduce a run).
  const downloadManifest = useCallback(() => {
    const manifest = {
      generated_at: new Date().toISOString(),
      filter: {
        task_result: taskResultFilter,
        condition: conditionFilter,
      },
      count: filtered.length,
      episodes: filtered.map((d) => ({
        // data_dir-relative path (portable across machines/mounts).
        path: `${d.operator}/${d.task}/${d.index}`,
        run_id: d.run_id ?? null,
        task_result: d.task_result ?? null,
        failure_reason: d.failure_reason ?? null,
        quality: d.quality ?? null,
        review_status: d.review_status ?? null,
        condition: d.condition ?? null,
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
    showToast(`Manifest downloaded — ${filtered.length} episode(s)`);
  }, [filtered, taskResultFilter, conditionFilter, showToast]);

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
    groups,
    filtered,
    total: datasets.length,
    taskResultFilter,
    setTaskResultFilter,
    conditionFilter,
    setConditionFilter,
    conditions,
    downloadManifest,
    isLoading: listQuery.isPending,
    isError: listQuery.isError,
    selected,
    isSelected: (entry) => sameDataset(selected, entry),
    select: setSelected,
    detail: detailQuery.data ?? null,
    detailLoading: selected !== null && detailQuery.isPending,
    detailError: selected !== null && detailQuery.isError,
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
