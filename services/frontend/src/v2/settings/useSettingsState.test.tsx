// The plan-editor handlers as a TOTAL contract over the shared catalog.
//
// PlansSection never offers these controls without a project (it renders an
// empty state) and disables them without a task, so the UI cannot reach the
// guards inside them — which is exactly why they are pinned here instead: the
// catalog is shared and can shrink under a mounted editor at any time (see
// SettingsScreen.test.tsx "the catalog empties WHILE the operator is in the
// detail editor"), and a handler that depends on a `disabled` attribute for its
// safety is one render away from throwing. A no-op here means: nothing thrown,
// nothing written to the shared store, and no prompt shown for a value that
// would be dropped.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { jsonResponse } from '../../test/renderWithClient';
import { __resetPlansStore, getPlans, setPlans } from '../plans';
import { useSettingsState } from './useSettingsState';

beforeEach(() => {
  __resetPlansStore();
  // Hold the once-per-load reconcile open for the whole case: its adopt/seed
  // would otherwise race the catalogs installed below and add PUTs of its own.
  // (The reconcile itself is covered in SettingsScreen.test.tsx.)
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/plans') && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(jsonResponse({}));
  });
});
afterEach(() => vi.restoreAllMocks());

/** How many times the catalog was pushed to the server. A no-op handler must
 *  not write: setPlans persists, marks the browser dirty and PUTs, so a
 *  "harmless" no-op edit would still overwrite the shared catalog. */
function catalogPuts(): number {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls.filter(
    (c) =>
      String(c[0]).includes('/plans') &&
      String((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'PUT',
  ).length;
}

test('the task/condition handlers are no-ops on an empty catalog', () => {
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Never used');
  const { result } = renderHook(() => useSettingsState());
  act(() => setPlans([]));
  const putsBefore = catalogPuts();

  act(() => result.current.addTask());
  act(() => result.current.removeTask(0));
  act(() => result.current.addCondition());
  act(() => result.current.removeCondition(0));

  expect(getPlans()).toEqual([]);
  expect(catalogPuts()).toBe(putsBefore);
  // Guarded BEFORE the prompt — the operator is never asked to name something
  // that has nowhere to go.
  expect(promptSpy).not.toHaveBeenCalled();
  expect(result.current.toast).toBe('');
});

test('the condition handlers are no-ops on a project with no tasks yet', () => {
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Never used');
  const fresh = [{ name: 'Fresh', tasks: [] }];
  const { result } = renderHook(() => useSettingsState());
  act(() => setPlans(structuredClone(fresh)));
  const putsBefore = catalogPuts();

  // The state a brand-new project is in: "+ Add condition" is disabled, but the
  // handler has to be safe on its own.
  act(() => result.current.addCondition());
  act(() => result.current.removeCondition(0));

  expect(getPlans()).toEqual(fresh);
  expect(catalogPuts()).toBe(putsBefore);
  expect(promptSpy).not.toHaveBeenCalled();
  expect(result.current.toast).toBe('');
});

test('removing a task/condition that is no longer there leaves the catalog alone', () => {
  const short = [{ name: 'P', tasks: [{ name: 'T', conditions: ['c'] }] }];
  const { result } = renderHook(() => useSettingsState());
  act(() => setPlans(structuredClone(short)));
  const putsBefore = catalogPuts();

  // Indices from a longer, already-replaced catalog. splice() past the end is
  // silently a no-op, so an unguarded handler would report "removed", mark the
  // browser dirty and PUT the unchanged catalog over the shared one — claiming
  // an edit that never happened.
  act(() => result.current.removeTask(3));
  act(() => result.current.removeCondition(9));

  expect(getPlans()).toEqual(short);
  expect(catalogPuts()).toBe(putsBefore);
  expect(result.current.toast).toBe('');
});

test('a task vanishing under the cursor freezes the selected-task handlers', () => {
  // The view disables these controls, but the policy — never edit a task the
  // operator did not choose — must not depend on a `disabled` attribute, the
  // same reasoning as the guards above. Picking a task is the re-confirmation,
  // after which the SAME handlers work on exactly the task the view shows.
  vi.spyOn(window, 'prompt').mockReturnValue('renamed by handler');
  const { result } = renderHook(() => useSettingsState());
  act(() =>
    setPlans([
      {
        name: 'P',
        tasks: [
          { name: 'T0', conditions: ['c0'] },
          { name: 'T1', conditions: ['c1'] },
        ],
      },
    ]),
  );
  act(() => result.current.selectTask(1));
  expect(result.current.planTaskIdx).toBe(1);

  // Another terminal drops T1 out from under the cursor.
  act(() => setPlans([{ name: 'P', tasks: [{ name: 'T0', conditions: ['c0'] }] }]));
  expect(result.current.taskSelectionLost).toBe(true);
  expect(result.current.planTaskIdx).toBe(0); // T0 is what the view shows

  const putsBefore = catalogPuts();
  act(() => result.current.renameTask());
  act(() => result.current.addCondition());
  act(() => result.current.removeCondition(0));
  expect(getPlans()).toEqual([{ name: 'P', tasks: [{ name: 'T0', conditions: ['c0'] }] }]);
  expect(catalogPuts()).toBe(putsBefore);

  // Re-confirm, and the handlers act on the task the view is showing.
  act(() => result.current.selectTask(0));
  expect(result.current.taskSelectionLost).toBe(false);
  act(() => result.current.renameTask());
  expect(getPlans()[0]!.tasks.map((t) => t.name)).toEqual(['renamed by handler']);
});

test('a shrunken catalog still reports an in-range cursor', () => {
  const { result } = renderHook(() => useSettingsState());
  // Point both cursors deep into the seed catalog, then empty it.
  act(() => result.current.selectProject(2));
  act(() => result.current.selectTask(1));
  act(() => setPlans([]));

  expect(result.current.planProjIdx).toBe(0);
  expect(result.current.planTaskIdx).toBe(0);
  expect(result.current.plans).toEqual([]);
});
