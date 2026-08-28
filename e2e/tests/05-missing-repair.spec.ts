// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Contract §13, scenario 5 — an out-of-band `rm -rf objects/<id>`.
//
//   remove the files behind kairos's back → Repair from the Monitor store-health
//   panel → the UI shows the captures as missing. They do NOT silently vanish.
//
// This is the scenario the rest of the design is arranged around (§7, §9-2,
// §9-3). An external removal is NOT a deletion: the capture row stays, the
// replica becomes `missing_unmanaged`, and the operator is told. The failure
// this guards against is the comfortable one — a catalog that quietly forgets
// the recordings whose files went away, leaving nobody able to say what was
// lost.
//
// Reaching Repair requires crossing the §9-3 threshold (`missing > max(5, 10%
// of present replicas)`), because below it the store simply applies the
// transition and there is nothing for an operator to approve. Six captures are
// therefore removed and one is deliberately left behind, so the test also
// proves the surviving capture is untouched by the acknowledgement.

import { expect, test } from '@playwright/test';
import { api, recordCaptureViaApi, until } from '../fixtures/api';
import { stack } from '../fixtures/stack';
import { store } from '../fixtures/store';
import { availabilityKind, openStoreHealth, openTab, refreshStoreHealth, reviewRow } from '../fixtures/ui';

/** §9-3: `max(5, denominator // 10)`, and the guard is a strict `>`. With fewer
 *  than 60 present replicas that is a flat 5, so 6 removals is the smallest set
 *  that latches SUSPECT. */
const REMOVE_COUNT = 6;

test.describe.configure({ mode: 'serial' });

test('§13-5 rm -rf: removed captures are reported missing after Repair, never silently dropped', async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);

  // ---- arrange: enough present replicas to cross the §9-3 threshold -------
  // SETUP, not the behaviour under test: §13-1 already covers recording through
  // the browser, and re-testing the Collect screen seven more times would add
  // four minutes without adding a claim.
  let present = (await api.allCaptures()).filter(
    (c) => c.state === 'completed' && c.replica?.state?.startsWith('present'),
  );
  while (present.length < REMOVE_COUNT + 1) {
    await recordCaptureViaApi({ operator: 'e2e', task: 'threshold', seconds: 3 });
    present = (await api.allCaptures()).filter(
      (c) => c.state === 'completed' && c.replica?.state?.startsWith('present'),
    );
  }

  const doomed = present.slice(0, REMOVE_COUNT).map((c) => c.capture_id);
  const survivor = present[REMOVE_COUNT].capture_id;

  // ---- baseline: the operator can see them all ---------------------------
  await openTab(page, 'review');
  for (const id of [...doomed, survivor]) {
    await expect(reviewRow(page, id), `capture ${id} is not listed before the removal`).toBeVisible({
      timeout: 60_000,
    });
  }

  // ---- act: remove the files behind kairos's back ------------------------
  for (const id of doomed) {
    expect(store.captureExists(id)).toBe(true);
    stack('rm-objects', id);
    expect(store.captureExists(id)).toBe(false);
  }
  expect(store.captureExists(survivor), 'the survivor was removed too').toBe(true);

  // The catalog has not looked yet — and must not have dropped anything on its
  // own. Nothing about a missing file is allowed to make a row disappear.
  await openTab(page, 'review');
  for (const id of doomed) {
    await expect(
      reviewRow(page, id),
      `capture ${id} vanished from the UI before anything even looked at the disk`,
    ).toBeVisible({ timeout: 30_000 });
  }

  // Drive the reconciler pass now instead of waiting out its 120 s timer. This
  // is the same code path the timer runs (POST /store/reconcile exists for
  // exactly this) — only the schedule is bypassed, never the logic.
  const pass = await api.reconcile();
  expect(pass.applied, `the pass applied itself despite ${REMOVE_COUNT} missing copies`).toBe(false);

  // ---- PRIMARY: the store says SUSPECT, on screen, in words --------------
  await openStoreHealth(page);
  await refreshStoreHealth(page);
  await expect(page.getByTestId('store-health-state')).toHaveText('suspect', { timeout: 60_000 });

  const suspect = page.getByTestId('store-health-suspect');
  await expect(suspect).toBeVisible();
  await expect(suspect).toContainText(/automatic clean-up is halted/i);
  await expect(suspect, 'SUSPECT was declared without saying why').toContainText(
    /local copies vanished/i,
  );
  // §9-5: recording must never be among the things a suspect store stops.
  await expect(suspect).toContainText(/recording is not stopped/i);

  // ---- PRIMARY: Repair is the operator's acknowledgement -----------------
  const repair = page.getByTestId('store-health-repair');
  await expect(repair, 'Repair is not offered while the store is SUSPECT').toBeEnabled();
  await repair.click();

  await expect(page.getByTestId('store-health-repair-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('store-health-repair-result')).toContainText(/SUSPECT cleared/i);

  await refreshStoreHealth(page);
  await expect(page.getByTestId('store-health-state')).toHaveText('ok', { timeout: 60_000 });

  // ---- PRIMARY: the captures are still there, and marked missing ---------
  await openTab(page, 'review');
  for (const id of doomed) {
    await expect(
      reviewRow(page, id),
      `capture ${id} vanished from the UI instead of being reported missing`,
    ).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => availabilityKind(page, id), {
        message: `capture ${id} is not shown as missing after the repair`,
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe('missing');
    await expect(page.getByTestId(`review-availability-${id}`)).toHaveText(/missing/i);
  }

  // The survivor is untouched: a repair acknowledges the storage, it does not
  // condemn everything on it.
  await expect(reviewRow(page, survivor)).toBeVisible();
  expect(await availabilityKind(page, survivor)).toBe('verified');

  // ---- SECONDARY: replica state moved, capture state did not -------------
  for (const id of doomed) {
    const capture = await until(
      `capture ${id} to report a missing replica`,
      () => api.getCapture(id),
      (c) => c.replica?.state === 'missing_unmanaged',
      60_000,
    );
    // §9-2 / §7: an external rm is not a deletion. The capture is still
    // `completed`, and there is no tombstone claiming kairos removed it.
    expect(capture.state, `${id} was re-stated as deleted by an external rm`).toBe('completed');
    expect(capture.delete_kind ?? null).toBeNull();
    expect(store.ledgerFor(id, 'capture_discarded'), 'an external rm wrote a discard event')
      .toHaveLength(0);
    expect(store.ledgerFor(id, 'capture_deleted'), 'an external rm wrote a delete event')
      .toHaveLength(0);
  }

  const survivorCapture = await api.getCapture(survivor);
  expect(survivorCapture.replica?.state).toBe('present_verified');
});
