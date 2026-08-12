// The phase-driven control card (left column, top): READY / ARMING /
// RECORDING / SAVING+QUICK-CHECK / EPISODE RESULT / PAUSED / ENDED / COMPLETED —
// or, when a recording is running that this screen isn't driving, the takeover
// card (D-1). Exactly one renders at a time, keyed off `machine`.
//
// Each phase's markup lives in `control/`; this file dispatches to it. What
// stays here is the state that OUTLIVES a phase, because staying here is what
// makes it outlive the phase: the focus effect (ONE effect over ONE dependency
// list, covering every phase at once), the two-step "Start next set" confirm
// shared by ENDED and COMPLETED, and the quality expander, which stays open
// across episodes. Pushing any of them into a card would silently reset it on
// the next phase change.

import { useEffect, useRef, useState } from 'react';
import type { BatchMachine } from './useBatchMachine';
import { useFailReasons } from '../plans';
import { useActivationGuard } from './hooks/useActivationGuard';
import { ARMING_CANCEL_GUARD_MS } from './machine/types';
import { ArmingCard } from './control/ArmingCard';
import { CompletedCard } from './control/CompletedCard';
import { EndedCard } from './control/EndedCard';
import { PausedCard } from './control/PausedCard';
import { ReadyCard } from './control/ReadyCard';
import { RecordingCard } from './control/RecordingCard';
import { ResultCard } from './control/ResultCard';
import { SavingCard } from './control/SavingCard';
import { TakeoverCard } from './control/TakeoverCard';

export function ControlCard({ machine }: { machine: BatchMachine }) {
  const { phase } = machine;
  const takeover = machine.takeover;
  // Live fail-reason vocabulary (Settings > Failure reasons; shared store).
  // Read here, not in the result card, so the plans sync it kicks off on mount
  // happens when the screen appears rather than when an episode ends.
  const failReasons = useFailReasons();

  // Two-step confirm for "Start next set": one click used to silently clear
  // the finished set's panel (episodes stay in Review, but the operator can't
  // know that) — the first press now asks, the second acts. Auto-reverts.
  const [confirmNextSet, setConfirmNextSet] = useState(false);
  useEffect(() => {
    if (!confirmNextSet) return;
    const t = setTimeout(() => setConfirmNextSet(false), 5000);
    return () => clearTimeout(t);
  }, [confirmNextSet]);
  const onStartNextSet = () => {
    if (!confirmNextSet) {
      setConfirmNextSet(true);
      return;
    }
    setConfirmNextSet(false);
    machine.startNextBatch();
  };

  // Focus targets for each phase (D-4): re-target on every phase change so the
  // flow stays keyboard-operable and focus never falls to <body>.
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const savingTitleRef = useRef<HTMLSpanElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const failReasonRef = useRef<HTMLButtonElement>(null);
  const takeoverStopRef = useRef<HTMLButtonElement>(null);
  const hasTakeover = !!takeover;

  // ARMING's Cancel sits where Start just was, so the tail of a double-click
  // used to back out of the take the first press began (#8). The guard lives
  // here rather than in ArmingCard because the focus effect below has to know
  // about it: focus() on a disabled button is a no-op.
  const cancelArmed = useActivationGuard(
    phase === 'arming' && !hasTakeover,
    ARMING_CANCEL_GUARD_MS,
  );

  useEffect(() => {
    if (hasTakeover) {
      takeoverStopRef.current?.focus();
      return;
    }
    switch (phase) {
      case 'ready':
        startRef.current?.focus();
        break;
      case 'arming':
        cancelRef.current?.focus();
        break;
      case 'recording':
        stopRef.current?.focus();
        break;
      case 'saving':
      case 'quickcheck':
        savingTitleRef.current?.focus();
        break;
      case 'result':
        if (machine.pendingTask === 'fail') failReasonRef.current?.focus();
        else saveRef.current?.focus();
        break;
    }
    // `machine.canStop` is a dependency because focus() on a DISABLED button is
    // a no-op: Stop is disabled for the first STOP_FLOOR_MS of every take, so
    // the recording branch above fired while there was nothing to focus, and
    // without re-running when Stop becomes enabled focus stayed on <body> for
    // the WHOLE take. (Second effect-dependency bug of this shape: the logic was
    // right and the deps made it read a stale world.)
    //
    // `cancelArmed` is here for exactly the same reason, one phase earlier.
  }, [phase, machine.pendingTask, hasTakeover, machine.canStop, cancelArmed]);

  // Quality override expander (D-2): collapsed by default; opening it reveals the
  // three chips. Auto-open once the operator has already overridden.
  const [qualityOpen, setQualityOpen] = useState(false);

  if (takeover) {
    return (
      <TakeoverCard machine={machine} takeover={takeover} stopRef={takeoverStopRef} />
    );
  }

  if (phase === 'ready') {
    return <ReadyCard machine={machine} startRef={startRef} />;
  }

  if (phase === 'arming') {
    return <ArmingCard machine={machine} cancelRef={cancelRef} cancelArmed={cancelArmed} />;
  }

  if (phase === 'recording') {
    return <RecordingCard machine={machine} stopRef={stopRef} />;
  }

  if (phase === 'saving' || phase === 'quickcheck') {
    return <SavingCard machine={machine} phase={phase} titleRef={savingTitleRef} />;
  }

  if (phase === 'result') {
    return (
      <ResultCard
        machine={machine}
        failReasons={failReasons}
        qualityOpen={qualityOpen}
        onToggleQuality={() => setQualityOpen((v) => !v)}
        saveRef={saveRef}
        failReasonRef={failReasonRef}
      />
    );
  }

  if (phase === 'paused') {
    return <PausedCard machine={machine} />;
  }

  if (phase === 'ended') {
    return (
      <EndedCard
        machine={machine}
        confirmNextSet={confirmNextSet}
        onStartNextSet={onStartNextSet}
      />
    );
  }

  // phase === 'completed'
  return (
    <CompletedCard
      machine={machine}
      confirmNextSet={confirmNextSet}
      onStartNextSet={onStartNextSet}
    />
  );
}
