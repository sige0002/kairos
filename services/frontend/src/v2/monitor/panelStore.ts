// Module-level store for the Monitor Topics view's chart PANELS — the v1 Graph
// tab's add/remove-panel model (each panel = one metric × its own overlaid topic
// set), restored in the v2 Monitor. Parked in module scope (the same pattern as
// the Collect batch store, useBatchMachine.ts) so a panel layout survives the
// Topics view unmounting on a sub-nav / tab switch; React components re-subscribe
// via useSyncExternalStore. In-memory only (no localStorage): a panel layout is
// cheap to rebuild and not worth persisting across a full reload.
//
// The pure operations (nextMetric / addPanelTo / removePanelFrom / … /
// resolvePanelTopics) are exported for direct unit testing — no React needed.

import { useSyncExternalStore } from 'react';
import { MAX_SERIES, MONITOR_METRICS, type MonitorMetricKey } from './chartSeries';

/** Hard cap on simultaneous panels (v1 offered unlimited; capped here so the
 *  panels always share the left column without page scroll — see TopicsView). */
export const MAX_PANELS = 4;

export interface ChartPanel {
  id: number;
  metric: MonitorMetricKey;
  /** `null` ONLY for the primary panel's untouched initial state (auto-track the
   *  first discovered topic, exactly as the single-chart v2 Monitor did); every
   *  explicit selection — including an empty one — is an array. Non-primary
   *  panels are always created with an explicit array. */
  topics: string[] | null;
}

function initialPanels(): ChartPanel[] {
  return [{ id: 0, metric: 'hz', topics: null }];
}

// --- Pure operations (exported for tests) ---------------------------------

/** The metric a newly-added panel should default to: the first registry metric
 *  not already shown by an existing panel, so "+ Add chart" surfaces a fresh view
 *  (Hz → Bandwidth → Max gap → Rate) instead of a duplicate. Falls back to the
 *  first metric once every metric is already on screen. */
export function nextMetric(panels: ChartPanel[]): MonitorMetricKey {
  const used = new Set(panels.map((p) => p.metric));
  return (MONITOR_METRICS.find((m) => !used.has(m.key)) ?? MONITOR_METRICS[0]!).key;
}

/** Append a panel (capped at MAX_PANELS — a no-op returning the SAME array at the
 *  cap so useSyncExternalStore sees no change). A new panel is seeded with the
 *  given topic when one is available so it charts something immediately. The id is
 *  max(existing)+1 (stable and test-deterministic even after a removal). */
export function addPanelTo(panels: ChartPanel[], seedTopic?: string): ChartPanel[] {
  if (panels.length >= MAX_PANELS) return panels;
  const id = panels.reduce((m, p) => Math.max(m, p.id), -1) + 1;
  return [...panels, { id, metric: nextMetric(panels), topics: seedTopic ? [seedTopic] : [] }];
}

/** Remove a panel by id, never dropping the last one (returns the SAME array when
 *  it would). The primary panel (index 0) has no Remove control, so in practice
 *  only non-primary panels reach here. */
export function removePanelFrom(panels: ChartPanel[], id: number): ChartPanel[] {
  if (panels.length <= 1) return panels;
  const next = panels.filter((p) => p.id !== id);
  return next.length === panels.length ? panels : next;
}

export function setMetricIn(
  panels: ChartPanel[],
  id: number,
  metric: MonitorMetricKey,
): ChartPanel[] {
  return panels.map((p) => (p.id === id ? { ...p, metric } : p));
}

export function setTopicsIn(panels: ChartPanel[], id: number, topics: string[]): ChartPanel[] {
  return panels.map((p) => (p.id === id ? { ...p, topics } : p));
}

/** Resolve a panel's stored selection to the concrete charted topics: the primary
 *  panel's untouched (`null`) state auto-tracks the first available topic; any
 *  explicit set is filtered to still-present topics and capped at MAX_SERIES. */
export function resolvePanelTopics(
  topics: string[] | null,
  isPrimary: boolean,
  available: string[],
): string[] {
  const base = topics ?? (isPrimary && available[0] ? [available[0]] : []);
  return base.filter((t) => available.includes(t)).slice(0, MAX_SERIES);
}

// --- Module store + React binding -----------------------------------------

let panels: ChartPanel[] = initialPanels();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function commit(next: ChartPanel[]): void {
  if (next === panels) return; // reference-equal = a guarded no-op; skip the render
  panels = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChartPanel[] {
  return panels;
}

/** React binding for the module store (subscribes for the component's life). */
export function usePanels(): ChartPanel[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function addPanel(seedTopic?: string): void {
  commit(addPanelTo(panels, seedTopic));
}
export function removePanel(id: number): void {
  commit(removePanelFrom(panels, id));
}
export function setPanelMetric(id: number, metric: MonitorMetricKey): void {
  commit(setMetricIn(panels, id, metric));
}
export function setPanelTopics(id: number, topics: string[]): void {
  commit(setTopicsIn(panels, id, topics));
}

/** Test-only: reset to the single default primary panel between tests. */
export function __resetPanelStore(): void {
  panels = initialPanels();
  notify();
}
