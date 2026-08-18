// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The six operator-facing tabs of the v2 console shell. Unlike the legacy
// 7-tab IA, this set is fixed client-side — deliberately NOT derived from the
// backend's GET /api/v1/config `tabs` field (that field, and the rest of the
// runtime config, is still fetched and used for the API base / SSE / form
// defaults; it just no longer drives which tabs exist or their order).

export const V2_TABS = [
  { id: 'collect', label: 'Collect' },
  { id: 'review', label: 'Review' },
  { id: 'datasets', label: 'Datasets' },
  { id: 'validation', label: 'Validation' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'settings', label: 'Settings' },
] as const;

export type V2TabId = (typeof V2_TABS)[number]['id'];

export const DEFAULT_TAB: V2TabId = 'collect';

// Deep-link ids from the old Live/Graph/Probe/Recordings/Datasets/Config IA,
// redirected to their v2 home so bookmarks and pop-out windows keep working.
const LEGACY_TAB_REDIRECTS: Record<string, V2TabId> = {
  live: 'collect',
  graph: 'monitor',
  probe: 'monitor',
  runs: 'review',
  dataset: 'datasets',
  config: 'settings',
};

function isV2TabId(id: string): id is V2TabId {
  return V2_TABS.some((t) => t.id === id);
}

/**
 * Resolve an incoming `?tab=` value — a current v2 id, a legacy id, or
 * anything else (missing / unrecognized) — to a valid v2 tab id. Callers that
 * find the resolved id differs from the input should rewrite the URL so the
 * address bar reflects where the operator actually landed.
 */
export function resolveTabId(id: string | null): V2TabId {
  if (!id) return DEFAULT_TAB;
  const mapped = LEGACY_TAB_REDIRECTS[id] ?? id;
  return isV2TabId(mapped) ? mapped : DEFAULT_TAB;
}

export function tabLabel(id: V2TabId): string {
  return V2_TABS.find((t) => t.id === id)?.label ?? id;
}
