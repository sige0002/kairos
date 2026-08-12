// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Observed-shortfall status thresholds, as PERCENT, mirroring the backend
// defaults in topic_monitor/metrics.py (DEFAULT_WARN_SHORTFALL = 0.02,
// DEFAULT_DANGER_SHORTFALL = 0.05). Used to draw the 2% / 5% reference lines on
// the live health graph (OL-③.2). Display-only — the backend owns the real
// status decision; these just annotate the chart. If the backend thresholds
// become config-driven, plumb them through /api/v1/config and replace these.
export const DEFAULT_WARN_SHORTFALL_PCT = 2;
export const DEFAULT_DANGER_SHORTFALL_PCT = 5;
