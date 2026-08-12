// The Collect header against an EMPTY shared plan catalog.
//
// Reported as a side finding during E-5, whose subject was Settings
// white-screening on a catalog another terminal emptied.
//
// CORRECTION TO THAT REPORT, found while driving it: the em dash in the header
// is NOT `findProject`'s. `findProject(plans, …)` returns `{name: '—'}` on an
// empty catalog, but the header never renders that name — it renders
// `machine.project`, and only `curProject.tasks` is read from the lookup. The
// header's placeholder comes from `createBatchMachineState`'s
// `firstPlan?.name ?? '—'`: a different line that happens to use the same
// character. Fixing the one named in the report would have changed nothing on
// screen.
//
// It is not a fabricated name, which is why E-5 did not call it a violation.
// It is the other failure: an unlabelled hole. The operator reads a header that
// looks populated, with two cells they cannot act on and nothing saying why or
// where the fix is. The Project picker underneath is an empty popover — the one
// real dead end here, since the Task picker has always had `Custom…`.

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { setApiBase } from '../../api/client';
import { makeTestClient, jsonResponse } from '../../test/renderWithClient';
import { useUiStore } from '../../store/uiStore';
import { ensurePlansSynced, getPlans, __resetPlansStore } from '../plans';
import { CollectScreen } from './CollectScreen';
import { __resetBatchStore } from './useBatchMachine';

const CONFIG = {
  endpoints: {
    api: '/api/v1',
    events: '/api/v1/events',
    webrtc: 'http://localhost:8002',
  },
  tabs: [],
  defaults: { default_topics: ['/hsrb/joint_states'] },
  schemas: {},
};

/** A catalog another terminal explicitly emptied — served back as `[]`, which
 *  plans.ts adopts as-is rather than resurrecting the seeds. */
const EMPTY_SERVER_CATALOG = {
  projects: [],
  failure_reasons: ['Grasp missed'],
  operators: [],
  updated_at: 't0',
};

function mockApi(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/plans'))
      return Promise.resolve(jsonResponse(EMPTY_SERVER_CATALOG));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/record/status'))
      return Promise.resolve(
        jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] }),
      );
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });
}

function renderCollect(): void {
  const client = makeTestClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<CollectScreen />, { wrapper: Wrapper });
}

/** The header cell with the given label, as the operator sees it. */
function contextCell(label: string): HTMLElement {
  const heading = screen.getAllByText(label).find((n) => n.tagName === 'SPAN');
  if (!heading?.parentElement) throw new Error(`no context cell labelled ${label}`);
  return heading.parentElement;
}

beforeEach(() => {
  setApiBase('/api/v1');
  __resetBatchStore();
  __resetPlansStore();
  useUiStore.setState({
    activeTab: '',
    // Recording requires an operator since #11, in every configuration —
    // so a suite that records has to say who is recording. The gate itself
    // is exercised where it is the subject, not incidentally here.
    recordOperator: 'tester',
    recordSelected: new Set<string>(),
    recordCustomized: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetPlansStore();
});

test('an empty catalog states itself in the header instead of filling the slot with an em dash', async () => {
  mockApi();

  // The reachable order, in two steps, because the placeholder needs BOTH.
  //
  // 1. Another terminal empties the shared catalog and this browser adopts it.
  //    The seeds are what the module holds at load, so a page load alone never
  //    produces an empty catalog — the adopt does.
  ensurePlansSynced();
  await waitFor(() => expect(getPlans()).toEqual([]));

  // 2. The batch context is re-seeded from the catalog, which is the moment
  //    `firstPlan?.name ?? '—'` runs. At runtime that is `clearLocalBatch()` —
  //    the phantom-batch reconciler that runs at mount when the local batch has
  //    no captures behind it, and calls the same `createInitialState()` this
  //    does. Both land on an empty catalog whenever the two mount-time requests
  //    resolve in this order.
  __resetBatchStore();

  renderCollect();
  const project = await waitFor(() => contextCell('Project'));
  const task = contextCell('Task');

  // Positive control: these are the cells that carry the placeholder today.
  expect(project).toHaveTextContent(/Project/);
  expect(task).toHaveTextContent(/Task/);

  // Neither slot is filled with an unlabelled hole …
  expect(project.textContent).not.toMatch(/—/);
  expect(task.textContent).not.toMatch(/—/);
  // … and both say what is actually true of this installation.
  expect(project).toHaveTextContent(/no plans configured/i);
  expect(task).toHaveTextContent(/no plans configured/i);
});

test('the Project picker on an empty catalog says where a project comes from', async () => {
  mockApi();
  // No re-seed needed here: the picker reads the LIVE catalog, so it goes blank
  // the moment the empty one is adopted, whatever the header says.
  renderCollect();
  await waitFor(() => expect(getPlans()).toEqual([]));

  fireEvent.click(await waitFor(() => contextCell('Project')));

  // The popover opens (positive control) and is not a blank rectangle: with no
  // projects there is nothing to pick, so it has to name the way out.
  const heading = await screen.findByText(/Project \(from plan\)/);
  const popover = heading.parentElement!;
  expect(popover).toHaveTextContent(/Settings/i);
  expect(popover).toHaveTextContent(/Projects & tasks/i);
});

// The other half of the empty catalog, and the one that leaves a mark: what
// Collect SENDS.
//
// `ensureBatch` passed `s.project` / `s.task` straight into POST /api/v1/batches,
// and on an empty catalog those held the em dash the header displays. So the
// placeholder was written into the shared catalog as a real label — permanently,
// on a row every other terminal reads, and (unlike the display) with nothing
// downstream able to tell it from a project someone deliberately named "—".
// `condition` was already guarded against exactly this (`s.condition !== '—'`),
// which is the clearest evidence the sentinel was never meant to travel.
//
// The server made both fields optional (2026-08-06) and stores/returns `null`,
// so the honest wire form is to omit them.
test('an empty catalog sends NO project or task rather than the placeholder', async () => {
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/plans')) return Promise.resolve(jsonResponse(EMPTY_SERVER_CATALOG));
    if (url.includes('/config')) return Promise.resolve(jsonResponse(CONFIG));
    if (url.includes('/batches') && method === 'POST') {
      posted.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve(
        jsonResponse({ batch_id: 'b1', batch_seq: 1, project: null, task: null }),
      );
    }
    if (url.includes('/record/start')) {
      return Promise.resolve(
        jsonResponse({
          capture_id: 'cap_empty',
          run_id: 'run_empty',
          state: 'recording',
          review_status: 'pending',
          review_revision: 0,
        }),
      );
    }
    if (url.includes('/record/status')) {
      return Promise.resolve(
        jsonResponse({ run_id: null, state: 'created', live_capture_ids: [] }),
      );
    }
    if (url.includes('/batches')) return Promise.resolve(jsonResponse({ items: [] }));
    if (url.includes('/captures'))
      return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
    return Promise.resolve(jsonResponse({}));
  });

  ensurePlansSynced();
  await waitFor(() => expect(getPlans()).toEqual([]));
  __resetBatchStore();

  renderCollect();
  fireEvent.click(await screen.findByTestId('start-recording'));

  await waitFor(() => expect(posted).toHaveLength(1));
  const body = posted[0]!;
  // Positive control: this really is the batch-create body, so the absences
  // below are absences from the right request.
  expect(body).toHaveProperty('target_episodes');
  // Nothing fabricated travels. `null` and "absent" are both fine — a label
  // nobody chose is what must not.
  expect(body.project ?? null).toBeNull();
  expect(body.task ?? null).toBeNull();
});
