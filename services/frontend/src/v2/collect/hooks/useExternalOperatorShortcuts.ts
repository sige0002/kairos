// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Keyboard driver for the three external operator actions (#36): the
// documented chords Ctrl+Alt+1/2/3 (LEFT/CENTER/RIGHT) on the window,
// dispatched through the EXISTING machine actions — the handler never calls
// the record APIs directly. The same input guards as the R/S/Space layer
// apply (typing, registered overlays), plus the ones a hands-busy operator
// demands: no auto-repeat, keydown latching so one physical press produces at
// most one logical action, and takeover/saving/unsupported states — all of
// them encoded in the shared meaning resolution, so a press that is not
// allowed simply has nothing to dispatch.

import { useEffect, useRef } from 'react';
import { i18n } from '../../../i18n';
import {
  externalActionSlotForCode,
  externalActionSlotForEvent,
  type ExternalActionMeanings,
  type ExternalActionSlot,
} from '../machine/externalActions';

export function useExternalOperatorShortcuts({
  meanings,
  taskName,
  anyOverlayOpen,
  startRecording,
  stopRecording,
  pickFailure,
  retakeEpisode,
  saveSuccess,
  saveFailureWithReason,
  showToast,
  onInvalidAction,
}: {
  meanings: ExternalActionMeanings;
  taskName: string | null;
  anyOverlayOpen: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  pickFailure: () => void;
  retakeEpisode: () => void;
  saveSuccess: () => void;
  saveFailureWithReason: (reason: string) => void;
  showToast: (message: string) => void;
  onInvalidAction: () => void;
}): void {
  // Refs keep the window listener stable while always acting on the CURRENT
  // meanings/actions (the same belt-and-braces as useCollectShortcuts).
  const meaningsRef = useRef(meanings);
  meaningsRef.current = meanings;
  const taskNameRef = useRef(taskName);
  taskNameRef.current = taskName;
  const overlayOpenRef = useRef(anyOverlayOpen);
  overlayOpenRef.current = anyOverlayOpen;
  const actionsRef = useRef({
    startRecording,
    stopRecording,
    pickFailure,
    retakeEpisode,
    saveSuccess,
    saveFailureWithReason,
    showToast,
    onInvalidAction,
  });
  actionsRef.current = {
    startRecording,
    stopRecording,
    pickFailure,
    retakeEpisode,
    saveSuccess,
    saveFailureWithReason,
    showToast,
    onInvalidAction,
  };
  // Keydown latching: a slot that is still "held down" (no keyup yet) cannot
  // fire again. Held pedals re-emit keydown; one press = at most one action.
  const heldSlotsRef = useRef<Set<ExternalActionSlot>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slot = externalActionSlotForEvent(e);
      if (!slot) return;
      // The same typing guard as the R/S layer: a keystroke aimed at an input
      // is data, not a command.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (target?.isContentEditable ?? false);
      if (typing) return;
      // While an overlay is open it owns the keys (it may have its own
      // chords); an unregistered overlay would have been caught by the
      // `?`/R/S layer already.
      if (overlayOpenRef.current) return;
      // Auto-repeat of a held key is a REPEAT of the same physical press.
      if (e.repeat) return;
      if (heldSlotsRef.current.has(slot)) return;
      heldSlotsRef.current.add(slot);
      e.preventDefault();
      const meaning = meaningsRef.current[slot];
      const actions = actionsRef.current;
      switch (meaning.kind) {
        case 'start':
          actions.startRecording();
          break;
        case 'stop':
          actions.stopRecording();
          break;
        case 'pick-failure':
          actions.pickFailure();
          break;
        case 'retake':
          actions.retakeEpisode();
          break;
        case 'save-success':
          actions.saveSuccess();
          break;
        case 'save-failure-reason':
          actions.saveFailureWithReason(meaning.reason);
          break;
        case 'unassigned': {
          actions.onInvalidAction();
          // Visible feedback, no save, no silent fallback (#36 / #37).
          const name = taskNameRef.current;
          actions.showToast(
            i18n.t('collect:externalUnassignedToast', {
              slot: slot.toUpperCase(),
              task: name
                ? i18n.t('collect:externalUnassignedTask', { task: name })
                : '',
            }),
          );
          break;
        }
        case 'disabled':
          actions.onInvalidAction();
          // The HUD shows the slot disabled and why; a press has nothing to do.
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Release on the DIGIT's keyup regardless of modifier state: on a real
      // keyboard Ctrl/Alt are released BEFORE the digit, so Digit1/2/3's
      // keyup arrives with the chords already dropped — matching the chord
      // here would leave the slot latched until the window is blurred.
      const slot = externalActionSlotForCode(e.code);
      if (slot) heldSlotsRef.current.delete(slot);
    };
    // Browsers do not guarantee a keyup after the window loses focus. Clear
    // the latch on blur so returning to Collect never turns the next physical
    // press into a silently swallowed stale hold.
    const clearHeldSlots = () => heldSlotsRef.current.clear();
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearHeldSlots);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearHeldSlots);
      clearHeldSlots();
    };
  }, []);
}
