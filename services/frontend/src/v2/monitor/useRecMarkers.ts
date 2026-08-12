// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// REC/STOP markers for the Monitor frequency chart, from the REAL /record/status
// stream — the same source the v1 Live Scope band used. The active<->idle edge
// derivation lives in the uiStore (pushRecordMarker: only recording/stopping is
// an actually-running session, so a marker is logged on each start/stop edge);
// this hook is only the thin plumbing (poll the status, feed the store, read the
// accumulated markers back), mirroring LiveTab.useRecordMarkers so both screens
// share ONE record-status query cache (react-query dedupes by key) and ONE marker
// buffer in the store (survives the tab unmounting on navigation).
//
// Markers therefore reflect transitions OBSERVED during this session — a run that
// started and stopped before the page loaded leaves none (honest: we never
// fabricate a marker we didn't witness).

import { useEffect } from 'react';
import { useUiStore } from '../../store/uiStore';
import { useRecordStatus } from '../captures/useRecordStatus';
import type { ChartMarker } from '../../features/probe/UplotChart';

export function useRecMarkers(): ChartMarker[] {
  const view = useRecordStatus();
  const markers = useUiStore((s) => s.recMarkers);
  const pushMarker = useUiStore((s) => s.pushRecordMarker);
  // Only a CONFIRMED state moves the markers. A failed poll would otherwise
  // keep re-asserting the last known state, and a recorder that died while
  // recording would never get its STOP marker — the band would read as though
  // the recording were still running.
  const state = view.reachable ? (view.status?.state ?? null) : null;
  useEffect(() => {
    if (state) pushMarker(state);
  }, [state, pushMarker]);
  // RecMarker is structurally identical to ChartMarker ({ t, kind }).
  return markers;
}
