// Shared formatting for freeform live extension events (the dora_live
// extension seam). Used by the Monitor Events card and the Collect post-take
// panel — both render UNKNOWN event shapes generically (slots for the
// kind/source/topic/t conventions, key=value text for everything else), so no
// extension author ever touches the frontend.

import type { LiveExtensionEvent } from '../../api/types';

export const SLOTTED_KEYS = new Set(['t', 'kind', 'source', 'topic']);

export function eventTime(t: unknown): string {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '—';
  return new Date(t * 1000).toLocaleTimeString();
}

export function chipValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function extraEntries(event: LiveExtensionEvent): Array<[string, unknown]> {
  return Object.entries(event).filter(([key]) => !SLOTTED_KEYS.has(key));
}

/** One-line text form: "kind · source · topic · k=v k=v" (post-take panel). */
export function eventLine(event: LiveExtensionEvent): string {
  const parts: string[] = [];
  if (typeof event.kind === 'string' && event.kind) parts.push(event.kind);
  if (typeof event.source === 'string' && event.source) parts.push(event.source);
  if (typeof event.topic === 'string' && event.topic) parts.push(event.topic);
  const extras = extraEntries(event)
    .map(([k, v]) => `${k}=${chipValue(v)}`)
    .join(' ');
  if (extras) parts.push(extras);
  return parts.join(' · ') || 'event';
}
