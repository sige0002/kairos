// Module-level store for the Collect screen's camera panes — the operator's
// per-session choices (which cameras are open, which is the main tile, and each
// tile's resolution) that must survive a tab-switch unmount. The Collect screen
// is unmounted whenever the operator switches tabs (App.tsx renders only the
// active tab), so component-local pane state would reset on every navigation;
// parking it in module scope (the same useSyncExternalStore pattern as the
// batch store and the shared plans store) makes it durable for the session.
//
// This is Collect's OWN store, separate from uiStore.streamPanes (the v1 Stream
// tab's panes) — the two screens keep independent camera layouts.
//
// Seeding follows the camera-list convention: panes are seeded once from the
// robot's configured cameras (config.stream.panes) and RE-SEEDED on a robot
// switch (keyed by the configured topic list), so the panes always follow the
// active robot's cameras. Operator-added panes and per-tile resolution choices
// are dropped on a robot switch (a different robot has different cameras),
// exactly as uiStore.seedStreamPanes resets on its key change.

import { useSyncExternalStore } from 'react';
import type { TopicInfo } from '../../api/types';

/** Cap on total simultaneous camera panes (design §3-2 image budget: one
 *  full-resolution main + a handful of low-res subs). Mirrors uiStore's
 *  MAX_STREAM_PANES for the Stream tab. */
export const MAX_CAMERA_PANES = 4;

/** Main-tile resolution presets — v1 Stream-tab parity (Source + four caps).
 *  `w`/`h` are the downscale bounds passed to the streamer (Source = no cap). */
export const MAIN_RES_PRESETS: { label: string; w: number | null; h: number | null }[] = [
  { label: 'Source', w: null, h: null },
  { label: '720p', w: 1280, h: 720 },
  { label: '480p', w: 854, h: 480 },
  { label: '360p', w: 640, h: 360 },
  { label: '240p', w: 426, h: 240 },
];

// Sub tiles stay low-res BY DESIGN (console v2 design §3-2: one full-resolution
// stream at a time — the main tile — so a sub's robot-side encode/egress cost
// stays marginal). The per-tile selector is therefore restricted to the two
// lowest presets; it never offers Source/720p/480p.
export const SUB_RES_LABELS = ['360p', '240p'] as const;
export type SubResLabel = (typeof SUB_RES_LABELS)[number];

export const DEFAULT_MAIN_RES = '480p';
export const DEFAULT_SUB_RES: SubResLabel = '240p';

/** Resolve a preset label to its (w, h) downscale bounds; unknown → Source. */
export function resBounds(label: string): { w: number | null; h: number | null } {
  const p = MAIN_RES_PRESETS.find((r) => r.label === label);
  return p ? { w: p.w, h: p.h } : { w: null, h: null };
}

export interface CameraPane {
  id: number;
  topic: string;
  /** 'config' panes are the robot's configured cameras (not removable); their
   *  topic is only swapped via click-to-main. 'operator' panes were added at
   *  runtime and can be removed. */
  source: 'config' | 'operator';
  /** This pane's resolution WHEN it is a sub tile (restricted to SUB_RES_LABELS).
   *  When it is the main tile the store's `mainResLabel` applies instead. */
  subResLabel: SubResLabel;
}

interface CameraState {
  panes: CameraPane[];
  /** The pane rendered large (main tile); null when there are no panes. */
  mainId: number | null;
  /** Resolution of whichever pane is currently main. */
  mainResLabel: string;
  /** Monotonic id source for operator-added panes. */
  seq: number;
  /** The configured-topic key the panes were seeded from (a robot switch changes
   *  it, forcing a re-seed); null until first seeded. */
  seededKey: string | null;
}

function initialState(): CameraState {
  return { panes: [], mainId: null, mainResLabel: DEFAULT_MAIN_RES, seq: 0, seededKey: null };
}

let current: CameraState = initialState();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function set(next: CameraState): void {
  if (next === current) return;
  current = next;
  notify();
}

/** Seed (or re-seed on robot switch) the config panes from the robot's
 *  configured camera topics. A no-op when the key is unchanged, so operator
 *  edits persist across tab switches / config refetches; a full reset when it
 *  changes, so the panes follow the new robot's cameras. */
