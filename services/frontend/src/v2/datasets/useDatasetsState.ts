// Local state machine for the Datasets tab: which dataset is selected, the
// mock "build" progress animation, and the toast queue. No backend calls —
// see data.ts for why this is all demo state in Phase 1.

import { useCallback, useEffect, useRef, useState } from 'react';
import { DATASETS, type DatasetInfo } from './data';

export interface DatasetsState {
  datasets: DatasetInfo[];
  selectedIndex: number;
  select: (i: number) => void;
  ds: DatasetInfo;
  building: boolean;
  buildPct: number;
  build: () => void;
  toast: string;
  toastNewDataset: () => void;
  toastEditRecipe: () => void;
  toastRebuild: () => void;
}

const BUILD_STEP_MS = 120;
const BUILD_STEP_PCT = 4;
const TOAST_MS = 2400;

export function useDatasetsState(): DatasetsState {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [building, setBuilding] = useState(false);
  const [buildPct, setBuildPct] = useState(0);
  const [toast, setToast] = useState('');

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (buildTimerRef.current) clearInterval(buildTimerRef.current);
    },
    [],
  );

  const ds = DATASETS[selectedIndex]!;

  const select = useCallback((i: number) => setSelectedIndex(i), []);

  const build = useCallback(() => {
    if (buildTimerRef.current) return;
    setBuilding(true);
    setBuildPct(0);
    buildTimerRef.current = setInterval(() => {
      setBuildPct((p) => {
        const next = p + BUILD_STEP_PCT;
        if (next >= 100) {
          if (buildTimerRef.current) clearInterval(buildTimerRef.current);
          buildTimerRef.current = null;
          setBuilding(false);
          showToast(`Build complete — LeRobot v3 artifact written for ${ds.name} ${ds.ver}`);
          return 0;
        }
        return next;
      });
    }, BUILD_STEP_MS);
  }, [ds.name, ds.ver, showToast]);

  return {
    datasets: DATASETS,
    selectedIndex,
    select,
    ds,
    building,
    buildPct,
    build,
    toast,
    toastNewDataset: () => showToast('New dataset is a Phase 2 feature'),
    toastEditRecipe: () => showToast('Recipe editor (task / operator / condition query)'),
    toastRebuild: () => showToast(`Rebuild queued as ${ds.name} v2`),
  };
}
