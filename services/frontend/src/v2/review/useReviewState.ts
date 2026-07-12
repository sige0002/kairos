// Review screen state: fetches real runs, maps them to episodes (mapRuns.ts),
// and layers all the locally-decided state on top — decisions, quality/task
// overrides, archival, transfer, selection, playback, the standard-validation
// mock action, and the toast. None of this posts back to the orchestrator
// (there's no Session/Batch/Episode-review backend model yet — Phase 2,
// mirroring the Collect screen's useBatchMachine.ts note on the same gap).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import type { Page, RunSummary } from '../../api/types';
import { useUiStore } from '../../store/uiStore';
import { FALLBACK_EPISODES, mapRunsToEpisodes } from './mapRuns';
import { formatMmSs } from './format';
import { initialTransferSlot, transferReducer, TRANSFER_DURATION_MS, TRANSFER_TICK_MS } from './transfer';
import { useSplitMode } from './splitMode';
import type { Decision, DecoratedEpisode, EpisodeRow, Quality, TaskResult, TransferSlot } from './types';

// Own query key (not queryKeys.runs(cursor)): this screen wants one big page
// of everything reviewable, a different shape than the Recordings list's
// cursor-paginated fetch, so it doesn't share that cache entry.
const REVIEW_RUNS_KEY = ['runs', 'review-list'] as const;
const REVIEW_PAGE_LIMIT = 200;

const QUALITY_ORDER: Quality[] = ['Good', 'Needs review', 'Not usable'];

export interface ReviewState {
  isLoading: boolean;
  usingFallback: boolean;

  rows: DecoratedEpisode[]; // visible (filtered + sorted, newest first)
  nUndecidedGood: number;
  hasArchived: boolean;
  nArchived: number;
  showArchived: boolean;
  toggleArchived: () => void;

  search: string;
  setSearch: (v: string) => void;
  clearFilters: () => void;

  selectedRunId: string | null;
  select: (runId: string) => void;
  selected: DecoratedEpisode | undefined;

  requestArchive: (runId: string) => void;
  pendingArchiveEp: number | null;
  confirmArchive: () => void;
  cancelArchive: () => void;

  adoptAllGood: () => void;
  decide: (d: Decision) => void;
  cycleFinalQuality: () => void;
  cycleTaskResult: () => void;

  playing: boolean;
  playPct: number;
  playTimeLabel: string;
  togglePlay: () => void;

  rvRunning: boolean;
  runStandardOnEp: () => void;

  goMonitor: () => void;
  goValidation: () => void;

  splitMode: boolean;
  nUntransferred: number;
  transferOne: (runId: string) => void;
  transferAllUntransferred: () => void;

  toast: string;
}

