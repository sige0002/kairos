// Adopt the URL when the browser changes it under us.
//
// The URL can change WITHOUT the app doing anything: Back, Forward, a session
// restore, a bfcache resume. Every screen that mirrors state INTO the query
// string has the same latent bug if it ignores that — its own mirror effect
// rewrites the restored URL back to the state it was already showing, so the
// navigation is both ignored and erased.
//
// Adopting the URL keeps ONE invariant: after any history navigation, the
// console shows what that URL would show on a fresh load.
//
// Idle in the common case — nothing in src/ calls `pushState`, so no in-app
// action produces a history entry today. These listeners are what stop that
// from becoming a lie the moment one appears.
//
// Only the LISTENER is shared. What "adopt" means, how the state is seeded, and
// how it is mirrored back differ per screen and stay at each call site.

import { useEffect, useRef } from 'react';

export function useOnPopState(onPopState: () => void): void {
  // Subscribe once and read the latest handler through a ref: re-subscribing
  // whenever a caller's closure changes would be churn, and the handler must
  // see current state rather than the render it was created in.
  const latest = useRef(onPopState);
  latest.current = onPopState;
  useEffect(() => {
    const onPop = () => latest.current();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
