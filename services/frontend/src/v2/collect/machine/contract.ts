// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The BatchMachine return-value contract (what useBatchMachine hands the
// Collect components), split out of useBatchMachine.ts.

import type {
  QuickCheckVerdict,
  RecordArming,
  RecordIntegrity,
  RecordState,
} from '../../../api/types';
import type { CaptureDeletionState } from '../../captures/useCaptureDeletion';
import type { RecordingCueSettings } from '../hooks/useRecordingCues';
import type {
  EpisodeRecord,
  MachineError,
  Phase,
  Quality,
  QualityOverride,
  StopBlockedReason,
} from './types';

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
  /** The active robot's configured `default_topics` (from runtime config). The
   *  actual next-start selection is resolved from this + the uiStore record
   *  picker (see `RecordSelection` / v1 LiveTab.tsx:940-948). */
  defaultTopics: string[];
}

/** Resolved topic selection for the next /record/start (mirrors v1 LiveTab). */
export interface RecordSelection {
  /** Explicit concrete names, or 'all' to record everything. */
  topics: string[] | 'all';
  /** How many topics that represents (for the record-topics chip). */
  count: number;
  /** Whether the operator customized the Monitor picker (vs configured defaults). */
  customized: boolean;
}

export interface BatchMachine {
  phase: Phase;
  episodes: EpisodeRecord[];
  /** Server batch number (null before the batch is created / on an older
   *  backend). The UI shows "Batch {batchSeq}" or an honest "—" fallback. */
  batchSeq: number | null;
  /** Predicted next batch number (display hint) for the pre-state shown while
   *  `batchSeq` is null. Null → the UI falls back to "next #1". */
  predictedSeq: number | null;
  elapsedMs: number;
  pendingTask: 'ok' | 'fail' | null;
  failReason: string;
  startError: MachineError | null;
  stopError: MachineError | null;
  isStarting: boolean;
  stats: BatchStats;

  // Quality (D-2): the auto value from the real integrity signal, plus the
  // operator's optional override. `autoQuality` drives the QUICK chip; the
  // effective quality (override ?? auto) is what gets saved.
  /** Real quick-check quality for the current run (from integrity), never a mock. */
  autoQuality: Quality;
  /** Operator override, or null when accepting the auto value. */
  qualityOverride: QualityOverride | null;
  /** Set the operator override (null clears it back to auto). */
  setQuality: (q: QualityOverride | null) => void;

  // Settled quick-check verdict (F1): the server's stop-time quality call plus
  // its human-readable reasons, shown on the result panel when settled.
  quickCheck: {
    /** The settled verdict, or null while unsettled / on an older backend. */
    verdict: QuickCheckVerdict | null;
    /** True while on the result panel waiting for the verdict to settle. */
    pending: boolean;
  };

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
  /** Finalised/live bag size for the current capture (formatBytes it; null → "—"). */
  recordingBytes: number | null;
  /** The recorder's SERVER state (from /record/status), the single source the
   *  SYSTEM STATUS Recorder row and the takeover card both read — so the two can
   *  never contradict. Null before the first poll. The recorder has no `idle`:
   *  a fresh one sits in `created` (§10). */
  recorderState: RecordState | null;
  /** The recorder's live capture set, or null when it did not answer with one —
   *  which means UNREACHABLE, not "nothing is live" (§10 rev.2.4). The two are
   *  never collapsed: the UI says it does not know rather than reporting an
   *  empty set it never saw. */
  liveCaptures: string[] | null;
  /** True while the recorder holds a pre-armed (two-phase prepare) session:
   *  the next matching Start is a near-instant resume. Server-reported, never
   *  assumed from having sent a prepare. */
  preArmed: boolean;
  /** Non-null when pre-arm keeps failing (2+ consecutive prepares): the last
   *  failure's message. Start still works (full synchronous fallback) — this
   *  is the operator's cue that a fixable blocker (topic mismatch, disk full)
   *  is being hit, which used to be silent (S2-7). */
  preArmDegraded: string | null;

