// Contract §13, scenario 3 — Discard.
//
//   the reason-required modal → the capture disappears from the lists →
//   lifecycle.jsonl carries capture_discarded and objects/<id> is gone.
//
// §7 makes discard one-way: there is no restore from .trash, and once the files
// are gone the ledger line is the only surviving explanation. That is why the
// dialog refuses to arm without a reason (§12), and why this test asserts the
// refusal itself — a confirm button that is merely *labelled* required, but
// clickable, would lose the only record of why data was destroyed.
//
// "A reason" has two shapes, and both are asserted here. A preset chip IS
// saying why — one click, no typing, which is what an operator discarding
// obviously-bad takes all session actually does — and "Other" keeps the open
// field for anything the presets do not cover. The required-ness lives in the
// COMPOSED reason, so the refusals are asserted where they can still happen:
// nothing chosen, and Other with nothing (or only whitespace) in it.
//
// This scenario records its OWN capture. Discarding a capture the other
// scenarios depend on would couple them through the store, and a suite whose
// scenarios silently consume each other's fixtures is a suite that fails in the
// wrong place.

import { expect, test } from '@playwright/test';
import { api } from '../fixtures/api';
import { store } from '../fixtures/store';
import { openTab, recordThroughUi, reviewRow, selectReviewRow } from '../fixtures/ui';

/** The preset this scenario discards with. `composeDiscardReason` puts the
 *  chip's LABEL on the wire (plus a prefilled detail where one exists — this
 *  capture has none), so the label is exactly what the ledger must carry. */
const CHIP_ID = 'failed_take';
const CHIP_LABEL = 'Failed take';

/** Typed under "Other", then abandoned by switching back to the preset. It
 *  must not reach the ledger: the detail belongs to the answer it was written
 *  for, and a changed mind cannot be allowed to record words nobody stood by. */
const OTHER_TEXT = 'e2e: gripper never closed — unusable take';

test.describe.configure({ mode: 'serial' });

test('§13-3 Discard: the modal requires a reason, the capture leaves the lists, the ledger keeps the tombstone', async ({
  page,
}) => {
  const captureId = await recordThroughUi(page, { seconds: 4 });
  expect(store.captureExists(captureId), 'the recording produced no objects/<id>').toBe(true);

  // ---- exclude first: discard is only offered for an excluded capture ------
  await selectReviewRow(page, captureId);
  await page.getByTestId('review-decision-exclude').click();
  await expect(page.getByTestId('review-toast')).toBeVisible({ timeout: 30_000 });

  // An excluded capture drops out of the default view; the operator brings it
  // back with the list's own toggle.
  await expect(reviewRow(page, captureId)).toBeHidden({ timeout: 30_000 });
  await page.getByRole('button', { name: /Show excluded/ }).click();
  await expect(reviewRow(page, captureId)).toBeVisible({ timeout: 30_000 });
  await reviewRow(page, captureId).click();

  // ---- PRIMARY: the dialog states the cost and refuses to arm blank --------
  await page.getByTestId('review-discard-one').click();
  const dialog = page.getByTestId('discard-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('discard-irreversible')).toContainText(/cannot be undone/i);
  await expect(page.getByTestId('discard-scope')).toContainText('1 recording');

  const confirm = page.getByTestId('discard-confirm');
  await expect(confirm, 'discard armed before any reason was given').toBeDisabled();

  // (a) The preset path: one click, no typing, and the dialog arms.
  await page.getByTestId(`discard-reason-${CHIP_ID}`).click();
  await expect(confirm, 'a preset reason did not arm the discard').toBeEnabled();

  // (b) The open path, where "required" is still enforced keystroke by
  // keystroke. Choosing Other says nothing on its own, and neither does
  // whitespace.
  await page.getByTestId('discard-reason-other').click();
  await expect(confirm, 'discard armed on "Other" with an empty field').toBeDisabled();
  await page.getByTestId('discard-reason').fill('   ');
  await expect(confirm, 'discard armed on a whitespace-only reason').toBeDisabled();
  await page.getByTestId('discard-reason').fill(OTHER_TEXT);
  await expect(confirm, 'a typed reason did not arm the discard').toBeEnabled();

  // Back to the preset — and the preset is what must reach the ledger. The
  // typed words were abandoned, so recording them would be recording a reason
  // the operator withdrew.
  await page.getByTestId(`discard-reason-${CHIP_ID}`).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // ---- PRIMARY: it disappears from the lists ------------------------------
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(reviewRow(page, captureId)).toBeHidden({ timeout: 60_000 });

  // …and stays gone on a fresh load, including with excluded shown — a row that
  // only *looks* gone because a filter hid it would be a different bug wearing
  // the same face.
  await openTab(page, 'review');
  await expect(reviewRow(page, captureId)).toHaveCount(0, { timeout: 30_000 });
  const showExcluded = page.getByRole('button', { name: /Show excluded/ });
  if (await showExcluded.isVisible().catch(() => false)) {
    await showExcluded.click();
    await expect(reviewRow(page, captureId)).toHaveCount(0);
  }

  // ---- SECONDARY: the tombstone and the files ----------------------------
  const events = store.ledgerFor(captureId, 'capture_discarded');
  expect(events.length, 'no capture_discarded event in lifecycle.jsonl').toBe(1);
  expect(events[0].schema_version).toBe(2);
  expect(events[0].event_id, 'the ledger event has no idempotency key').toBeTruthy();
  expect(JSON.stringify(events[0]), 'the operator reason was not kept').toContain(CHIP_LABEL);
  expect(
    JSON.stringify(events[0]),
    'words typed under Other and then abandoned were written into the ledger anyway',
  ).not.toContain(OTHER_TEXT);

  expect(store.captureExists(captureId), 'objects/<id> survived the discard').toBe(false);

  // §7-4: the row is a tombstone, not a deletion — the store stays answerable
  // for where the recording went.
  const tombstone = (await api.allCaptures(true)).find((c) => c.capture_id === captureId);
  expect(tombstone, 'the capture row was removed instead of tombstoned').toBeDefined();
  expect(tombstone!.state).toBe('discarded');
  expect(tombstone!.delete_kind).toBe('discard');
  expect(tombstone!.delete_reason).toBe(CHIP_LABEL);
});
