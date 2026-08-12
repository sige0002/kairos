// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { useCallback, useEffect, useRef, useState } from 'react';

export const TOAST_MS = 2400;

/** The one toast timer every v2 screen uses: show replaces any pending toast
 *  and restarts the auto-dismiss clock; the timer is cleared on unmount so a
 *  toast can never fire a state update into an unmounted screen. */
export function useToast(): {
  toast: string;
  showToast: (message: string) => void;
  clearToast: () => void;
} {
  const [toast, setToast] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(message);
    timerRef.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);
  const clearToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast('');
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  return { toast, showToast, clearToast };
}
