// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The current validation run, parked in module scope.
//
// App.tsx renders only the active tab, so the Validation screen is UNMOUNTED
// whenever the operator switches away. Holding the run in component state meant
// leaving the tab erased every trace of it — while the jobs themselves kept
// running on the server. The operator came back to an idle-looking screen with
// work they could neither see nor stop, which is the half of the endurance
// finding that Cancel alone does not fix.
//
// Same idiom as the collect machine store and splitMode: module-level state +
// useSyncExternalStore, so the values survive the unmount and every mounted
// reader sees one copy.
//
// Deliberately NOT persisted across a reload. There is no server-side "run"
// resource to restore from — a run is this screen's grouping of N jobs — so a
// rehydrated run would be a claim we cannot re-check: its jobs may have
// finished, or been cancelled from another browser, long before. A reload
// legitimately starts from nothing, and the jobs remain reachable by id.

import { useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { JobState } from '../../api/types';
import type { Summary } from '../../features/validation/SummaryResult';
import type { RequiredTopic } from './resultsMapping';

export interface JobRef {
  capture_id: string;
  job_id: string;
}

/** A capture the run could not start a job for, and why in the operator's
 *  terms. Kept per capture rather than collapsed into one error: a preset runs
 *  over many captures, and "which ones did not run" is the whole question. */
export interface SubmitFailure {
  captureId: string;
  reason: string;
}

export interface ActiveRun {
  pipeline: string;
  jobs: JobRef[];
  /** Captures skipped because their job could not be created — most often a
   *  capture discarded or deleted since the preset's pending list was built. */
  failures: SubmitFailure[];
  // fast_validation only: the template's required topics, so the checklist card
  // can show found (✓) rows, not just the summary's `missing` entries.
  requiredTopics?: RequiredTopic[];
}

export interface JobProbeUpdate {
  jobId: string;
  captureId: string;
  state: JobState;
  progress: number;
  terminal: boolean;
  /** A cancel is in flight but the work has not stopped yet (still running). */
  cancelRequested?: boolean;
  summary?: Summary;
  artifacts?: string[];
  resultErrored: boolean;
}

export interface ValidationRunState {
  active: ActiveRun | null;
  jobStates: Record<string, JobProbeUpdate>;
  selectedCaptureId: string | null;
}

const EMPTY: ValidationRunState = {
  active: null,
  jobStates: {},
  selectedCaptureId: null,
};

interface StoredState extends ValidationRunState {
  /** The QueryClient this run's job data lives in.
   *
   *  A run is only reportable alongside the job-status cache its readings came
   *  from: `jobStates` is what the probes read out of THAT client, and the
   *  probes can only refresh it there. One page load has exactly one client, so
   *  this changes on a reload (where we deliberately restore nothing) and never
   *  on a tab switch (where restoring is the whole point).
   *
   *  Readers under a different client are shown nothing rather than a run they
   *  could neither refresh nor stop. */
  owner: object | null;
}

let state: StoredState = { ...EMPTY, owner: null };
const listeners = new Set<() => void>();

function setState(next: StoredState): void {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StoredState {
  return state;
}

export function useValidationRun(): ValidationRunState {
  const client = useQueryClient();
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return stored.owner === client ? stored : EMPTY;
}

/** A new run replaces the old one outright — its per-job states belong to jobs
 *  that are no longer on screen. `owner` is the QueryClient the caller submitted
 *  the jobs through. */
export function startRun(run: ActiveRun, owner: object): void {
  setState({
    active: run,
    jobStates: {},
    selectedCaptureId: run.jobs[0]?.capture_id ?? null,
    owner,
  });
}

/** Fold one probe reading in. Unchanged readings are dropped rather than
 *  written, because every write re-renders every reader and the probes report
 *  on each poll whether or not anything moved. */
export function recordJobUpdate(update: JobProbeUpdate): void {
  const cur = state.jobStates[update.jobId];
  if (
    cur &&
    cur.state === update.state &&
    cur.progress === update.progress &&
    cur.terminal === update.terminal &&
    cur.cancelRequested === update.cancelRequested &&
    cur.summary === update.summary
  ) {
    return;
  }
  setState({
    ...state,
    jobStates: { ...state.jobStates, [update.jobId]: update },
  });
}

export function selectRunCapture(captureId: string): void {
  setState({ ...state, selectedCaptureId: captureId });
}

/** Test seam (the store outlives a single render tree by design). */
export function __resetValidationRun(): void {
  setState({ ...EMPTY, owner: null });
}