  // Takeover (D-1): a recording is running server-side that this screen is not
  // driving (another tab/session, or a reload of our own). Null in the normal
  // case; when set, ControlCard shows the takeover card instead of a phase card.
  takeover: {
    captureId: string;
    /** The capture's run_id — DISPLAY ONLY (§1); null until the detail loads. */
    runLabel: string | null;
    startedAt: string | null;
    bytes: number | null;
    /** Topic count from the capture (RecordStatus has no topic list); null until loaded. */
    topicsCount: number | null;
    /** Operator from the capture; null when absent (never fabricated). */
    operator: string | null;
  } | null;
  /** True when the takeover capture is one this browser started (resumed own). */
  takeoverResumedOwn: boolean;
  takeoverStopModalOpen: boolean;
  openTakeoverStopModal: () => void;
  confirmTakeoverStop: () => void;
  isTakeoverStopping: boolean;

  // Unsaved take recovery (D-3): a finished capture with review_revision 0 —
  // never reviewed — offered for recovery after a reload between Stop and Save.
  // Null when none.
  unsavedTake: {
    captureId: string;
    /** run_id for display (§1); null when the capture carries none. */
    runLabel: string | null;
    startedAt: string | null;
    bytes: number | null;
    durationMs: number | null;
    /** True when the take ended on its own rather than being stopped. */
    interrupted: boolean;
    /** Why it ended, from the capture's own error. Null when none was
     *  recorded — the banner then says only that it ended by itself. */
    reason: string | null;
  } | null;
  /** Open the result panel for the unsaved take to label it. */
  labelUnsavedTake: () => void;
  /** Open the shared discard dialog for the unsaved take. */
  discardUnsavedTake: () => void;
  /** Hide the unsaved-take banner until a take recorded AFTER this point
   *  appears (or the next page load). */
  dismissUnsavedTake: () => void;
  /** How many recoverable unsaved takes exist right now. More than one is
   *  worth saying: the operator is looking at a banner for one of them. */
  unsavedTakeCount: number;
  /** When the take the result panel is about started — the field the operator
   *  can match against the recovery banner, which names its own take the same
   *  way. Null before a capture exists or when the recorder gave no time. */
  currentTakeStartedAt: string | null;
  /** The shared discard flow behind the banner's one-click Discard (§7). Its
   *  `busy` disables the button; no dialog ever opens from Collect. */
  unsavedDiscard: CaptureDeletionState;

  /** Index of the just-saved episode (flashes its strip chip), cleared shortly after. */
  lastSavedIndex: number | null;

  // Next-recording topic selection (resolved from config default_topics + the
  // uiStore Monitor picker; the picker checkboxes are another screen's task —
  // Collect only consumes the store).
  selection: RecordSelection;
  /** True only when the operator explicitly cleared every topic — disables
   *  Start (v1 LiveTab parity). */
  noSelection: boolean;
  /** Roster exists but no name picked — Start is refused until the OP chip
   *  names someone (attribution gate; empty roster gates nothing). */
  operatorMissing: boolean;

  /** The recorded count is a lower bound (see MachineState.recordedIsFloor). */
  recordedIsFloor: boolean;

  // context
  /** `null` when there is no plan catalog to name one from — the header renders
   *  that state instead of a placeholder, and it never reaches the wire. */
  project: string | null;
  task: string | null;
  condition: string;
  /** Planned episodes for the current batch (server target_episodes). */
  targetEpisodes: number;
  ctxEditable: boolean;
  condAllowed: boolean;
  endReason: string;

  // pickers / menu / modals
  batchMenuOpen: boolean;
  robotPickerOpen: boolean;
  toggleRobotPicker: () => void;
  projPickerOpen: boolean;
  taskPickerOpen: boolean;
  endModalOpen: boolean;
  condModalOpen: boolean;
  resetModalOpen: boolean;
  targetModalOpen: boolean;
  /** Keyboard-shortcuts help sheet (opened with `?`). */
  shortcutsOpen: boolean;
  /** Browser-local recording cue settings popover. */
  soundMenuOpen: boolean;
  toggleBatchMenu: () => void;
  openProjPicker: () => void;
  openTaskPicker: () => void;
  openCondModal: () => void;
  openTargetModal: () => void;
  /** Set the batch's planned episode count (clamped 1-500; PATCHes the server
   *  batch when one exists). */
  changeTarget: (target: number) => void;
  openEndModal: () => void;
  openResetModal: () => void;
  openShortcuts: () => void;
  toggleSoundMenu: () => void;
  closeModals: () => void;

