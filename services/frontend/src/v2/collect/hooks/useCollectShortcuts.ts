// Keyboard shortcut layer (D-4), extracted from useBatchMachine.ts.
// R/S/Space/Esc/? on the window, ignored while typing or when any REGISTERED
// overlay is open (the caller computes that — modals own their own keys, e.g.
// Esc-to-close). Enter is deliberately NOT bound — focus management keeps the
// primary button focused so the native button handles it.

import { useEffect, useRef } from 'react';
import { getStoreSnapshot } from '../machine/store';

export function useCollectShortcuts({
  anyOverlayOpen,
  takeoverActive,
  startRecording,
  stopRecording,
  cancelArming,
  openShortcutsSheet,
}: {
  anyOverlayOpen: boolean;
  takeoverActive: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  cancelArming: () => void;
  openShortcutsSheet: () => void;
}): void {
  // R-to-start must not fire into a takeover (would 409); read it via a ref so
  // the listener stays stable.
  const takeoverActiveRef = useRef(false);
  takeoverActiveRef.current = takeoverActive;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (t?.isContentEditable ?? false);
      if (typing) return;
      // While an overlay is open, only let it handle its own keys.
      if (anyOverlayOpen) return;
      const phase = getStoreSnapshot().phase;
      if (e.key === 'r' || e.key === 'R') {
        if (phase === 'ready' && !takeoverActiveRef.current) {
          e.preventDefault();
          startRecording();
        }
      } else if (
        e.key === 's' ||
        e.key === 'S' ||
        e.key === ' ' ||
        e.key === 'Spacebar'
      ) {
        if (phase === 'recording') {
          e.preventDefault();
          stopRecording();
        }
      } else if (e.key === 'Escape') {
        if (phase === 'arming') {
          e.preventDefault();
          cancelArming();
        }
      } else if (e.key === '?') {
        e.preventDefault();
        openShortcutsSheet();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyOverlayOpen, startRecording, stopRecording, cancelArming, openShortcutsSheet]);
}
