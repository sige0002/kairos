// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Touch targets that are bigger than they look.
//
// The console is dense by intent and is used on tablets, which are two facts
// that fight: nav tabs render 36px tall, the OP chip 32x32, the camera
// resolution chips 41x20 — all under the 44px touch guideline, and all
// measured that way in the beta (A-07). Growing them visually would undo the
// density the screens were designed around.
//
// So the VISUAL box stays and the INTERACTIVE box grows, via an absolutely
// positioned `::after` on the control. The pseudo-element is part of the
// button's rendered box and takes pointer events, but it is out of flow, so it
// changes no layout and moves no neighbour. Each control is `relative` so the
// overlay is measured against it.
//
// Two rules govern how far each one may grow, and they are why these constants
// are not all the same:
//
//   * NEVER PAST A NEIGHBOUR. Two overlapping hit areas are worse than one
//     small one: a tap aimed at 480p that lands on 360p is a wrong answer,
//     where a miss is merely no answer. Where the design leaves less room than
//     44px needs, the expansion stops at the neighbour and the control settles
//     for what fits. Each constant below records which of the two it is.
//   * NEVER OVER SOMETHING THAT MEANS SOMETHING ELSE. Expanding across a
//     readout (the camera stats chip) would turn "tap to read" into "tap to
//     change resolution" — inventing a mis-tap rather than fixing one.
//
// Exported as named constants rather than written inline so the tests can pin
// that a control HAS a hit area: jsdom computes no geometry, so what a unit
// test can honestly check is the mechanism, and the real measurement is a
// bounding-box pass on the acceptance stack.

/** Nav tabs: 36px tall, 4px of nav padding above and below. +4px each way is
 *  exactly 44 and exactly the padding, so the tabs' hit areas stop where the
 *  nav's own border begins. Their widths already clear 44 (the shortest label
 *  renders ~81px), so there is nothing to gain horizontally — and nothing to
 *  risk, since the 3px inter-tab gap is left alone. */
export const HIT_AREA_TAB = 'relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]';

/** The OP chip: 32x32, in a header whose gap is 16px. +6px each way reaches 44
 *  with 10px still between it and the connection badge — and that badge and
 *  the domain chip are both plain spans, so nothing interactive is under the
 *  expansion at all. */
export const HIT_AREA_CHIP = 'relative after:absolute after:-inset-1.5 after:content-[""]';

/** Main-tile resolution chips: ~54x20 as rendered (the label decides the
 *  width; the issue's "41" was a narrower sample), shoulder to shoulder in a
 *  segmented strip 12px above the tile's bottom edge. Measured live at 56x44
 *  with the expansion below.
 *
 *  Only the HEIGHT was ever the deficit — every chip already cleared 44 wide —
 *  and vertically there is room for all of it (+12 each way; downward lands on
 *  the tile edge, upward on video that carries no control of its own).
 *  Horizontally there is 2px between chips and a topic readout to the left, so
 *  the expansion takes half of each gap (+1px) and no more. Adjacent chips end
 *  up touching exactly, which for a segmented control is the right answer
 *  rather than a compromise: contiguous options mean every tap inside the
 *  strip selects something, instead of some taps landing in dead space between
 *  two chips and doing nothing at all. */
export const HIT_AREA_RES_MAIN = 'relative after:absolute after:-inset-x-px after:-inset-y-3 after:content-[""]';

/** Sub-tile resolution chips: 35x18, in the tile's top-right overlay stack —
 *  6px below the tile's top edge, 4px above the live-stats chip.
 *
 *  This is the one target that does NOT reach 44, and the reason is that both
 *  ways out are worse. Growing past the tile's top edge is clipped by the
 *  tile's own `overflow-hidden`, so those pixels would not be tappable
 *  anyway; growing down across the stats chip would make a tap on a readout
 *  silently change the stream's resolution. So the expansion takes exactly the
 *  space that belongs to it — 6px up, 4px down, 1px each side — for 28x37,
 *  which clears WCAG 2.5.8 AA (24x24) and stops there. Reaching 44 here needs
 *  the overlay stack redesigned, which is a visual change this pass is not
 *  allowed to make. */
export const HIT_AREA_RES_SUB = 'relative after:absolute after:-inset-x-px after:-top-1.5 after:-bottom-1 after:content-[""]';