export function useReviewState(): ReviewState {
  const runsQuery = useQuery({
    queryKey: REVIEW_RUNS_KEY,
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: REVIEW_PAGE_LIMIT } }),
  });
  const usingFallback = runsQuery.isError;
  const baseEpisodes: EpisodeRow[] = useMemo(() => {
    if (runsQuery.data) return mapRunsToEpisodes(runsQuery.data.items);
    if (usingFallback) return FALLBACK_EPISODES;
    return [];
  }, [runsQuery.data, usingFallback]);

  // ---- toast ----------------------------------------------------------------
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2400);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // ---- local overlays: decisions / overrides / archive / transfer ----------
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [overrides, setOverrides] = useState<Record<string, { quality?: Quality; task?: TaskResult }>>({});
  const [archivedRunIds, setArchivedRunIds] = useState<Record<string, true>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferSlot>>({});

  const decorated: DecoratedEpisode[] = useMemo(
    () =>
      baseEpisodes.map((e) => {
        const ov = overrides[e.runId];
        return {
          ...e,
          effectiveQuality: ov?.quality ?? e.quality,
          effectiveTask: ov?.task ?? e.task,
          isArchived: !!archivedRunIds[e.runId],
          decision: decisions[e.runId] ?? null,
          transferSlot: transfers[e.runId] ?? initialTransferSlot(e.transfer),
        };
      }),
    [baseEpisodes, overrides, archivedRunIds, decisions, transfers],
  );

  // ---- filters / search -----------------------------------------------------
  const [showArchived, setShowArchived] = useState(false);
  const toggleArchived = useCallback(() => setShowArchived((v) => !v), []);
  const [search, setSearch] = useState('');
  const clearFilters = useCallback(() => setSearch(''), []);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decorated
      .filter((r) => showArchived || !r.isArchived)
      .filter((r) => {
        if (!q) return true;
        return `#${r.ep}`.toLowerCase().includes(q) || r.runId.toLowerCase().includes(q);
      })
      .sort((a, b) => b.ep - a.ep);
  }, [decorated, search, showArchived]);

  const nArchived = useMemo(() => decorated.filter((r) => r.isArchived).length, [decorated]);
  const nUndecidedGood = useMemo(
    () => decorated.filter((r) => !r.isArchived && r.effectiveQuality === 'Good' && !r.decision).length,
    [decorated],
  );

  // ---- selection --------------------------------------------------------
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const select = useCallback((runId: string) => setSelectedRunId(runId), []);
  useEffect(() => {
    if (selectedRunId || decorated.length === 0) return;
    const sorted = [...decorated].sort((a, b) => b.ep - a.ep);
    const first = sorted.find((r) => !r.isArchived) ?? sorted[0];
    if (first) setSelectedRunId(first.runId);
  }, [decorated, selectedRunId]);
  const selected = decorated.find((r) => r.runId === selectedRunId);

  // ---- archive (with confirm) ------------------------------------------
  // "Archive" is this file's internal name for what the UI presents as
  // "Exclude" — non-destructive (persona test P3: the mock's own "delete
  // candidate" wording read as actual deletion and scared operators away from
  // the control). Nothing here ever removes a recording; it only reclassifies
  // quality/decision and hides the row from the default view. Every surface
  // (tooltip, modal, toast) says so explicitly.
  const [pendingArchiveRunId, setPendingArchiveRunId] = useState<string | null>(null);
  const requestArchive = useCallback(
    (runId: string) => {
      const row = decorated.find((r) => r.runId === runId);
      if (!row) return;
      if (row.isArchived) {
        setArchivedRunIds((prev) => {
          const next = { ...prev };
          delete next[runId];
          return next;
        });
        showToast(`Episode #${row.ep} restored — no longer excluded`);
        return;
      }
      setPendingArchiveRunId(runId);
    },
    [decorated, showToast],
  );
  const confirmArchive = useCallback(() => {
    if (!pendingArchiveRunId) return;
    const row = decorated.find((r) => r.runId === pendingArchiveRunId);
    setArchivedRunIds((prev) => ({ ...prev, [pendingArchiveRunId]: true }));
    setOverrides((prev) => ({
      ...prev,
      [pendingArchiveRunId]: { ...prev[pendingArchiveRunId], quality: 'Not usable' },
    }));
    setDecisions((prev) => ({ ...prev, [pendingArchiveRunId]: 'excluded' }));
    showToast(`Episode #${row?.ep ?? '?'} → Not usable · Excluded (recording kept, restorable)`);
    setPendingArchiveRunId(null);
  }, [pendingArchiveRunId, decorated, showToast]);
  const cancelArchive = useCallback(() => setPendingArchiveRunId(null), []);
  const pendingArchiveEp = pendingArchiveRunId
    ? (decorated.find((r) => r.runId === pendingArchiveRunId)?.ep ?? null)
    : null;

  // ---- decisions / overrides ---------------------------------------------
  const adoptAllGood = useCallback(() => {
    const candidates = decorated.filter((r) => !r.isArchived && r.effectiveQuality === 'Good' && !r.decision);
    if (!candidates.length) {
      showToast('No undecided good episodes');
      return;
    }
    setDecisions((prev) => {
      const next = { ...prev };
      candidates.forEach((c) => {
        next[c.runId] = 'adopted';
      });
      return next;
    });
    showToast(`${candidates.length} good episode${candidates.length === 1 ? '' : 's'} adopted — needs-review items left untouched`);
  }, [decorated, showToast]);

  const decide = useCallback(
    (d: Decision) => {
      if (!selected) return;
      setDecisions((prev) => ({ ...prev, [selected.runId]: d }));
      showToast(`Episode #${selected.ep} → ${d}`);
    },
    [selected, showToast],
  );

  const cycleFinalQuality = useCallback(() => {
    if (!selected) return;
    const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(selected.effectiveQuality) + 1) % QUALITY_ORDER.length]!;
    setOverrides((prev) => ({ ...prev, [selected.runId]: { ...prev[selected.runId], quality: next } }));
    showToast(`#${selected.ep} quality → ${next} (override recorded, history kept)`);
  }, [selected, showToast]);

  const cycleTaskResult = useCallback(() => {
    if (!selected) return;
    const next: TaskResult = selected.effectiveTask === 'Success' ? 'Failure' : 'Success';
    setOverrides((prev) => ({ ...prev, [selected.runId]: { ...prev[selected.runId], task: next } }));
    showToast(`#${selected.ep} task result → ${next} (override recorded, history kept)`);
  }, [selected, showToast]);

  // ---- fake player --------------------------------------------------------
  const [playing, setPlaying] = useState(false);
  const [playPct, setPlayPct] = useState(0);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    // A newly-selected episode always starts its fake player from the top.
    setPlaying(false);
    setPlayPct(0);
    if (playIntervalRef.current) {
      clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
    }
  }, [selectedRunId]);
  useEffect(
    () => () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    },
    [],
  );
  const togglePlay = useCallback(() => {
    if (playing) {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
      setPlaying(false);
      return;
    }
    setPlaying(true);
    playIntervalRef.current = setInterval(() => {
      setPlayPct((p) => {
        const next = p + 2.4;
        if (next >= 100) {
          if (playIntervalRef.current) clearInterval(playIntervalRef.current);
          playIntervalRef.current = null;
          setPlaying(false);
          return 0;
        }
        return next;
      });
    }, 200);
  }, [playing]);
  const totalSeconds = Math.max(1, Math.round((selected?.durationMs ?? 28000) / 1000));
  const playTimeLabel = `${formatMmSs((totalSeconds * playPct) / 100)} / ${formatMmSs(totalSeconds)}`;

  // ---- standard validation mock action --------------------------------
  const [rvRunning, setRvRunning] = useState(false);
  const rvTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (rvTimerRef.current) clearTimeout(rvTimerRef.current);
    },
    [],
  );
  const runStandardOnEp = useCallback(() => {
    if (rvRunning || !selected) return;
    setRvRunning(true);
    showToast(`Running 2 standard pipelines on #${selected.ep}…`);
    rvTimerRef.current = setTimeout(() => {
      setRvRunning(false);
      showToast(`#${selected.ep} — camera_coverage OK 94.1% · sync_drift OK 3.2 ms`);
    }, 2200);
  }, [rvRunning, selected, showToast]);

  // ---- deep links ---------------------------------------------------------
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const setPendingRun = useUiStore((s) => s.setPendingRun);
  const goMonitor = useCallback(() => {
    if (selected) setPendingRun(selected.runId);
    setActiveTab('monitor');
  }, [selected, setActiveTab, setPendingRun]);
  const goValidation = useCallback(() => {
    if (selected) setPendingRun(selected.runId);
    setActiveTab('validation');
  }, [selected, setActiveTab, setPendingRun]);

  // ---- transfer (split mode) ---------------------------------------------
  const splitMode = useSplitMode();
  const transferTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      Object.values(transferTimers.current).forEach(clearTimeout);
    },
    [],
  );
  const transferOne = useCallback(
    (runId: string) => {
      setTransfers((prev) => {
        const seedRow = baseEpisodes.find((e) => e.runId === runId);
        const cur = prev[runId] ?? initialTransferSlot(seedRow?.transfer ?? 'on_robot');
        if (cur.phase !== 'on_robot') return prev;
        return { ...prev, [runId]: transferReducer(cur, { type: 'START' }) };
      });
      const start = Date.now();
      const tick = () => {
        setTransfers((prev) => {
          const cur = prev[runId];
          if (!cur || cur.phase !== 'transferring') return prev;
          const elapsed = Date.now() - start;
          if (elapsed >= TRANSFER_DURATION_MS) {
            delete transferTimers.current[runId];
            showToast('Episode transferred to the recording PC');
            return { ...prev, [runId]: transferReducer(cur, { type: 'DONE' }) };
          }
          transferTimers.current[runId] = setTimeout(tick, TRANSFER_TICK_MS);
          return {
            ...prev,
            [runId]: transferReducer(cur, { type: 'TICK', pct: Math.round((elapsed / TRANSFER_DURATION_MS) * 100) }),
          };
        });
      };
      transferTimers.current[runId] = setTimeout(tick, TRANSFER_TICK_MS);
    },
    [baseEpisodes, showToast],
  );
  const nUntransferred = useMemo(
    () => decorated.filter((r) => !r.isArchived && r.transferSlot.phase === 'on_robot').length,
    [decorated],
  );
  const transferAllUntransferred = useCallback(() => {
    const targets = decorated.filter((r) => !r.isArchived && r.transferSlot.phase === 'on_robot');
    if (!targets.length) {
      showToast('Nothing to transfer');
      return;
    }
    targets.forEach((r) => transferOne(r.runId));
    showToast(`Transferring ${targets.length} episode${targets.length === 1 ? '' : 's'}…`);
  }, [decorated, transferOne, showToast]);

  return {
    isLoading: runsQuery.isPending,
    usingFallback,

    rows,
    nUndecidedGood,
    hasArchived: nArchived > 0,
    nArchived,
    showArchived,
    toggleArchived,

    search,
    setSearch,
    clearFilters,

    selectedRunId,
    select,
    selected,

    requestArchive,
    pendingArchiveEp,
    confirmArchive,
    cancelArchive,

    adoptAllGood,
    decide,
    cycleFinalQuality,
    cycleTaskResult,

    playing,
    playPct,
    playTimeLabel,
    togglePlay,

    rvRunning,
    runStandardOnEp,

    goMonitor,
    goValidation,

    splitMode,
    nUntransferred,
    transferOne,
    transferAllUntransferred,

    toast,
  };
}
