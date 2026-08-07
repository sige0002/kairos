// Contract §13, scenario 2 — Review.
//
//   save labels → assert through the UI (the revision line and the conflict
//   banner) → corroborate that objects/<id>/record.json carries that revision.
//
// §4.1 makes record.json the truth for review state and the database a cache,
// and it makes `revision` the CAS token. So the two things a UI acceptance test
// has to prove are: the number the operator sees is the number on disk, and a
// save made against a stale number is REFUSED and said so — not silently
// applied, and not silently dropped.

import { expect, test } from '@playwright/test';
import { api, until } from '../fixtures/api';
import { store } from '../fixtures/store';
import { openTab, recordThroughUi, selectReviewRow, shownRevision } from '../fixtures/ui';

test.describe.configure({ mode: 'serial' });

/** A completed capture to review — reuse one if the run already made one, so
 *  this scenario costs a recording only when run on its own. */
async function reviewableCapture(page: import('@playwright/test').Page): Promise<string> {
  const existing = (await api.allCaptures()).filter((c) => c.state === 'completed');
  if (existing.length > 0) return existing[0].capture_id;
  return recordThroughUi(page, { seconds: 5 });
}

test('§13-2 Review: a saved label advances the revision on screen and in record.json', async ({
  page,
}) => {
  const captureId = await reviewableCapture(page);
  await selectReviewRow(page, captureId);

  const before = await shownRevision(page);
  const recordBefore = store.record(captureId);
  expect(
    recordBefore === null ? 0 : recordBefore.revision,
    'the revision on screen disagrees with record.json before any edit',
  ).toBe(before);

  // ---- PRIMARY: the operator changes the final quality ---------------------
  // Every Review control saves on click; there is no separate Save button, so
  // the click IS the save and the toast is its acknowledgement.
  await page.getByTestId('review-final-quality').click();
  await expect(page.getByTestId('review-toast')).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(() => shownRevision(page), {
      message: 'the revision line never advanced after saving a quality',
      timeout: 30_000,
    })
    .toBe(before + 1);

  // ---- SECONDARY: the sidecar carries that exact revision ------------------
  const afterQuality = await until(
    'record.json to reach the revision shown on screen',
    async () => store.record(captureId),
    (r) => r !== null && r.revision === before + 1,
    30_000,
  );
  expect(afterQuality!.capture_id).toBe(captureId);
  expect(afterQuality!.quality, 'a quality was saved but record.json has none').not.toBeNull();
  expect(afterQuality!.quality_source).toBe('operator');

  // ---- PRIMARY: a second edit advances it again ---------------------------
  await page.getByTestId('review-task-result').click();
  await expect
    .poll(() => shownRevision(page), {
      message: 'the revision line never advanced after saving a task result',
      timeout: 30_000,
    })
    .toBe(before + 2);

  const afterTask = store.record(captureId)!;
  expect(afterTask.revision).toBe(before + 2);
  expect(afterTask.task_result).not.toBeNull();
  // §4.1-4: record.json is the truth and the DB the cache — they must agree
  // after a settled save.
  const capture = await api.getCapture(captureId);
  expect(capture.review_revision).toBe(afterTask.revision);
  expect(capture.task_result).toBe(afterTask.task_result);
  expect(capture.quality).toBe(afterTask.quality);
});

test('§13-2 Review: a save against a stale revision is refused and the UI says so', async ({
  page,
}) => {
  const captureId = (await api.allCaptures()).find((c) => c.state === 'completed')!.capture_id;
  await selectReviewRow(page, captureId);
  const onScreen = await shownRevision(page);

  // Another terminal saves first. This is the ONLY way to produce the conflict
  // the banner exists for, and it is a legitimate second actor rather than a
  // stubbed error: the screen still holds base_revision = onScreen.
  await api.saveReview(captureId, { base_revision: onScreen, review_status: 'pending' });
  expect((await api.getCapture(captureId)).review_revision).toBe(onScreen + 1);

  // ---- PRIMARY: the operator's next click is refused, visibly --------------
  await page.getByTestId('review-final-quality').click();

  const banner = page.getByTestId('review-conflict-banner');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('review-conflict-message')).toBeVisible();
  // The banner has to show what the capture actually is now, or "reload" is an
  // instruction without information.
  await expect(page.getByTestId('review-conflict-current')).toBeVisible();

  // ---- SECONDARY: the refusal really refused ------------------------------
  // The losing save must not have advanced anything: exactly one write landed.
  const record = store.record(captureId)!;
  expect(record.revision, 'a conflicting save was applied anyway').toBe(onScreen + 1);
  expect((await api.getCapture(captureId)).review_revision).toBe(onScreen + 1);

  // Dismissing clears it; the screen is usable again after a reload.
  await page.getByTestId('review-conflict-dismiss').click();
  await expect(banner).toBeHidden();

  await openTab(page, 'review');
  await selectReviewRow(page, captureId);
  expect(await shownRevision(page)).toBe(onScreen + 1);
});
