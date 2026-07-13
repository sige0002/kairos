// Small display formatters local to Review — the shared `formatDuration` in
// features/inspect/inspect.tsx renders "1m 5s", but the design mock's table
// uses a zero-padded HH:MM:SS clock ("00:00:58"), so this is its own thing
// rather than a reuse of that helper.

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
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

/** Human-readable byte size ("7.6 MB"); "—" when unknown (null/undefined). */
export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
