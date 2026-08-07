// E-33: two windows of the same console (`?tab=…&solo=1` opens a second one)
// and whether a layout change in one silently moves the other.
//
// Two browser windows share an ORIGIN, not a JS heap: module-level state is
// per-window, and the only things that can cross are storage and the `storage`
// event the browser delivers to the OTHER window. So the question is entirely
// about persistence, and these tests answer it from both directions — the
// layout stores write nothing, and a write from another window changes nothing
// here.
//
// Note on why this is NOT "render two screens and see whether they move
// together": both trees in one jsdom share the same module instance, so they
// would appear to sync no matter what the product does. That would be an
// artifact of the harness rather than the product's cross-window behaviour,
// and it is the trap this file exists to avoid.

import { beforeEach, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  __resetPanelStore,
  addPanel,
  removePanel,
  setPanelMetric,
  setPanelTopics,
  usePanels,
} from './monitor/panelStore';
import {
  __resetCameraStore,
  addCameraPane,
  getCameraState,
  seedCameraPanes,
  setMainCameraPane,
  setMainCameraRes,
} from './collect/cameraStore';
import { useUiStore } from '../store/uiStore';

/** Everything in localStorage, as one comparable snapshot. */
function storageSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key !== null) out[key] = window.localStorage.getItem(key) ?? '';
  }
  return out;
}

/** The Monitor panel layout, read without a component. */
function panelSnapshot(): string {
  return JSON.stringify(renderHook(() => usePanels()).result.current);
}

beforeEach(() => {
  window.localStorage.clear();
  __resetPanelStore();
  __resetCameraStore();
  useUiStore.setState({ streamPanes: [], streamPaneSeq: 0, streamPanesSeededKey: null });
});

test('rearranging the Monitor panels persists nothing, so no other window can see it', () => {
  const before = storageSnapshot();

  addPanel('/hsrb/joint_states');
  addPanel('/hsrb/odom');
  setPanelMetric(0, 'bw');
  setPanelTopics(0, ['/hsrb/joint_states', '/hsrb/odom']);
  removePanel(1);

  expect(storageSnapshot()).toEqual(before);
});

test('rearranging the Collect camera panes persists nothing either', () => {
  const before = storageSnapshot();

  seedCameraPanes(['/cam/a'], 'k1');
  addCameraPane('/cam/b');
  setMainCameraPane(0);
  setMainCameraRes('720p');

  expect(storageSnapshot()).toEqual(before);
  // …and the layout really did change in THIS window, so the assertion above is
  // about persistence rather than about nothing having happened.
  expect(getCameraState().panes.length).toBeGreaterThan(1);
  expect(getCameraState().mainResLabel).toBe('720p');
});

test('no layout store subscribes to the `storage` event at all', async () => {
  // The direct guard, and the one that actually bites. Dispatching a
  // StorageEvent and watching the layout not move (below) only rules out a
  // listener keyed on the key that test happens to send — a listener keyed on
  // ANY other key sails past it. Registration is the thing to assert, because
  // the storage event is the only live cross-window channel there is: with no
  // subscriber, no key and no payload can move this window's layout.
  const addSpy = vi.spyOn(window, 'addEventListener');
  const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
  vi.resetModules();
  await import('./monitor/panelStore');
  await import('./collect/cameraStore');
  await import('../store/uiStore');
  // Establishes that resetModules + dynamic import really RE-EXECUTES module
  // bodies here — plans.ts reads localStorage at module scope, so a fresh
  // evaluation has to touch it. Imported through the same cleared registry as
  // the three above, so it stands for all of them. Without this, "no listener
  // was registered" could just as well mean "nothing ran".
  await import('./plans');
  expect(getItemSpy).toHaveBeenCalled();

  expect(addSpy.mock.calls.filter(([type]) => type === 'storage')).toEqual([]);
  addSpy.mockRestore();
  getItemSpy.mockRestore();
});

test('that listener check would notice one (so the assertion above is not vacuous)', () => {
  const addSpy = vi.spyOn(window, 'addEventListener');
  const noop = () => {};
  window.addEventListener('storage', noop);

  expect(addSpy.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1);

  window.removeEventListener('storage', noop);
  addSpy.mockRestore();
});

test("another window's storage write does not move this window's layout", () => {
  // The behavioural companion to the registration check above: what the browser
  // actually delivers to the OTHER window is a value it did not write plus a
  // `storage` event. Several keys are sent, including the `null` key a
  // `localStorage.clear()` produces, so this does not only rule out a listener
  // watching one particular name.
  addPanel('/hsrb/joint_states');
  addPanel('/hsrb/odom');
  seedCameraPanes(['/cam/a'], 'k1');
  addCameraPane('/cam/b');
  const panelsBefore = panelSnapshot();
  const camerasBefore = JSON.stringify(getCameraState());

  const foreign = '[{"name":"Written by window B","tasks":[]}]';
  for (const key of [
    'kairos.v2.plans.v1',
    'kairos.v2.panels.v1', // a layout key, were one ever introduced
    'kairos.v2.camera.panes.v1',
    'kairos.v2.streamPanes.v1',
    null, // what localStorage.clear() delivers
  ]) {
    if (key !== null) window.localStorage.setItem(key, foreign);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: foreign,
        storageArea: window.localStorage,
      }),
    );
  }

  expect(panelSnapshot()).toBe(panelsBefore);
  expect(JSON.stringify(getCameraState())).toBe(camerasBefore);
});

test('the storage snapshot notices a write (so the comparisons above are not vacuous)', () => {
  // The three tests above all assert "storage did not change". That assertion is
  // only worth anything if the snapshot can tell the difference at all.
  const before = storageSnapshot();
  window.localStorage.setItem('kairos.probe', '1');
  expect(storageSnapshot()).not.toEqual(before);
});
