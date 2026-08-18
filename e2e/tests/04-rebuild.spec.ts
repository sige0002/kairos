// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Contract §13, scenario 4 — rebuild from the sidecars.
//
//   stop the stack → delete kairos.db → restart → the UI shows the same
//   captures and datasets.
//
// §8 says kairos.db is an INDEX: everything in it must be reconstructible from
// object_manifest.json, record.json and lifecycle.jsonl. The only way to test
// that claim honestly is to destroy the index and look at the screen — a test
// that merely calls a rebuild endpoint with the database still present proves
// nothing about whether the sidecars were sufficient.
//
// The dataset half matters just as much: §6 made datasets logical (DB rows plus
// ledger events, no directory tree), which means a dataset has NO sidecar of
// its own. If the ledger replay is wrong, the dataset is simply gone — and it
// would be gone silently, with a perfectly healthy-looking capture list beside
// it.

import { expect, test } from '@playwright/test';
import { api, until } from '../fixtures/api';
import { store } from '../fixtures/store';
import { stack } from '../fixtures/stack';
import {
  listedCaptureIds,
  openTab,
  recordThroughUi,
  reviewRow,
  selectReviewRow,
  shownRevision,
} from '../fixtures/ui';

const DATASET_NAME = 'e2e-rebuild-set';

// Deliberately NOT serial: the failed-start regression below restores the stack
// itself, and it is the test most likely to be needed on a run where the
// scenario above already went red. Skipping it there would hide the finding it
// exists to name.

