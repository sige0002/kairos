// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Design tokens for the kairos console v2 shell (the six role-based tabs:
// Collect / Review / Datasets / Validation / Monitor / Settings), lifted from
// the design mock (kairos-console-v2.dc.html).
//
// These mirror Tailwind's DEFAULT palette 1:1 — teal-600 is #0d9488, gray-50
// is #f9fafb, etc., exactly as the mock specifies (see tailwind.config.js,
// which already documents this for the v1 "Neutral Teal" handoff). Screens
// should reach for Tailwind utility classes (`bg-teal-600`, `text-amber-700`,
// â€¦) first; this module exists only for the few contexts that need a raw JS
// hex value — inline SVG strokes, canvas/uplot series colors, and the like.

export const teal = {
  50: '#f0fdfa',
  100: '#ccfbf1',
  200: '#99f6e4',
  600: '#0d9488',
  700: '#0f766e',
} as const;

export const gray = {
  50: '#f9fafb',
  100: '#f3f4f6',
  200: '#e5e7eb',
  400: '#9ca3af',
  500: '#6b7280',
  700: '#374151',
  900: '#111827',
} as const;

export const amber = {
  50: '#fffbeb',
  100: '#fef3c7',
  200: '#fde68a',
  600: '#d97706',
  700: '#b45309',
  800: '#92400e',
} as const;

export const red = {
  50: '#fef2f2',
  200: '#fecaca',
  600: '#dc2626',
  700: '#b91c1c',
} as const;

export const green = {
  50: '#f0fdf4',
  100: '#dcfce7',
  200: '#bbf7d0',
  600: '#16a34a',
  700: '#15803d',
} as const;

