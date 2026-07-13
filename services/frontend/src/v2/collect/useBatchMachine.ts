// Collect screen state machine: batch -> episode -> phase, all local to the
// frontend (the backend has no Session/Batch/Episode model yet — that's Phase
// 2). The recording itself is real: startRecording()/stopRecording() call the
// orchestrator's /record/start and /record/stop (same contract LiveTab uses),
// and every other transition (arming/saving/quick-check/result/pause/end) is
// simulated client-side so the operator flow is fully demoable today.
//
// The reducer below is the "batch machine" proper — pure, exported for direct
// unit testing. Everything else in the hook (real API calls, timers, toast,
// modal/picker visibility) wraps it.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { errorText } from '../../components/ErrorMessage';
import { useUiStore } from '../../store/uiStore';
import type {
  RecordArming,
  RecordIntegrity,
  RecordStartRequest,
  RecordStatus,
  RunDetail,
} from '../../api/types';

export type Phase =
  | 'ready'
  | 'arming'
  | 'recording'
  | 'saving'
  | 'quickcheck'
  | 'result'
  | 'paused'
  | 'ended'
  | 'completed';

// Two independent axes — NOT one merged bucket. A failed task still produced
// a usable, labeled recording (see docs/specs: Datasets "include failures:
// yes, labeled"); collapsing them into a single "not usable" result would
// contradict that. `quality` has no 'bad'/'not usable' value yet in Phase 1 —
// that would come from full (post-recording) validation, which doesn't exist
// here — so the only quality signal available live is the review flag.
export type Quality = 'good' | 'review';
export type TaskResult = 'ok' | 'fail';

export interface EpisodeRecord {
  index: number;
  /** Recording/data quality — independent of whether the task succeeded. */
  quality: Quality;
  /** Whether the demonstrated task succeeded — independent of data quality. */
  taskResult: TaskResult;
  /** The run_id returned by /record/start for this episode's capture, if any. */
  runId?: string;
  failReason?: string;
}

/** Plain-language "Task outcome: …" line for the episode-result summary. */
export function describeTaskOutcome(pendingTask: 'ok' | 'fail' | null, failReason: string): string {
  if (pendingTask === 'ok') return 'Success.';
  if (pendingTask === 'fail') {
    return failReason ? `Failed — ${failReason.toLowerCase()}.` : 'Failed — choose a reason below.';
  }
  return '—';
}

/** Plain-language "Recording quality: …" line for the episode-result summary. */
export function describeQuality(recWarning: boolean): string {
  return recWarning
    ? 'Needs review — camera rate dropped during recording.'
    : 'Good — no issues detected.';
}

export interface PlanTask {
  name: string;
  conditions: string[];
}

export interface PlanProject {
  name: string;
  tasks: PlanTask[];
}

// Mock plan catalog (same values as the design mock's `plans` state) — stands
// in for the plan/task/condition backend that doesn't exist yet.
export const PLANS: PlanProject[] = [
  {
    name: 'Tabletop Manipulation',
    tasks: [
      {
        name: 'Pick and Place',
        conditions: [
          'Object: Left → Tray: Center',
          'Object: Center → Tray: Center',
          'Object: Right → Tray: Center',
        ],
      },
      { name: 'Stacking', conditions: ['Blocks: 3', 'Blocks: 5'] },
    ],
  },
  {
    name: 'Bin Picking',
    tasks: [{ name: 'Bin to Tray', conditions: ['Bin: full', 'Bin: sparse'] }],
  },
  {
    name: 'Kitchen Mobile',
    tasks: [{ name: 'Drawer Open', conditions: ['Drawer: top', 'Drawer: bottom'] }],
  },
];

export function findProject(name: string): PlanProject {
  return PLANS.find((p) => p.name === name) ?? PLANS[0]!;
}
export function findTask(projectName: string, taskName: string): PlanTask {
  const plan = findProject(projectName);
  return plan.tasks.find((t) => t.name === taskName) ?? plan.tasks[0]!;
}

export const FAIL_REASONS = [
  'Grasp missed',
  'Object dropped',
  'Wrong placement',
  'Object misplaced at start',
  'Robot fault',
  'Other',
];

export const END_REASONS = [
  'Work time over',
  'Equipment / system problem',
  'Condition change',
  'Safety',
  'Plan change',
  'Other',
];

export interface AdviceItem {
  badge: string;
  title: string;
  detail: string;
}