test('§13-4 Rebuild: deleting kairos.db and restarting restores the captures and datasets in the UI', async ({
  page,
}, testInfo) => {
  // ---- arrange: something worth losing ------------------------------------
  let completed = (await api.allCaptures()).filter((c) => c.state === 'completed');
  if (completed.length === 0) {
    await recordThroughUi(page, { seconds: 4 });
    completed = (await api.allCaptures()).filter((c) => c.state === 'completed');
  }
  const memberCapture = completed[0].capture_id;

  // m10: nothing unjudged enters a training set. The candidate rail refuses a
  // capture Review has not adopted (`addBlockedReason`), so this scenario has to
  // arrive at an ADOPTED capture before it can build anything.
  //
  // Being adopted is the requirement; clicking is only one way to get there. A
  // good, successful take is adopted by its Collect save (`collectReviewStatus`),
  // and the decision bar then correctly offers no adopt control — a capture that
  // needs no action is shown none. Demanding the button would fail on a capture
  // already in exactly the state this step wants.
  //
  // The postcondition still catches the regression the step was written for: a
  // capture that is neither adopted nor offered any way to become adopted can
  // never reach a dataset, and this times out saying precisely that.
  await selectReviewRow(page, memberCapture);
  const markOk = page.getByTestId('review-mark-ok');
  const adoptedBySave = (await markOk.count()) === 0;
  if (!adoptedBySave) {
    await markOk.click();
    await expect(page.getByTestId('review-toast')).toBeVisible({ timeout: 30_000 });
  }
  await until(
    'the capture to read as adopted — the decision bar offered no way to adopt it and it ' +
      'was not adopted already, so no dataset can ever be built from it',
    () => api.getCapture(memberCapture),
    (c) => c.review_status === 'adopted',
    30_000,
  );
  // WHICH road got there is a race — whether the quick check had settled before
  // Collect's Save decided the review status — so it is REPORTED rather than
  // asserted. A CI log that does not say which one leaves the reader unable to
  // tell a run that exercised the decision-bar control from one that never
  // needed it.
  const adoptionRoad = adoptedBySave
    ? 'adopted by its own Collect save; the decision bar offered no control, which is correct'
    : 'adopted from the Review decision bar (review-mark-ok)';
  testInfo.annotations.push({ type: 'adoption', description: adoptionRoad });
  // eslint-disable-next-line no-console
  console.log(`  adoption: ${adoptionRoad}`);

  // A dataset, built through the UI, so the ledger has the events a rebuild has
  // to replay.
  await openTab(page, 'datasets');
  await page.getByTestId('new-dataset-btn').click();
  await page.getByTestId('new-dataset-name').fill(DATASET_NAME);
  await page.getByTestId('new-dataset-operator').fill('e2e');
  await page.getByTestId('new-dataset-submit').click();

  // Creating selects the new dataset, so the build rail is already pointed at it.
  await expect(page.getByTestId('build-target')).toContainText(DATASET_NAME, { timeout: 30_000 });
  await page.getByTestId(`dataset-add-${memberCapture}`).click();
  await expect(page.getByTestId('build-target')).toContainText('1 member', { timeout: 30_000 });

  const datasetId = (await api.listDatasets()).items.find((d) => d.name === DATASET_NAME)!
    .dataset_id;
  const recipe = await api.recordDatasetSelectionRecipe(datasetId, {
    join: 'or',
    conditions: [{ field: 'condition', operator: 'equals', value: 'rebuild' }],
    matched: 1,
    attempted: 1,
    succeeded: 1,
    failed: 0,
  });
  expect(recipe.recipe_id).not.toBe('');

  // ---- snapshot what the operator can see ---------------------------------
  // The list is fetched after mount, so waiting for a row we KNOW is there is
  // what separates "the catalog is empty" from "the table has not painted yet".
  // Reading it without that wait is how this test once accused the rebuild of
  // losing every capture it had in fact restored.
  await openTab(page, 'review');
  await expect(reviewRow(page, memberCapture)).toBeVisible({ timeout: 60_000 });
  const before = await listedCaptureIds(page);
  expect(before.length, 'nothing to rebuild — the catalog is empty').toBeGreaterThan(0);

  await selectReviewRow(page, memberCapture);
  const revisionBefore = await shownRevision(page);

  // The EXPECTED set is the store's own account, read at the last moment
  // before the index dies — not the painted list above. The screen snapshot
  // proves the operator can see the store; as an expected set it is racy: a
  // failed pre-arm files a capture with no operator action at all (Collect's
  // keep-alive arms in the background, and its failure is a §3.4 sidecar plus
  // a failed row), so one landing after the list painted would read here as
  // "the rebuild invented a capture". That exact run happened once.
  const preRebuild = await api.allCaptures();

  // The sidecars are what the rebuild must read; note they are all there before
  // the index goes, so a failure afterwards is a rebuild failure and not a
  // missing-input failure. A failed row's only sidecar is `.failed.json` — no
  // manifest — so the manifest check covers the settled recordings.
  for (const c of preRebuild.filter((c) => c.state === 'completed')) {
    expect(
      store.manifest(c.capture_id).capture_id,
      `objects/${c.capture_id} has no usable manifest`,
    ).toBe(c.capture_id);
  }
  expect(store.ledger().length, 'the ledger is empty — a dataset rebuild cannot work').toBeGreaterThan(0);

  // ---- act: destroy the index --------------------------------------------
  stack('stop');
  stack('rm-db');
  expect(store.dbExists(), 'kairos.db was not actually deleted').toBe(false);
  stack('start');

  // The orchestrator rebuilds on boot when the database is missing; give it the
  // boot, then look at the screen.
  await expect
    .poll(async () => (await api.storeHealth()).rebuilt_at, {
      message: 'the orchestrator never reported a rebuild after kairos.db was deleted',
      timeout: 120_000,
      intervals: [1_000],
    })
    .not.toBeNull();

  // ---- assert: the UI shows the same store -------------------------------
  await openTab(page, 'review');
  const expected = preRebuild
    .map((c) => c.capture_id)
    .sort()
    .join('\n');
  await expect
    .poll(async () => (await listedCaptureIds(page)).sort().join('\n'), {
      message: 'the rebuilt catalog does not list the same captures',
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(expected);
  const after = await listedCaptureIds(page);

  // §4.1-4: review state comes back from record.json, not from the index that
  // was just deleted.
  await selectReviewRow(page, memberCapture);
  expect(await shownRevision(page), 'the review revision did not survive the rebuild').toBe(
    revisionBefore,
  );
  expect(store.record(memberCapture)!.revision).toBe(revisionBefore);

  // §6: the dataset and its membership were rebuilt from the ledger alone.
  await openTab(page, 'datasets');
  const datasetRow = page.getByTestId(`dataset-row-${datasetId}`);
  await expect(datasetRow, 'the dataset did not come back after the rebuild').toBeVisible({
    timeout: 60_000,
  });
  await expect(datasetRow).toContainText(DATASET_NAME);
  await datasetRow.click();
  await expect(page.getByTestId('build-target')).toContainText('1 member', { timeout: 30_000 });
  await expect(page.getByTestId('dataset-selection-recipes')).toContainText('OR');
  await expect(page.getByTestId('dataset-selection-recipes')).toContainText(
    'condition equals “rebuild”',
  );
  expect((await api.getDataset(datasetId)).selection_recipes).toHaveLength(1);

  // SECONDARY: the store's own account of what it did.
  const health = await api.storeHealth();
  expect(health.state).toBe('ok');
  expect(health.rebuild_summary, 'a rebuild ran but reported no summary').not.toBeNull();
  expect(health.corrupt, `rebuild reported corrupt sidecars: ${JSON.stringify(health.corrupt)}`)
    .toHaveLength(0);

  // A tombstoned capture must stay tombstoned: §13-3 discarded one, and a
  // rebuild that resurrects it from a leftover directory would be worse than
  // losing it.
  const discarded = (await api.allCaptures(true)).filter((c) => c.state === 'discarded');
  for (const t of discarded) {
    expect(after, 'a discarded capture came back into the Review list').not.toContain(t.capture_id);
  }
});

/**
 * §3.4 + §8: a rebuild must also read `objects/<id>.failed.json` and make a
 * `state='failed'` row from it.
 *
 * This exists because the scenario above found the bug intermittently: a failed
 * start happened to land in the store during one run, and after the rebuild the
 * WHOLE catalog answered 500. Left as a race it would be an occasional red run
 * that gets re-run away; planted deliberately it is a named, reproducible
 * defect. A failed start is a normal condition — the recorder could not arm —
 * and it must not be able to take the capture list down with it.
 *
 * The sidecar is removed and the index rebuilt again in the `finally`, so a
 * failure here stays this scenario's failure instead of cascading into §13-5.
 */
test('§13-4 Rebuild: a failed start does not take the whole capture list down', async ({
  page,
}) => {
  const failedId = '019fc140-0000-7000-8000-0000feed0001';
  const sidecar = store.writeFailedStart(failedId);

  try {
    stack('stop');
    stack('rm-db');
    // Lenient: an unreadable catalog is exactly what this scenario is looking
    // for, so it must be reported by the assertion below — which says what it
    // means — and not by a readiness timeout in the harness.
    stack('start-lenient');

    // ---- PRIMARY: the operator's capture list still works -----------------
    await openTab(page, 'review');
    await expect
      .poll(async () => (await listedCaptureIds(page)).length, {
        message:
          'the Review list stayed empty after a rebuild that read a failed-start sidecar — ' +
          'one recording that never armed has taken every healthy capture off the screen',
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(0);

    // SECONDARY: and the catalog is readable at all.
    const captures = await api.allCaptures(true);
    expect(captures.length).toBeGreaterThan(0);
    // §3.4: the failed start is present as a row rather than silently dropped.
    expect(
      captures.map((c) => c.capture_id),
      'the rebuild did not produce a row for objects/<id>.failed.json',
    ).toContain(failedId);
  } finally {
    store.removeIfPresent(sidecar);
    stack('stop');
    stack('rm-db');
    stack('start');
  }
});
