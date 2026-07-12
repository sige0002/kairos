// Local state for the Datasets tab: fetches the real export catalog
// (GET /api/v1/datasets), the selected entry's detail
// (GET /api/v1/datasets/{operator}/{task}/{index}), and owns the toast queue.
// No mock data and no fake "build progress" animation — see data.ts for the
// 2026-07-13 user directive that removed the fabricated PickPlace_* catalog.
// "Build dataset" and "+ New" both just explain that recipe-based builds are
// a Phase 2 feature; there is no backend endpoint for them yet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { DatasetDetail, DatasetEntry, DatasetsResponse } from '../../api/types';
import { groupByOperator, sameDataset, type OperatorGroup } from './data';

export interface DatasetsState {
  groups: OperatorGroup[];
  isLoading: boolean;
  isError: boolean;
  selected: DatasetEntry | null;
  isSelected: (entry: DatasetEntry) => boolean;
  select: (entry: DatasetEntry) => void;
  detail: DatasetDetail | null;
  detailLoading: boolean;
  detailError: boolean;
  toast: string;
  toastNewDataset: () => void;
  toastBuild: () => void;
}

const TOAST_MS = 2400;

export function useDatasetsState(): DatasetsState {
  const [selected, setSelected] = useState<DatasetEntry | null>(null);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const listQuery = useQuery({
    queryKey: queryKeys.datasets,
    queryFn: ({ signal }) => apiGet<DatasetsResponse>('/datasets', { signal }),
  });

  const datasets = listQuery.data?.datasets ?? [];
  const groups = useMemo(() => groupByOperator(datasets), [datasets]);

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

  return {
    groups,
    isLoading: listQuery.isPending,
    isError: listQuery.isError,
    selected,
    isSelected: (entry) => sameDataset(selected, entry),
    select: setSelected,
    detail: detailQuery.data ?? null,
    detailLoading: selected !== null && detailQuery.isPending,
    detailError: selected !== null && detailQuery.isError,
    toast,
    toastNewDataset: () => showToast('New dataset is a Phase 2 feature'),
    toastBuild: () => showToast('Building datasets requires the Phase 2 recipe model'),
  };
}