  // Discard this take (§7): a DISCARD, not a delete — the data was never worth
  // keeping. One click, no dialog (user decision 2026-08-03): the press is the
  // consent, and the ledger records that no reason was asked. The flow's
  // `busy`/`failures` still drive the button state and the job-voiced errors.
  episodeDiscard: CaptureDeletionState;
  /** True unless this is a CONFIRMED single-host deploy: on a split deploy the
   *  robot keeps its own copy, so a discard only removes what is on this
   *  machine and the success toast must say so (§12). Fails toward disclosing
   *  while the probe is unanswered (S3-7 — `useRobotCopyMayRemain`). */
  splitDeploy: boolean;
  /** `run_YYYYMMDD_HHMMSS` of the take being labeled. DISPLAY ONLY (§1). */
  currentRunLabel: string | null;

  // advice pager
  adviceIdx: number;
  advicePrev: () => void;
  adviceNext: () => void;

  // toast
  toast: string;

  /** Browser-local opt-in cues. Audio is supplemental: playback failure never
   *  changes recorder state or hides the persistent visual/ARIA feedback. */
  recordingCueSettings: RecordingCueSettings;

  // actions
  startRecording: () => void;
  cancelArming: () => void;
  /** Whether the arming Cancel may be used yet (#8 — see
   *  ARMING_CANCEL_GUARD_MS). False for the phase's first moments, so the tail
   *  of a double-click on Start cannot back out of the take it just began.
   *  Read by the control AND checked inside `cancelArming`, the same
   *  belt-and-braces as `canStop`: a guard that only lives on the button is
   *  walked around by the Escape shortcut. */
  canCancelArming: boolean;
  stopRecording: () => void;
  /** Whether Stop may be used yet, and if not, why (M2 — see STOP_FLOOR_MS). */
  canStop: boolean;
  stopBlockedReason: StopBlockedReason;
  /** True once a /record/status poll has failed: the recorder is not answering
   *  and nothing derived from its last response may be presented as current. */
  recorderUnreachable: boolean;
  /** Milliseconds since the last SUCCESSFUL poll, for "last known: …, Ns ago".
   *  Null when there has never been one. */
  recorderStaleMs: number | null;
  /** Seconds the post-stop confirmation has been waiting on the recorder's
   *  flush; null outside that wait. Drives the SAVING card's honest progress
   *  line instead of an error. */
  stopFlushSeconds: number | null;
  /** Re-attempt a stop that failed (stays in SAVING). */
  retryStop: () => void;
  pickSuccess: () => void;
  pickFailure: () => void;
  pickFailReason: (reason: string) => void;
  /** Save the review on the capture (§4.1 compare-and-swap). Resolves only once
   *  the server accepted it — the strip chip and the receipt never claim a save
   *  that did not happen (§12). */
  confirmEpisode: () => void;
  /** True while that save is in flight. */
  isSavingReview: boolean;
  /** The rejected save, kept until the operator acts on it. A 409 means someone
   *  else edited the capture (re-apply); a 500 means NOTHING was saved. */
  saveError: unknown;
  /** Dismiss that message once the operator has read it (§12: it is never
   *  cleared on a timer). */
  dismissSaveError: () => void;
  /** One-click discard of the take being labeled — immediate, no dialog. */
  discardEpisode: () => void;
  /** Discard THIS take (ledger reason: superseded by retake) and go straight
   *  back to recording under the same labels — the operator's most-repeated
   *  recovery, previously discard → re-arm → start by hand. */
  retakeEpisode: () => void;
  pauseBatch: () => void;
  resumeBatch: () => void;
  pickEndReason: (reason: string) => void;
  confirmEndBatch: () => void;
  startNextBatch: () => void;
  /** Reset the batch (counts → 0/30, recordings kept in Review). */
  resetBatch: () => void;
  pickProject: (name: string) => void;
  pickTask: (name: string) => void;
  /** Set a free-text task the operator typed (v1 parity — recording accepted any
   *  task string). Not added to the plans store; flows into the next
   *  /record/start and /batches as-is. */
  pickCustomTask: (name: string) => void;
  pickCondition: (condition: string) => void;
  /** Set a free-text condition the operator typed in the condition modal. Not
   *  added to the plans catalog; behaves exactly like a catalog condition
   *  afterwards (a string on the batch). Rolls it over when the current batch
   *  already has a recording, same as pickCondition. */
  pickCustomCondition: (condition: string) => void;
  /** Jump to the Monitor tab (Warnings card's "Open in Monitor →"). */
  goMonitor: () => void;
}
