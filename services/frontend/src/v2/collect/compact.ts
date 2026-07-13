// Compact-density class fragments for the Collect screen at reduced viewport
// heights. The console must fit ONE page with no scroll from 1366x768 up; the
// left card stack overflows on short laptops otherwise. Below ~860px tall we
// trim paddings/gaps (never hide anything); the roomy 1920x1080 layout above
// 860px is unchanged. Scoped to Collect. `[@media(max-height:860px)]:` is a
// Tailwind arbitrary variant (v3.4) — the utilities inside it only apply when
// the viewport is at most 860px tall.
//
// Kept as shared constants so the same threshold and steps are used everywhere
// (a single knob), rather than sprinkling the long prefix inconsistently.

/** Card outer padding: 16px → 10px when short. */
export const CARD_PAD = 'p-4 [@media(max-height:860px)]:p-2.5';
/** Side-card padding (13/18) → 8/12 when short. */
export const SIDE_PAD = 'p-[13px] px-[18px] [@media(max-height:860px)]:py-2 [@media(max-height:860px)]:px-3';
/** Stacked-card / column gap: 10px → 4px when short. */
export const COL_GAP = 'gap-2.5 [@media(max-height:860px)]:gap-1';