export function seedCameraPanes(configuredTopics: string[], key: string): void {
  if (current.seededKey === key) return;
  const panes: CameraPane[] = configuredTopics.map((topic, i) => ({
    id: i,
    topic,
    source: 'config',
    subResLabel: DEFAULT_SUB_RES,
  }));
  set({
    panes,
    mainId: panes[0]?.id ?? null,
    mainResLabel: DEFAULT_MAIN_RES,
    seq: panes.length,
    seededKey: key,
  });
}

/** Add an operator-chosen camera pane (no-op at the cap or for a blank/dup
 *  topic). The first pane added into an empty layout becomes the main tile. */
export function addCameraPane(topic: string): void {
  if (!topic) return;
  if (current.panes.length >= MAX_CAMERA_PANES) return;
  if (current.panes.some((p) => p.topic === topic)) return;
  const pane: CameraPane = { id: current.seq, topic, source: 'operator', subResLabel: DEFAULT_SUB_RES };
  set({
    ...current,
    panes: [...current.panes, pane],
    mainId: current.mainId ?? pane.id,
    seq: current.seq + 1,
  });
}

/** Remove a pane (operator panes only, enforced by the UI). If the main tile is
 *  removed, the first surviving pane takes over as main. */
export function removeCameraPane(id: number): void {
  const panes = current.panes.filter((p) => p.id !== id);
  if (panes.length === current.panes.length) return;
  const mainId = current.mainId === id ? (panes[0]?.id ?? null) : current.mainId;
  set({ ...current, panes, mainId });
}

/** Promote a pane to the main (large) tile — the click-to-main swap. */
export function setMainCameraPane(id: number): void {
  if (current.mainId === id) return;
  if (!current.panes.some((p) => p.id === id)) return;
  set({ ...current, mainId: id });
}

/** Set the main tile's resolution (any MAIN_RES_PRESETS label). */
export function setMainCameraRes(label: string): void {
  if (current.mainResLabel === label) return;
  set({ ...current, mainResLabel: label });
}

/** Set a pane's sub-tile resolution (restricted to SUB_RES_LABELS). */
export function setSubCameraRes(id: number, label: SubResLabel): void {
  set({
    ...current,
    panes: current.panes.map((p) => (p.id === id ? { ...p, subResLabel: label } : p)),
  });
}

function getSnapshot(): CameraState {
  return current;
}

/** Current store snapshot (stable reference until the next mutation) — handy for
 *  reading pane state outside React (tests). */
export function getCameraState(): CameraState {
  return current;
}

/** React binding for the module store (subscribes for the component's life). */
export function useCameraStore(): CameraState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getSnapshot,
    getSnapshot,
  );
}

/** Test-only: reset the store between cases. */
export function __resetCameraStore(): void {
  current = initialState();
  notify();
}

// ---- camera-topic options (add-camera dropdown) ---------------------------

export interface CameraOption {
  name: string;
  type?: string;
  /** True when the topic is currently on the ROS graph (from discovery); false
   *  for a configured-but-not-yet-publishing camera (shown "(offline)"). */
  live: boolean;
}

// A topic is a camera/image topic if its type is an (Compressed)Image or its
// name looks like an image stream (mirrors v1 StreamTab's isImageType/Name).
function isImageType(type?: string): boolean {
  return !!type && /image/i.test(type);
}
function isImageName(name: string): boolean {
  return /image/i.test(name);
}

function asTopicList(
  data: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] } | undefined,
): TopicInfo[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.topics ?? data.items ?? [];
}

/** Image-topic options for the add-camera dropdown: live discovered image
 *  topics ∪ configured camera topics (offline-marked), image-only, sorted.
 *  Non-image topics (e.g. /joint_states, /tf) are excluded. */
export function imageTopicOptions(
  discovered: TopicInfo[] | { topics?: TopicInfo[]; items?: TopicInfo[] } | undefined,
  configured: string[],
): CameraOption[] {
  const byName = new Map<string, CameraOption>();
  for (const t of asTopicList(discovered)) {
    if (isImageType(t.type) || isImageName(t.name)) {
      byName.set(t.name, { name: t.name, type: t.type, live: true });
    }
  }
  for (const name of configured) {
    if (isImageName(name) && !byName.has(name)) {
      byName.set(name, { name, live: false });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