// Advice generation is intentionally NOT implemented — one fixed placeholder
// item, per the design decision (see the Collect task brief).
export const ADVICE_ITEMS: AdviceItem[] = [
  {
    badge: 'QUALITY',
    title: 'Hold still for ~1 s before starting',
    detail:
      'The first second after Start stabilizes the initial state the model learns ' +
      'from — a brief pause before moving improves this episode.',
  },
];

export const EPISODES_PER_BATCH = 30;
const SAVING_MS = 1000;
const QUICKCHECK_MS = 1500;
const WARNING_AT_S = 6;
export const MB_PER_S = 6.8; // demo write-rate used for the recording MB counter

const firstPlan = PLANS[0]!;
const firstTask = firstPlan.tasks[0]!;

interface MachineState {
  phase: Phase;
  episodes: EpisodeRecord[];
  batchNum: number;
  elapsedMs: number;
  recWarning: boolean;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: string | null;
  stopError: string | null;
  currentRunId: string | null;
  project: string;
  task: string;
  condition: string;
  endReason: string;
}

function createInitialState(): MachineState {
  return {
    phase: 'ready',
    episodes: [],
    batchNum: 1,
    elapsedMs: 0,
    recWarning: false,
    pendingTask: null,
    failReason: '',
    startError: null,
    stopError: null,
    currentRunId: null,
    project: firstPlan.name,
    task: firstTask.name,
    condition: firstTask.conditions[0] ?? '—',
    endReason: '',
  };
}

type Action =
  | { type: 'START_REQUESTED' }
  | { type: 'START_FAILED'; message: string }
  | { type: 'START_SUCCEEDED'; runId: string | null }
  | { type: 'CANCEL_ARMING' }
  | { type: 'TICK'; elapsedMs: number }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOP_FAILED'; message: string }
  | { type: 'SAVED' }
  | { type: 'QUICK_CHECK_DONE' }
  | { type: 'PICK_RESULT'; result: 'ok' | 'fail' }
  | { type: 'PICK_FAIL_REASON'; reason: string }
  | { type: 'CONFIRM_EPISODE' }
  | { type: 'RETRY_EPISODE' }
  | { type: 'PAUSE_BATCH' }
  | { type: 'RESUME_BATCH' }
  | { type: 'PICK_END_REASON'; reason: string }
  | { type: 'CONFIRM_END_BATCH' }
  | { type: 'START_NEXT_BATCH' }
  | { type: 'SET_CONDITION'; condition: string }
  | { type: 'SET_PROJECT'; project: string; task: string; condition: string }
  | { type: 'SET_TASK'; task: string; condition: string };

