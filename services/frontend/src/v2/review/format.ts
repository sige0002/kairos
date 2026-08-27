// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Small display formatters local to Review — the shared `formatDuration` in
// features/inspect/inspect.tsx renders "1m 5s", but the design mock's table
// uses a zero-padded HH:MM:SS clock ("00:00:58"), so this is its own thing
// rather than a reuse of that helper.

import { formatDateTime, formatTime } from '../../i18n/format';

export function formatHms(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatTimeOfDay(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return formatTime(d);
}

/** Human-readable byte size ("7.6 MB"); "—" when unknown (null/undefined).
 *  DECIMAL units (1 MB = 1e6 B) — the ONE convention every screen shares. This
 *  file used 1024-math under decimal labels while Datasets used 1e6, so the
 *  same capture showed two different sizes, both labelled MB (audit P2). */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

/** Full local timestamp, ALWAYS 24-hour ("05/08/2026, 00:51:04") — the one
 *  detail-prose form. Bare toLocaleString() rendered 12-hour under en-US while
 *  the tables were 24-hour, so one screen mixed both clocks (audit P2). */
export function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}
