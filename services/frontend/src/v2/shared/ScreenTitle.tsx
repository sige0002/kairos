// The document heading for a tab.
//
// The console had no h1 or h2 anywhere in the shell, so a screen-reader user
// could not navigate by heading at all — the whole console was one flat run of
// text under the tab bar (#14). Each screen renders exactly one of these, and
// the shell mounts exactly one screen at a time (App.tsx swaps TabContent on
// the active tab rather than keeping the others alive), so the document always
// has exactly one h1, naming where you are.
//
// VISUALLY HIDDEN on purpose. The tab bar already shows the screen name to
// sighted users, and the design has no room for a second copy of it — so
// rendering it visibly would be a layout change in a semantics-only sweep.
// `sr-only` is Tailwind's standard clip technique: absolutely positioned and
// clipped to a 1px box, which keeps it out of flow. It is not `display: none`
// or `hidden`, either of which would take it out of the accessibility tree and
// defeat the point.

export function ScreenTitle({ children }: { children: string }) {
  return <h1 className="sr-only">{children}</h1>;
}
