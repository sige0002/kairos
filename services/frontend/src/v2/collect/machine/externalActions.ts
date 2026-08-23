// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The three logical external operator actions (LEFT / CENTER / RIGHT) — the
// vendor-neutral vocabulary a foot pedal (or a keyboard) can trigger during
// collection (#36). Pure resolution: ONE function derives the CURRENT meaning
// of each slot from the machine state, and BOTH the HUD and the shortcut
// handler consume it, so the display can never drift from the behavior.
//
// No hardware is assumed: the slots describe the logical action, and the
// documented chords (Ctrl+Alt+1/2/3) are what a programmable HID pedal maps
// its three switches onto. Kairos detects nothing about any device.

import type { FailureShortcuts } from '../../plans';
import type { Phase } from './types';

export const EXTERNAL_ACTION_SLOTS = ['left', 'center', 'right'] as const;
export type ExternalActionSlot = (typeof EXTERNAL_ACTION_SLOTS)[number];

/** What pressing the slot DOES right now — derived, never stored. */
export type ExternalSlotMeaning =
  | { kind: 'disabled' }
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'pick-failure' }
  | { kind: 'retake' }
  | { kind: 'save-success' }
  | { kind: 'save-failure-reason'; reason: string }
  | { kind: 'unassigned' };

export type ExternalActionMeanings = Record<ExternalActionSlot, ExternalSlotMeaning>;

export interface ExternalActionContext {
  phase: Phase;
  pendingTask: 'ok' | 'fail' | null;
  /** A review save is in flight — a second save must not start. */
  isSavingReview: boolean;
  /** A recording is running that this screen isn't driving. */
  takeoverActive: boolean;
  /** READY's Start is usable (selection + operator gates cleared). */
  startEnabled: boolean;
  /** RECORDING's Stop is usable (the stop floor has passed). */
  stopEnabled: boolean;
  /** The current Task's configured slots (null = unassigned). */
  shortcuts: FailureShortcuts;
}

const DISABLED: ExternalSlotMeaning = { kind: 'disabled' };

function allDisabled(): ExternalActionMeanings {
  return { left: DISABLED, center: DISABLED, right: DISABLED };
}

/** The state table of #36, as one pure function.
 *
 *   READY:            CENTER = Start
 *   RECORDING:        CENTER = Stop
 *   SAVING/QUICKCHECK/ARMING/PAUSED/ENDED/COMPLETED: all disabled
 *   RESULT (before Failure): LEFT = Failure, CENTER = Retake,
 *                            RIGHT = Success + Save
 *   RESULT (Failure selected): LEFT/CENTER/RIGHT = the Task's three
 *                              configured reasons + Save (null slot =
 *                              unassigned: feedback only, never a save,
 *                              never a silent "Other" fallback)
 *   takeover / action in flight: all disabled
 *
 * Failure-reason meanings are ONLY reachable once Failure has been selected —
 * pressing a slot in READY or RECORDING can never stamp a reason. */
export function resolveExternalActionMeanings(
  ctx: ExternalActionContext,
): ExternalActionMeanings {
  // This guard must apply BEFORE phase resolution. Retake deletes transition
  // RESULT → READY before the shared deletion flow finishes invalidating the
  // capture cache; accepting READY's Start in that window would create a
  // second recording before Retake's queued restart resolves.
  if (ctx.takeoverActive || ctx.isSavingReview) return allDisabled();

  if (ctx.phase === 'ready') {
    return {
      left: DISABLED,
      center: ctx.startEnabled ? { kind: 'start' } : DISABLED,
      right: DISABLED,
    };
  }
  if (ctx.phase === 'recording') {
    return {
      left: DISABLED,
      center: ctx.stopEnabled ? { kind: 'stop' } : DISABLED,
      right: DISABLED,
    };
  }
  if (ctx.phase === 'result') {
    if (ctx.pendingTask === 'fail') {
      const slot = (s: ExternalActionSlot): ExternalSlotMeaning =>
        ctx.shortcuts[s] === null
          ? { kind: 'unassigned' }
          : { kind: 'save-failure-reason', reason: ctx.shortcuts[s]! };
      return { left: slot('left'), center: slot('center'), right: slot('right') };
    }
    return {
      left: { kind: 'pick-failure' },
      center: { kind: 'retake' },
      right: { kind: 'save-success' },
    };
  }
  // arming, saving, quickcheck, paused, ended, completed
  return allDisabled();
}

/** The exact documented chords (#36 / #37). Kept out of ordinary typing and of
 *  the existing R / S / Space / Esc / ? bindings, and emit-able by any generic
 *  HID macro device: a three-switch pedal programs 1 → LEFT, 2 → CENTER,
 *  3 → RIGHT and needs no Kairos change. */
export const EXTERNAL_ACTION_KEYS: Record<ExternalActionSlot, string> = {
  left: 'Ctrl+Alt+1',
  center: 'Ctrl+Alt+2',
  right: 'Ctrl+Alt+3',
};

/** Map a physical `code` to its slot, or null for "not one of ours".
 *
 * Reads `code` (physical key position), not `key`: the chord must mean the
 * same thing on every layout, and a programmable pedal emits fixed codes.
 * Kept modifier-FREE on purpose — a keyup arrives with the modifier state of
 * the moment it was released, and modifiers usually drop BEFORE the digit
 * (so a Digit2 keyup carries `ctrlKey: false, altKey: false`). The latch
 * release must key off the physical key alone, or the slot stays latched
 * forever and the next real press is silently swallowed. */
export function externalActionSlotForCode(code: string): ExternalActionSlot | null {
  switch (code) {
    case 'Digit1':
      return 'left';
    case 'Digit2':
      return 'center';
    case 'Digit3':
      return 'right';
    default:
      return null;
  }
}

/** Map a physical keydown event to a slot, or null for "not one of ours".
 *  The chord is Ctrl+Alt+Digit — no bare printable key, no browser default. */
export function externalActionSlotForEvent(event: {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}): ExternalActionSlot | null {
  if (!(event.ctrlKey && event.altKey) || event.metaKey || event.shiftKey) {
    return null;
  }
  return externalActionSlotForCode(event.code);
}

/** The HUD's one-word meaning of a slot, derived from the same resolution the
 *  handler uses ("—" reads as "does nothing here", which is the truth). */
export function externalActionMeaningLabel(meaning: ExternalSlotMeaning): string {
  switch (meaning.kind) {
    case 'disabled':
      return '—';
    case 'start':
      return 'Start';
    case 'stop':
      return 'Stop';
    case 'pick-failure':
      return 'Failure';
    case 'retake':
      return 'Retake';
    case 'save-success':
      return 'Success + Save';
    case 'save-failure-reason':
      return meaning.reason;
    case 'unassigned':
      return 'Unassigned';
  }
}
