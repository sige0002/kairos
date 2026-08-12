// One tab stop for a group of mutually exclusive options (#17).
//
// The camera resolution chips are radio buttons wearing button clothes: five on
// the main tile, two on every sub tile, exactly one selected. As plain buttons
// they were each a tab stop, so Tab out of Start walked nine tiny chips before
// reaching anything the operator came to the screen for (beta A-08) — and,
// because selectedness lived only in a background colour, a screen-reader user
// could not tell which resolution was current anyway.
//
// Both are the same fix: make the group what it already is. A radiogroup is one
// tab stop, arrows move within it, and `aria-checked` says which one is on.
// That is the standard composite-widget pattern, so it costs no invention — and
// it is why the roving tabindex here is not a trick to shorten the tab order
// but the accessible shape of the control.
//
// For radios, focus follows selection: an arrow key both moves and selects.
// That is the documented radiogroup behaviour, and it is right for these
// specifically because switching preview resolution is instant and free to undo
// — there is nothing to confirm and nothing to lose by trying the next one.

import { useCallback, useRef } from 'react';

/** Marks the focusable items inside the group, so the hook can find them
 *  without the caller wiring a ref per option. */
export const ROVING_ITEM_ATTR = 'data-roving-item';

export interface RovingRadio<T extends string> {
  /** Put on the element carrying `role="radiogroup"`. */
  groupRef: React.MutableRefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** 0 for the selected option, -1 for the rest: the group is one tab stop,
   *  and Tab lands on whichever option is currently on. */
  itemTabIndex: (option: T) => 0 | -1;
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const current = options.indexOf(value as T);
      const last = options.length - 1;
      let next: number;
      switch (e.key) {
        // Both axes, because the group is horizontal on screen but a caller
        // could stack it, and a radiogroup answers to either pair.
        case 'ArrowRight':
        case 'ArrowDown':
          next = current >= last ? 0 : current + 1;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = current <= 0 ? last : current - 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        default:
          return;
      }
      // Arrow keys scroll the page by default, and this group lives on an
      // overlay inside a scrollable screen.
      e.preventDefault();
      const picked = options[next];
      if (picked === undefined) return;
      onPick(picked);
      // Move focus with the selection. The buttons are keyed by option, so the
      // element survives the re-render and can be focused straight away; a
      // programmatic focus() works regardless of the tabIndex it is about to
      // be given.
      groupRef.current
        ?.querySelectorAll<HTMLElement>(`[${ROVING_ITEM_ATTR}]`)
        ?.[next]?.focus();
    },
    [options, value, onPick],
  );

  const itemTabIndex = useCallback(
    (option: T): 0 | -1 => (option === value ? 0 : -1),
    [value],
  );

  return { groupRef, onKeyDown, itemTabIndex };
}
