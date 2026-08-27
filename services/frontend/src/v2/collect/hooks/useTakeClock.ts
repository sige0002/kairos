// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The take's clock and its honesty gates (E-28 / E-32 / B1), extracted from
// useBatchMachine.ts: the monotonic take baseline, the Stop floor (M2), the
// frozen-while-unreachable elapsed timer, the B1 recovery and healthy-end
// detection, the SAVING advance gate and the QUICK CHECK advance. Every
// dispatch here is a statement about the take's lifecycle, driven by the
// recorder's own signals — never synthesized.

import { useEffect, useRef, useState } from 'react';
import { TERMINAL_RECORD_STATES, type RecordState } from '../../../api/types';
import { i18n } from '../../../i18n';
import {
  QUICKCHECK_FALLBACK_MS,
  type Phase,
  type StopBlockedReason,
} from '../machine/types';
import {
  dispatch,
  getStopFloorMs,
  getStoreSnapshot,
  getTakeStartMono,
  setTakeStartMono,
} from '../machine/store';

export function useTakeClock({
  phase,
  currentCaptureId,
  recorderReachable,
  live,
  lastGoodAt,
  statusCaptureId,
  statusState,
  liveCaptures,
  integrity,
  showToast,
  onRecordingInterrupted,
}: {
  phase: Phase;
  currentCaptureId: string | null;
  recorderReachable: boolean;
  /** The recorder's live capture set; null = unknown, never "nothing" (§10). */
  live: string[] | null;
  /** Wall-clock stamp of the last successful poll (identity of the reading). */
  lastGoodAt: number | null;
  statusCaptureId: string | null | undefined;
  statusState: RecordState | undefined;
  liveCaptures: string[] | null;
  /** Recorder integrity gated to the current capture, or null. */
  integrity: string | null;
  showToast: (msg: string) => void;
  onRecordingInterrupted?: (captureId: string | null) => void;
}): {
  stopBlockedReason: StopBlockedReason;
  canStop: boolean;
  recorderStaleMs: number | null;
} {
  // When THIS take began, on the MONOTONIC clock. Shared by the Stop floor
  // below and the elapsed timer further down.
  //
  // The baseline belongs to the RECORDING, not to our connection: it is set
  // when the take begins and cleared when it ends. Re-deriving it whenever the
  // recorder's reachability changed restarted the clock at 00:00:00 the moment
  // an outage ended, presenting a brand-new elapsed time for a take that had
  // been running — or had already died — throughout.
  //
  // E-32: `performance.now()`, not `Date.now()`. Both figures derived from this
  // baseline are DURATIONS measured entirely on this machine, and the wall
  // clock is not a stopwatch — NTP steps it, and a console left recording for
  // hours on a robot PC that just got its network back is the ordinary case.
  // A backwards step subtracted itself from the elapsed figure, which
  // `formatElapsed` then clamped to `00:00:00` — indistinguishable from a take
  // that has not started, and stuck there for as long as the step was large.
  // Server-stamped times (`started_at`, the recorder's last answer) stay on the
  // wall clock: they come from another process, and the monotonic clock has no
  // meaning across machines.
  //
  // E-28: the baseline itself lives in the module store (`takeStartMono`), not
  // in a ref, so it outlives this screen's unmount the way the take does.
  useEffect(() => {
    if (phase !== 'recording') {
      setTakeStartMono(null);
      return;
    }
    if (getTakeStartMono() == null) setTakeStartMono(performance.now());
  }, [phase]);

  // M2: Start and Stop occupy the SAME position — START_SUCCEEDED swaps the
  // ready card for the recording card — so the second half of a real
  // double-click lands on Stop. qa-ui measured the result: a start at T+0 and
  // its own stop at T+86ms, an 87ms bag that then had to be reviewed like a
  // real take.
  //
  // A minimum age is the whole guard. 86ms is nowhere near a second and no
  // deliberate take is that short, so the floor defeats the accident outright.
  //
  // Deliberately NOT also gated on the recorder acknowledging the capture: the
  // stop path already refuses a stop the recorder has not honoured (it stays in
  // SAVING while `live_capture_ids` still names the capture), so a second gate
  // here would add nothing except a window — up to a poll interval — in which
  // an operator cannot end a recording. That is a worse failure than the
  // accident being prevented, and B1 is exactly the case where the recorder
  // goes quiet mid-take.
  //
  // For the same reason the floor is measured on the take's own clock rather
  // than on `elapsedMs`. That figure deliberately FREEZES when the recorder stops
  // answering (B1 below), so a recorder that died inside the first second left
  // it parked under the floor and Stop disabled for the rest of the take —
  // keyboard path included, since S / Space go through `canStop` too. The floor
  // asks how old the take is, which is a fact we still hold when the recorder
  // is gone; a stop we cannot deliver then fails loudly, which is honest, while
  // refusing to attempt it is a trap.
  const [stopFloorPassed, setStopFloorPassed] = useState(false);
  useEffect(() => {
    if (phase !== 'recording') {
      setStopFloorPassed(false);
      return;
    }
    // Runs after the baseline effect above (declaration order), so the take's
    // start is already set for the render that made this a recording.
    const now = performance.now();
    const remaining = getStopFloorMs() - (now - (getTakeStartMono() ?? now));
    if (remaining <= 0) {
      setStopFloorPassed(true);
      return;
    }
    setStopFloorPassed(false);
    const id = setTimeout(() => setStopFloorPassed(true), remaining);
    return () => clearTimeout(id);
  }, [phase]);

  const stopBlockedReason: StopBlockedReason =
    phase === 'recording' && !stopFloorPassed ? 'floor' : null;
  const canStop = phase === 'recording' && stopBlockedReason === null;

  // ---- recording elapsed timer ---------------------------------------------
  // A slow clock that runs ONLY while the recorder is silent, so the
  // "last known … Ns ago" figure keeps climbing while the elapsed timer is
  // frozen. One second is enough for a number read in seconds, and it stops
  // entirely once the recorder answers again.
  //
  // Monotonic for the same reason as the take's baseline above (E-32): the AGE
  // of a reading is a duration on this machine. Measured wall-clock against the
  // query cache's `dataUpdatedAt`, a backwards NTP step drove the difference
  // negative and the clamp rendered it as "0s ago" — a positive claim that a
  // recorder which has been silent for a minute just answered, which is the one
  // presentation `useRecordStatus` exists to prevent.
  const [staleNowMs, setStaleNowMs] = useState(() => performance.now());
  useEffect(() => {
    if (recorderReachable) return;
    setStaleNowMs(performance.now());
    const id = setInterval(() => setStaleNowMs(performance.now()), 1000);
    return () => clearInterval(id);
  }, [recorderReachable]);

  // Our own monotonic mark of WHEN the last good reading landed. The query's
  // `lastGoodAt` is a wall-clock epoch stamp and stays one — it is the identity
  // of the reading, and what tells us a new one arrived — but the age is
  // measured from this.
  const lastGoodMonoRef = useRef<number | null>(null);
  useEffect(() => {
    lastGoodMonoRef.current = lastGoodAt == null ? null : performance.now();
  }, [lastGoodAt]);

  useEffect(() => {
    if (phase !== 'recording') return;
    // B1: freeze the elapsed clock while the recorder is silent. An animating
    // timer is an active claim that a recording is progressing, and once the
    // poll fails we have no evidence of that — qa-ui watched it climb
    // 00:12 → 00:37 against a recorder that had been dead the whole time. The
    // last value stays on screen, labelled as last-known.
    if (!recorderReachable) return;
    const id = setInterval(() => {
      const takeStart = getTakeStartMono();
      if (takeStart == null) return;
      dispatch({ type: 'TICK', elapsedMs: performance.now() - takeStart });
    }, 250);
    return () => clearInterval(id);
  }, [phase, recorderReachable]);

  // B1-recovery: the recorder is answering again, so everything the machine
  // believed through the outage is checkable — and a local `recording` phase is
  // a claim nothing on the server supports. If our capture is not in the live
  // set, the take ended while we could not see it. Resuming RECORDING on stale
  // client state alone is how a tab shows a fresh 00:00:00 timer for a
  // recording that no longer exists.
  const wasUnreachableRef = useRef(false);
  useEffect(() => {
    if (!recorderReachable) {
      wasUnreachableRef.current = true;
      return;
    }
    if (!wasUnreachableRef.current) return;
    // Still cannot tell what is live — stay as we are rather than guessing.
    if (live === null) return;
    wasUnreachableRef.current = false;
    if (phase !== 'recording') return;
    const captureId = currentCaptureId;
    if (captureId && live.includes(captureId)) return; // genuinely still running
    onRecordingInterrupted?.(captureId);
    dispatch({ type: 'RECORDING_INTERRUPTED' });
    showToast(i18n.t('collect:recordingEndedWhileUnreachable'));
  }, [
    recorderReachable,
    live,
    phase,
    currentCaptureId,
    showToast,
    onRecordingInterrupted,
  ]);

  // A take that ends while we are watching and HEALTHY. The recovery above only
  // runs after an outage, so the two ways a recording ends without this screen
  // asking — the recorder's own MAX_RECORD_SECONDS backstop auto-stopping an
  // unattended run, and another terminal stopping ours — left the card claiming
  // RECORDING with a climbing clock indefinitely.
  //
  // THREE CONDITIONS AT ONCE, because the errors are not symmetric: being slow
  // to notice a dead take costs a stale screen, while abandoning a LIVE one
  // tells the operator their recording is over and invites them to start
  // another over the top of one still writing. So this fires only when the
  // recorder is reachable, is reporting a terminal state for OUR capture, and
  // an EXISTING live array does not name us.
  //
  // The live array is read as a positive signal only (§10): `null` means the
  // recorder is unreachable or its answer too old, never "nothing is live". And
  // the state field is only ours when `capture_id` matches — that field keeps
  // naming the LAST capture after a stop, so another session's completion would
  // otherwise end our take.
  const sawCaptureLiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== 'recording') return;
    if (!recorderReachable) return;
    const captureId = currentCaptureId;
    if (!captureId) return;
    // Note the sighting FIRST, and unconditionally: the recorder names a live
    // capture while reporting `recording`, which is not a terminal state, so
    // checking the state field before this would mean the sighting was never
    // recorded and the transition below could never be satisfied.
    if (live !== null && live.includes(captureId)) {
      sawCaptureLiveRef.current = captureId;
      return; // genuinely still running
    }
    if (statusCaptureId !== captureId) return;
    if (!statusState || !TERMINAL_RECORD_STATES.has(statusState)) return;
    if (live === null) return;
    // Only a TRANSITION is evidence. `live_capture_ids` is a positive signal
    // (§10), so an absence on its own says nothing — and the ordinary case for
    // an absence is a take the recorder has not caught up to yet, in the window
    // between our start returning and the first poll that names it. Concluding
    // "ended" there would abandon a take at the very moment it begins.
    //
    // Measured, not reasoned: without this, 38 existing tests went red, every
    // one of them a flow where the recorder simply never named the capture
    // live. That is the shape of the false positive this whole effect is
    // written to avoid, and the suite was full of it.
    if (sawCaptureLiveRef.current !== captureId) return;
    // The recovery effect above may have dispatched in this same commit; its
    // closure still reads `recording`. The reducer would ignore the second
    // dispatch, but the toast would not.
    if (getStoreSnapshot().phase !== 'recording') return;
    onRecordingInterrupted?.(captureId);
    dispatch({ type: 'RECORDING_INTERRUPTED' });
    showToast(i18n.t('collect:recordingEndedOnRecorder'));
  }, [
    phase,
    currentCaptureId,
    recorderReachable,
    statusCaptureId,
    statusState,
    live,
    showToast,
    onRecordingInterrupted,
  ]);

  // SAVING advances on the REAL stop event (stopMutation.onSuccess dispatches
  // SAVED). This secondary gate covers a tab-switch during saving: once the
  // recorder reports the current run finalised, advance even if the mutation's
  // callback was on an unmounted instance. A failed stop stays in SAVING (with
  // the Retry button) and never trips this (state is still 'recording' on the
  // recorder until a stop succeeds).
  useEffect(() => {
    if (phase !== 'saving') return;
    const forThisCapture =
      currentCaptureId == null || statusCaptureId === currentCaptureId;
    // `live_capture_ids` is the definitive answer to "is this still being
    // written" (§10). A capture still named there is not finalised whatever the
    // state field says, and advancing past it is the same mistake the stop
    // confirmation exists to prevent — reached by a different route.
    const stillLive =
      currentCaptureId != null && liveCaptures?.includes(currentCaptureId) === true;
    if (statusState === 'completed' && forThisCapture && !stillLive)
      dispatch({ type: 'SAVED' });
  }, [phase, currentCaptureId, statusState, statusCaptureId, liveCaptures]);

  // QUICK CHECK reads the recorder's real integrity (already on /record/status);
  // advance as soon as it lands for this run, with a fallback so an older backend
  // that never classifies integrity can't strand the operator.
  useEffect(() => {
    if (phase !== 'quickcheck') return;
    if (integrity != null) {
      dispatch({ type: 'QUICK_CHECK_DONE' });
      return;
    }
    const id = setTimeout(
      () => dispatch({ type: 'QUICK_CHECK_DONE' }),
      QUICKCHECK_FALLBACK_MS,
    );
    return () => clearTimeout(id);
  }, [phase, integrity]);

  return {
    stopBlockedReason,
    canStop,
    recorderStaleMs:
      !recorderReachable && lastGoodMonoRef.current != null
        ? Math.max(0, staleNowMs - lastGoodMonoRef.current)
        : null,
  };
}