function reducer(state: MachineState, action: Action): MachineState {
  switch (action.type) {
    case 'START_REQUESTED':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'arming', startError: null };
    case 'START_FAILED':
      return { ...state, phase: 'ready', startError: action.message };
    case 'START_SUCCEEDED':
      return {
        ...state,
        phase: 'recording',
        elapsedMs: 0,
        recWarning: false,
        currentRunId: action.runId,
        startError: null,
      };
    case 'CANCEL_ARMING':
      if (state.phase !== 'arming') return state;
      return { ...state, phase: 'ready' };
    case 'TICK': {
      if (state.phase !== 'recording') return state;
      const recWarning = state.recWarning || action.elapsedMs >= WARNING_AT_S * 1000;
      return { ...state, elapsedMs: action.elapsedMs, recWarning };
    }
    case 'STOP_REQUESTED':
      if (state.phase !== 'recording') return state;
      return { ...state, phase: 'saving', stopError: null };
    case 'STOP_FAILED':
      // Only snap back to RECORDING if we're still in the immediate next phase —
      // once the demo-paced saving/quick-check timers have moved further on, a
      // late stop error just gets recorded (no phase change), since forcing the
      // operator's already-shown result back would be more confusing than useful.
      if (state.phase !== 'saving') return { ...state, stopError: action.message };
      return { ...state, phase: 'recording', stopError: action.message };
    case 'SAVED':
      if (state.phase !== 'saving') return state;
      return { ...state, phase: 'quickcheck' };
    case 'QUICK_CHECK_DONE':
      if (state.phase !== 'quickcheck') return state;
      return { ...state, phase: 'result', pendingTask: null, failReason: '' };
    case 'PICK_RESULT':
      if (state.phase !== 'result') return state;
      return {
        ...state,
        pendingTask: action.result,
        failReason: action.result === 'ok' ? '' : state.failReason,
      };
    case 'PICK_FAIL_REASON':
      if (state.phase !== 'result') return state;
      return { ...state, failReason: action.reason };
    case 'CONFIRM_EPISODE': {
      if (state.phase !== 'result' || !state.pendingTask) return state;
      if (state.pendingTask === 'fail' && !state.failReason) return state;
      // Independent axes: a failed task can still be good-quality, usable data.
      const taskResult: TaskResult = state.pendingTask === 'fail' ? 'fail' : 'ok';
      const quality: Quality = state.recWarning ? 'review' : 'good';
      const episode: EpisodeRecord = {
        index: state.episodes.length + 1,
        quality,
        taskResult,
        runId: state.currentRunId ?? undefined,
        failReason: taskResult === 'fail' ? state.failReason : undefined,
      };
      const episodes = [...state.episodes, episode];
      const done = episodes.length >= EPISODES_PER_BATCH;
      return {
        ...state,
        episodes,
        phase: done ? 'completed' : 'ready',
        elapsedMs: 0,
        recWarning: false,
        pendingTask: null,
        failReason: '',
        currentRunId: null,
      };
    }
    case 'RETRY_EPISODE':
      if (state.phase !== 'result') return state;
      return {
        ...state,
        phase: 'ready',
        elapsedMs: 0,
        recWarning: false,
        pendingTask: null,
        failReason: '',
        currentRunId: null,
      };
    case 'PAUSE_BATCH':
      if (state.phase !== 'ready') return state;
      return { ...state, phase: 'paused' };
    case 'RESUME_BATCH':
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'ready' };
    case 'PICK_END_REASON':
      return { ...state, endReason: action.reason };
    case 'CONFIRM_END_BATCH':
      if (!state.endReason) return state;
      return { ...state, phase: 'ended' };
    case 'START_NEXT_BATCH':
      if (state.phase !== 'ended' && state.phase !== 'completed') return state;
      return {
        ...state,
        episodes: [],
        batchNum: state.batchNum + 1,
        phase: 'ready',
        elapsedMs: 0,
        recWarning: false,
        endReason: '',
        currentRunId: null,
      };
    case 'SET_CONDITION':
      return { ...state, condition: action.condition };
    case 'SET_PROJECT':
      return { ...state, project: action.project, task: action.task, condition: action.condition };
    case 'SET_TASK':
      return { ...state, task: action.task, condition: action.condition };
    default:
      return state;
  }
}

// Exported for direct reducer unit tests (no React needed for pure transitions).
export { reducer as batchMachineReducer, createInitialState as createBatchMachineState };

export interface BatchStats {
  nRecorded: number;
  /** quality === 'good' (independent of task outcome). */
  nGood: number;
  /** quality === 'review' (independent of task outcome). */
  nReview: number;
  /** taskResult === 'fail' — a separate axis, NOT a quality bucket. Can
   *  overlap with nGood or nReview (a failed task can still be good data). */
  nTaskFailed: number;
  nRemaining: number;
  epNext: number;
}

export interface UseBatchMachineArgs {
  /** Topics for the next /record/start (mirrors LiveTab's RecordSelection.topics). */
  recordTopics: string[] | 'all';
}

export interface BatchMachine {
  phase: Phase;
  episodes: EpisodeRecord[];
  batchNum: number;
  elapsedMs: number;
  recWarning: boolean;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: string | null;
  stopError: string | null;
  isStarting: boolean;
  stats: BatchStats;

  // Real recorder signals from /record/status (never the mock quality flag).
  /** Live arming matched/missing snapshot (OL-①.4). Null unless the recorder
   *  reports it; a non-persisted live aid, never stored anywhere. */
  arming: RecordArming | null;
  /** Recording integrity for THIS episode's run (OL-①). 'dropped'/'failed'
   *  drive the result-phase banner; gated to the current run so a prior run's
   *  drop can't leak into this episode's result. */
  integrity: RecordIntegrity | null;
  /** rosbag2's self-reported messages lost when integrity is 'dropped'. */
  droppedMessages: number | null;

  // context
  project: string;
  task: string;
  condition: string;
  ctxEditable: boolean;
  condAllowed: boolean;
  endReason: string;

  // pickers / menu / modals
  batchMenuOpen: boolean;
  projPickerOpen: boolean;
  taskPickerOpen: boolean;
  endModalOpen: boolean;
  issueModalOpen: boolean;
  condModalOpen: boolean;
  toggleBatchMenu: () => void;
  openProjPicker: () => void;
  openTaskPicker: () => void;
  openCondModal: () => void;
  openEndModal: () => void;
  openIssueModal: () => void;
  closeModals: () => void;

