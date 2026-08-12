// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Small pieces shared by more than one phase card: the compact-viewport gap,
// the elapsed clock (takeover + recording), and the end-of-set summary line
// that ENDED and COMPLETED both print.

import type { BatchMachine } from '../useBatchMachine';

// Card gap that tightens on short viewports (see compact.ts).
export const CARD_GAP_COMPACT = '[@media(max-height:860px)]:gap-1.5';

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `00:${mm}:${ss}`;
}

export function formatEndSummary(stats: BatchMachine['stats']): string {
  return `${stats.nRecorded} recorded (${stats.nGood} good · ${stats.nReview} review · ${stats.nTaskFailed} task failed), ${stats.nRemaining} not recorded`;
}
