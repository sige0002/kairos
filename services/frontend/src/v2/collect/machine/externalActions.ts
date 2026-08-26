// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The three logical external operator actions (LEFT / CENTER / RIGHT) — the
// vendor-neutral vocabulary a foot pedal (or a keyboard) can trigger during
// collection (#36, configurable per Collect state since #43). Pure
// resolution: ONE function derives the CURRENT meaning of each slot from the
// machine state AND the validated external-control mapping, and BOTH the HUD
// and the shortcut handler consume it, so the display can never drift from the
// behavior — including after a layout change.
//
// The mapping (externalControlConfig.ts) only CHOOSES among the actions the
// current state already allows; it grants nothing. The live guards below
// (takeover, save in flight, start/stop floors) always win over the mapping,
// and the state machine downstream remains the final authority.
//
// No hardware is assumed: the slots describe the logical action, and the
// documented chords (Ctrl+Alt+1/2/3) are what a programmable HID pedal maps
// its three switches onto. Kairos detects nothing about any device.

import type { FailureShortcuts } from '../../plans';
import type {
  ExternalControlAction,
  ExternalControlsConfig,
} from './externalControlConfig';
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
  /** The validated channel→action mapping for each state (#43). Always a
   *  trusted config: the store falls back to the safe default for anything
   *  it cannot read, so an invalid mapping never reaches this resolver. */
  config: ExternalControlsConfig;
}

/** Which of the Task's three reason slots each `reason_slot_N` action names.
 *  The mapping chooses WHICH slot a channel reads; the Task's
 *  `failure_shortcuts` still decides WHAT reason each slot holds (#35). */
const REASON_SLOT_TO_SHORTCUT: Partial<
  Record<ExternalControlAction, keyof FailureShortcuts>
> = {
  reason_slot_1: 'left',
  reason_slot_2: 'center',
  reason_slot_3: 'right',
};

const DISABLED: ExternalSlotMeaning = { kind: 'disabled' };

function allDisabled(): ExternalActionMeanings {
  return { left: DISABLED, center: DISABLED, right: DISABLED };
}

/** The external-control table of #36/#43, as one pure function.
 *
 *   READY:            the channel mapped to `start` starts
 *                     (disabled while the start gates are not cleared)
 *   RECORDING:        the channel mapped to `stop` stops
 *                     (disabled inside the stop floor)
 *   SAVING/QUICKCHECK/ARMING/PAUSED/ENDED/COMPLETED: all disabled
 *   RESULT (before Failure): the channels mapped to `failure` / `retake` /
 *                            `success_save`
 *   RESULT (Failure selected): the channels mapped to `reason_slot_N` save
 *                              that slot's Task reason + Save (empty slot =
 *                              unassigned: feedback only, never a save,
 *                              never a silent "Other" fallback)
 *   takeover / action in flight: all disabled
 *
 * A channel mapped to `none` (or to an action whose gate is closed) is
 * `disabled` — it does nothing, which is what the HUD shows. Failure-reason
 * meanings are ONLY reachable once Failure has been selected — pressing a
 * slot in READY or RECORDING can never stamp a reason, whatever the mapping. */
export function resolveExternalActionMeanings(
  ctx: ExternalActionContext,
): ExternalActionMeanings {
  // This guard must apply BEFORE phase resolution. Retake deletes transition
  // RESULT → READY before the shared deletion flow finishes invalidating the
  // capture cache; accepting READY's Start in that window would create a
  // second recording before Retake's queued restart resolves.
  if (ctx.takeoverActive || ctx.isSavingReview) return allDisabled();

  if (ctx.phase === 'ready') {
    const resolve = (slot: ExternalActionSlot): ExternalSlotMeaning =>
      ctx.config.ready[slot] === 'start' && ctx.startEnabled
        ? { kind: 'start' }
        : DISABLED;
    return {
      left: resolve('left'),
      center: resolve('center'),
      right: resolve('right'),
    };
  }
  if (ctx.phase === 'recording') {
    const resolve = (slot: ExternalActionSlot): ExternalSlotMeaning =>
      ctx.config.recording[slot] === 'stop' && ctx.stopEnabled
        ? { kind: 'stop' }
        : DISABLED;
    return {
      left: resolve('left'),
      center: resolve('center'),
      right: resolve('right'),
    };
  }
  if (ctx.phase === 'result') {
    if (ctx.pendingTask === 'fail') {
      const resolve = (slot: ExternalActionSlot): ExternalSlotMeaning => {
        const shortcutKey = REASON_SLOT_TO_SHORTCUT[ctx.config.failure_reason[slot]];
        if (shortcutKey === undefined) return DISABLED;
        const reason = ctx.shortcuts[shortcutKey];
        return reason === null
          ? { kind: 'unassigned' }
          : { kind: 'save-failure-reason', reason };
      };
      return {
        left: resolve('left'),
        center: resolve('center'),
        right: resolve('right'),
      };
    }
    const resolve = (slot: ExternalActionSlot): ExternalSlotMeaning => {
      switch (ctx.config.result[slot]) {
        case 'success_save':
          return { kind: 'save-success' };
        case 'failure':
          return { kind: 'pick-failure' };
        case 'retake':
          return { kind: 'retake' };
        case 'none':
          return DISABLED;
      }
      // The validated config makes this unreachable. Keep the resolver
      // fail-closed if a future action expands the shared union without also
      // defining its RESULT behavior here.
      return DISABLED;
    };
    return {
      left: resolve('left'),
      center: resolve('center'),
      right: resolve('right'),
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