  // advice pager
  adviceIdx: number;
  advicePrev: () => void;
  adviceNext: () => void;

  // toast
  toast: string;

  // actions
  startRecording: () => void;
  cancelArming: () => void;
  stopRecording: () => void;
  pickSuccess: () => void;
  pickFailure: () => void;
  pickFailReason: (reason: string) => void;
  confirmEpisode: () => void;
  retryEpisode: () => void;
  pauseBatch: () => void;
  resumeBatch: () => void;
  pickEndReason: (reason: string) => void;
  confirmEndBatch: () => void;
  submitIssue: () => void;
  startNextBatch: () => void;
  pickProject: (name: string) => void;
  pickTask: (name: string) => void;
  pickCondition: (condition: string) => void;
  /** Jump to the Monitor tab (Warnings card's "Open in Monitor →"). */
  goMonitor: () => void;
}

export function useBatchMachine({ recordTopics }: UseBatchMachineArgs): BatchMachine {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const queryClient = useQueryClient();
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const goMonitor = useCallback(() => setActiveTab('monitor'), [setActiveTab]);

  // ---- real recorder status (arming + integrity) --------------------------
  // Polls /record/status on the SAME query key LiveTab uses, so react-query
  // dedupes it (no extra network). Two honest, non-persisted live signals ride
  // this poll: the arming matched/missing summary (OL-①.4) and the post-stop
  // recording integrity (OL-①) — both read straight from the recorder, never
  // synthesized and never the mock quality flag (recWarning). The stop mutation
  // already invalidates this key, so the integrity surfaces once the recorder
  // finalises the bag.
  const statusQuery = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => apiGet<RecordStatus>('/record/status', { signal }),
    refetchInterval: 5000,
  });
  const status = statusQuery.data;
  const arming: RecordArming | null = status?.arming ?? null;
  // Gate integrity to THIS episode's run so a previous run's `dropped`/`failed`
  // can't leak into the current episode's result while the poll catches up.
  const runMatches =
    state.currentRunId == null || (status?.run_id ?? null) === state.currentRunId;
  const integrity: RecordIntegrity | null = runMatches ? status?.integrity ?? null : null;
  const droppedMessages: number | null = runMatches ? status?.dropped_messages ?? null : null;

  // ---- toast --------------------------------------------------------------
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

  // ---- real recording API (mirrors LiveTab's start/stop wiring) -----------
  // Tracks a Cancel (during arming) or an end-batch-early confirmed while
  // arming/recording, so a start that lands late — or a stop that fails — is
  // reconciled instead of leaving an orphaned recorder session running.
  const cancelledStartRef = useRef(false);

  const startMutation = useMutation({
    mutationFn: (body: RecordStartRequest) => apiPost<RunDetail>('/record/start', body),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        // The operator already backed out locally. If the recorder actually
        // started server-side despite that, stop it now (best-effort) so it
        // doesn't keep running unnoticed.
        if (run && run.state !== 'failed') {
          void apiPost('/record/stop', {}).catch(() => {});
        }
        return;
      }
      if (!run || run.state === 'failed') {
        dispatch({
          type: 'START_FAILED',
          message: run?.error
            ? `${run.error.code}: ${run.error.message}`
            : 'the recorder rejected the start',
        });
        return;
      }
      dispatch({ type: 'START_SUCCEEDED', runId: run.run_id });
    },
    onError: (err) => {
      if (cancelledStartRef.current) {
        cancelledStartRef.current = false;
        return;
      }
      dispatch({ type: 'START_FAILED', message: errorText(err) });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => apiPost<RunDetail>('/record/stop', {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.recordStatus });
    },
    onError: (err) => {
      dispatch({ type: 'STOP_FAILED', message: errorText(err) });
    },
  });

  const startRecording = useCallback(() => {
    if (state.phase !== 'ready') return;
    cancelledStartRef.current = false;
    dispatch({ type: 'START_REQUESTED' });
    const body: RecordStartRequest = { topics: recordTopics, task: state.task };
    startMutation.mutate(body);
  }, [state.phase, state.task, recordTopics, startMutation]);

  const cancelArming = useCallback(() => {
    if (state.phase !== 'arming') return;
    cancelledStartRef.current = true;
    dispatch({ type: 'CANCEL_ARMING' });
  }, [state.phase]);

  const stopRecording = useCallback(() => {
    if (state.phase !== 'recording') return;
    dispatch({ type: 'STOP_REQUESTED' });
    stopMutation.mutate();
  }, [state.phase, stopMutation]);

  // ---- demo-paced phase timers ---------------------------------------------
  const recStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (state.phase !== 'recording') return;
    recStartRef.current = Date.now();
    const id = setInterval(() => {
      if (recStartRef.current == null) return;
      dispatch({ type: 'TICK', elapsedMs: Date.now() - recStartRef.current });
    }, 250);
    return () => clearInterval(id);
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== 'saving') return;
    const id = setTimeout(() => dispatch({ type: 'SAVED' }), SAVING_MS);
    return () => clearTimeout(id);
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== 'quickcheck') return;
    const id = setTimeout(() => dispatch({ type: 'QUICK_CHECK_DONE' }), QUICKCHECK_MS);
    return () => clearTimeout(id);
  }, [state.phase]);

  // ---- episode result / confirm --------------------------------------------
  const pickSuccess = useCallback(() => dispatch({ type: 'PICK_RESULT', result: 'ok' }), []);
  const pickFailure = useCallback(() => dispatch({ type: 'PICK_RESULT', result: 'fail' }), []);
  const pickFailReason = useCallback(
    (reason: string) => dispatch({ type: 'PICK_FAIL_REASON', reason }),
    [],
  );

  const confirmEpisode = useCallback(() => {
    if (state.phase !== 'result' || !state.pendingTask) return;
    if (state.pendingTask === 'fail' && !state.failReason) return;
    const nextIndex = state.episodes.length + 1;
    const willComplete = nextIndex >= EPISODES_PER_BATCH;
    const isFail = state.pendingTask === 'fail';
    const reason = state.failReason;
    const needsReview = state.recWarning;
    dispatch({ type: 'CONFIRM_EPISODE' });
    if (!willComplete) {
      // Report both axes when either is notable — a failed task and/or a
      // review-flagged recording — so the toast never implies "not usable"
      // for data that's actually saved and labeled.
      const notes: string[] = [];
      if (isFail) notes.push(`task failed${reason ? ` (${reason})` : ''}`);
      if (needsReview) notes.push('quality needs review');
      const detail = notes.length ? ` — ${notes.join(', ')}` : '';
      showToast(`Episode ${nextIndex} saved${detail} — ready for #${nextIndex + 1}`);
    }
  }, [state.phase, state.pendingTask, state.failReason, state.recWarning, state.episodes.length, showToast]);

  const retryEpisode = useCallback(() => {
    if (state.phase !== 'result') return;
    dispatch({ type: 'RETRY_EPISODE' });
    showToast('Episode discarded — re-record when ready');
  }, [state.phase, showToast]);

  // ---- batch menu actions ---------------------------------------------------
  const pauseBatch = useCallback(() => {
    // Deviates from the design mock (which allows pausing at any phase):
    // pausing while a real recorder session is armed/recording/saving would
    // abandon it silently, so we only allow the clean, idle case.
    if (state.phase !== 'ready') return;
    dispatch({ type: 'PAUSE_BATCH' });
    setBatchMenuOpen(false);
  }, [state.phase]);
  const resumeBatch = useCallback(() => dispatch({ type: 'RESUME_BATCH' }), []);

  const pickEndReason = useCallback(
    (reason: string) => dispatch({ type: 'PICK_END_REASON', reason }),
    [],
  );
  const confirmEndBatch = useCallback(() => {
    if (!state.endReason) return;
    if (state.phase === 'arming') {
      // A start may still land after we've moved on — treat it like a manual
      // cancel so it gets auto-stopped instead of orphaned.
      cancelledStartRef.current = true;
    } else if (state.phase === 'recording' || state.phase === 'saving' || state.phase === 'quickcheck') {
      void apiPost('/record/stop', {}).catch(() => {});
    }
    dispatch({ type: 'CONFIRM_END_BATCH' });
    setEndModalOpen(false);
    setBatchMenuOpen(false);
  }, [state.endReason, state.phase]);

  const startNextBatch = useCallback(() => {
    if (state.phase !== 'ended' && state.phase !== 'completed') return;
    const nextBatch = state.batchNum + 1;
    dispatch({ type: 'START_NEXT_BATCH' });
    showToast(`Batch ${nextBatch} ready — same condition, ${EPISODES_PER_BATCH} episodes`);
  }, [state.phase, state.batchNum, showToast]);

  // ---- context: project / task / condition ----------------------------------
  const ctxEditable =
    state.phase === 'ready' ||
    state.phase === 'ended' ||
    state.phase === 'completed' ||
    state.phase === 'paused';
  const condAllowed = state.phase === 'ready';

  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [projPickerOpen, setProjPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [condModalOpen, setCondModalOpen] = useState(false);
  const [adviceIdx, setAdviceIdx] = useState(0);

  const toggleBatchMenu = useCallback(() => setBatchMenuOpen((v) => !v), []);
  const openProjPicker = useCallback(() => {
    if (!ctxEditable) return;
    setProjPickerOpen((v) => !v);
    setTaskPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const openTaskPicker = useCallback(() => {
    if (!ctxEditable) return;
    setTaskPickerOpen((v) => !v);
    setProjPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const openCondModal = useCallback(() => {
    if (!condAllowed) return;
    setCondModalOpen(true);
    setBatchMenuOpen(false);
  }, [condAllowed]);
  const openEndModal = useCallback(() => {
    setEndModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openIssueModal = useCallback(() => {
    setIssueModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const closeModals = useCallback(() => {
    setEndModalOpen(false);
    setIssueModalOpen(false);
    setCondModalOpen(false);
  }, []);
  const submitIssue = useCallback(() => {
    setIssueModalOpen(false);
    showToast('Issue logged with episode context');
  }, [showToast]);

  const pickProject = useCallback(
    (name: string) => {
      const plan = findProject(name);
      const t0 = plan.tasks[0];
      dispatch({
        type: 'SET_PROJECT',
        project: plan.name,
        task: t0?.name ?? '—',
        condition: t0?.conditions[0] ?? '—',
      });
      setProjPickerOpen(false);
      showToast('Project switched — batch plan reloaded');
    },
    [showToast],
  );
  const pickTask = useCallback(
    (name: string) => {
      const t = findTask(state.project, name);
      dispatch({ type: 'SET_TASK', task: t?.name ?? '—', condition: t?.conditions[0] ?? '—' });
      setTaskPickerOpen(false);
      showToast('Task switched — applies to next batch');
    },
    [state.project, showToast],
  );
  const pickCondition = useCallback(
    (condition: string) => {
      dispatch({ type: 'SET_CONDITION', condition });
      setCondModalOpen(false);
      showToast('Condition updated — applies from next episode');
    },
    [showToast],
  );

  const advicePrev = useCallback(
    () => setAdviceIdx((i) => (i - 1 + ADVICE_ITEMS.length) % ADVICE_ITEMS.length),
    [],
  );
  const adviceNext = useCallback(() => setAdviceIdx((i) => (i + 1) % ADVICE_ITEMS.length), []);

  const stats: BatchStats = useMemo(() => {
    const nRecorded = state.episodes.length;
    const nGood = state.episodes.filter((e) => e.quality === 'good').length;
    const nReview = state.episodes.filter((e) => e.quality === 'review').length;
    const nTaskFailed = state.episodes.filter((e) => e.taskResult === 'fail').length;
    return {
      nRecorded,
      nGood,
      nReview,
      nTaskFailed,
      nRemaining: EPISODES_PER_BATCH - nRecorded,
      epNext: Math.min(nRecorded + 1, EPISODES_PER_BATCH),
    };
  }, [state.episodes]);

  return {
    phase: state.phase,
    episodes: state.episodes,
    batchNum: state.batchNum,
    elapsedMs: state.elapsedMs,
    recWarning: state.recWarning,
    pendingTask: state.pendingTask,
    failReason: state.failReason,
    startError: state.startError,
    stopError: state.stopError,
    isStarting: startMutation.isPending,
    stats,

    arming,
    integrity,
    droppedMessages,

    project: state.project,
    task: state.task,
    condition: state.condition,
    ctxEditable,
    condAllowed,
    endReason: state.endReason,

    batchMenuOpen,
    projPickerOpen,
    taskPickerOpen,
    endModalOpen,
    issueModalOpen,
    condModalOpen,
    toggleBatchMenu,
    openProjPicker,
    openTaskPicker,
    openCondModal,
    openEndModal,
    openIssueModal,
    closeModals,

    adviceIdx,
    advicePrev,
    adviceNext,

    toast,

    startRecording,
    cancelArming,
    stopRecording,
    pickSuccess,
    pickFailure,
    pickFailReason,
    confirmEpisode,
    retryEpisode,
    pauseBatch,
    resumeBatch,
    pickEndReason,
    confirmEndBatch,
    submitIssue,
    startNextBatch,
    pickProject,
    pickTask,
    pickCondition,
    goMonitor,
  };
}
