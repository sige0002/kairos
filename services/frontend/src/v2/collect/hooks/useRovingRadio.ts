// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// One tab stop for a group of mutually exclusive options (#17), where choosing
// one is EXPENSIVE.
//
// The camera resolution chips are radio buttons wearing button clothes: five on
// the main tile, two on every sub tile, exactly one selected. As plain buttons
// they were each a tab stop, so Tab out of Start walked nine tiny chips before
// reaching anything the operator came to the screen for (beta A-08) — and,
// because selectedness lived only in a background colour, a screen-reader user
// could not tell which resolution was current anyway. Making the group what it
// already is — a radiogroup, one tab stop, `aria-checked` saying which is on —
// fixes both.
//
// WHAT SELECTING ONE COSTS, because this is the whole reason for the shape
// below. A resolution change moves `maxWidth`/`maxHeight`, which are effect
// dependencies in useWebRtcStream: the peer connection is closed, a new one is
// built, and a fresh /stream/start is POSTed to the robot. The preview drops
// through `negotiating` every time.
//
// So this group uses APG's MANUAL activation: arrows and Home/End move FOCUS
// only, and Space or Enter commits. The automatic variant — where the selection
// follows focus, as a plain radiogroup does — is wrong here and was measured
// being wrong: four arrow presses fired four renegotiations, walked the cap up
// to UNCAPPED `Source` on the third, and auto-repeat made it unbounded around
// the ring. That turned one renegotiation per INTENT into one per KEYSTROKE,
// pointed at a robot. Manual activation is the documented accommodation for
// exactly this: when activating a choice is costly, do not activate it by
// accident.
//
// `commit` is idempotent by design. Committing the option that is already
// selected does nothing at all, so the two paths that can both fire for one
// press (this hook's Space handling, and a browser that still activates the
// button on keyup) cannot produce a second renegotiation between them.

import { useCallback, useRef, useState } from 'react';

/** Marks the focusable items inside the group, so the hook can find them
 *  without the caller wiring a ref per option. */
export const ROVING_ITEM_ATTR = 'data-roving-item';

export interface RovingRadio<T extends string> {
  /** Put on the element carrying `role="radiogroup"`. */
  groupRef: React.MutableRefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /**
   * 0 for the option Tab lands on, -1 for the rest — the group is one tab stop.
   *
   * That option is the SELECTED one until the arrows move focus somewhere else,
   * and then it is wherever focus went: with manual activation the tab stop
   * has to follow focus, or arrowing to an option and pressing Tab would drop
   * the operator somewhere they had already left.
   */
  itemTabIndex: (option: T) => 0 | -1;
  /** Select an option, from a click or from Space/Enter. A no-op when it is
   *  already selected, so nothing renegotiates for a choice already made. */
  commit: (option: T) => void;
}

export function useRovingRadio<T extends string>({
  options,
  value,
  onPick,
}: {
  options: readonly T[];
  value: T;
  onPick: (option: T) => void;
}): RovingRadio<T> {
  const groupRef = useRef<HTMLDivElement | null>(null);
  // Where focus has been arrowed to, when that is not the selection. Null means
  // "on the selection", which is where the group starts and where it returns
  // after a commit.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const checkedIndex = Math.max(0, options.indexOf(value as T));
  const activeIndex = focusedIndex ?? checkedIndex;

  const commit = useCallback(
    (option: T) => {
      setFocusedIndex(null);
      // Idempotent: re-choosing the current resolution would otherwise cost a
      // full renegotiation for no change at all.
      if (option !== value) onPick(option);
    },
    [onPick, value],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const last = options.length - 1;
      let next: number;
      switch (e.key) {
        // Both axes, because the group is horizontal on screen but a caller
        // could stack it, and a radiogroup answers to either pair.
        case 'ArrowRight':
        case 'ArrowDown':
          next = activeIndex >= last ? 0 : activeIndex + 1;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = activeIndex <= 0 ? last : activeIndex - 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        case ' ':
        case 'Spacebar':
        case 'Enter': {
          // The commit key. Handled here rather than left to the button's own
          // activation so the behaviour is the same in every browser and can be
          // asserted; preventDefault also stops Space scrolling the screen
          // under the camera wall.
          e.preventDefault();
          const option = options[activeIndex];
          if (option !== undefined) commit(option);
          return;
        }
        default:
          return;
      }
      // Arrow keys scroll by default, and this group lives on an overlay inside
      // a scrollable screen.
      e.preventDefault();
      setFocusedIndex(next);
      groupRef.current
        ?.querySelectorAll<HTMLElement>(`[${ROVING_ITEM_ATTR}]`)
        ?.[next]?.focus();
    },
    [options, activeIndex, commit],
  );

  const itemTabIndex = useCallback(
    (option: T): 0 | -1 => (options.indexOf(option) === activeIndex ? 0 : -1),
    [options, activeIndex],
  );

  return { groupRef, onKeyDown, itemTabIndex, commit };
}
