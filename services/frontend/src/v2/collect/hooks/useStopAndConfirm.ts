// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
//
// The recorder's stop endpoint is idempotent and can answer with a previous
// capture while a current recording continues. Keep every Collect caller on
// the same "request stop, then observe terminal state" path: normal Stop,
// takeover Stop, and terminal batch actions must all wait for the recorder's
// real state before they claim completion or change batch state.

import { useCallback } from 'react';
import { stopRecord } from '../../../api/record';
import type { Capture } from '../../../api/types';
import { confirmRecorderStopped } from '../../captures/stopConfirm';

export function useStopAndConfirm(): (captureId: string) => Promise<Capture> {
  return useCallback(async (captureId: string) => {
    const capture = await stopRecord(captureId);
    await confirmRecorderStopped(capture?.capture_id ?? null);
    return capture;
  }, []);
}
