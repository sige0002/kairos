// Page helpers for the real frontend.
//
// Everything here selects on committed data-testids or on accessible roles —
// never on CSS classes or DOM shape, which change with a restyle and would make
// this suite a brake on the UI instead of a check of it. Where the app has no
// testid on a control (Start/Stop are plain buttons), the accessible name is
// used, which is what an operator reads anyway.

import { expect, type Locator, type Page } from '@playwright/test';
import { api, type Capture } from './api';

export type TabId = 'collect' | 'review' | 'datasets' | 'validation' | 'monitor' | 'settings';

/** Open a tab by its URL state and wait for the shell to have finished booting.
 *  The app renders "Loading kairos…" until GET /config resolves, so asserting
 *  on the selected tab (not merely on navigation) is what proves it is live. */
export async function openTab(page: Page, tab: TabId): Promise<void> {
  await page.goto(`/?tab=${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toHaveAttribute('aria-selected', 'true', {
    timeout: 60_000,
  });
}

export const phaseTitle = (page: Page): Locator => page.getByTestId('phase-title');

/** Seconds shown on the Collect screen's `elapsed` chip (`00:MM:SS`). */
export async function elapsedSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('elapsed').textContent()) ?? '';
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Drive one complete recording through the Collect screen: Start → wait →
 * Stop → label → Save.
 *
 * The wait is on the screen's own `elapsed` counter rather than a sleep, so
 * the test asks for "at least N seconds of recording" and the UI answers when
 * that is true — a slow arming does not silently shorten the bag.
 *
 * Returns the capture_id. Identifying WHICH capture the operator just made is a
 * lookup, not an assertion: the Collect screen never shows a capture_id, so the
 * id is read by diffing the catalog. Every claim about that capture is then
 * made against the UI.
 */
export async function recordThroughUi(
  page: Page,
  opts: { seconds?: number; failure?: boolean } = {},
): Promise<string> {
  const seconds = opts.seconds ?? 5;
  await openTab(page, 'collect');

  const before = new Set((await api.allCaptures(true)).map((c) => c.capture_id));

  await expect(phaseTitle(page)).toHaveText('READY', { timeout: 90_000 });
  await page.getByRole('button', { name: /Start recording/ }).click();

  // ARMING… is skipped entirely when the recorder is pre-armed, so the wait is
  // for RECORDING and nothing in between.
  await expect(phaseTitle(page)).toHaveText('RECORDING', { timeout: 120_000 });

  await expect
    .poll(() => elapsedSeconds(page), {
      message: `recording never reached ${seconds}s of elapsed time`,
      timeout: (seconds + 60) * 1000,
      intervals: [500],
    })
    .toBeGreaterThanOrEqual(seconds);

  await page.getByRole('button', { name: /Stop recording/ }).click();

  // SAVING… → QUICK CHECK… → "Episode N result". Only the destination matters.
  await expect(phaseTitle(page)).toHaveText(/result$/, { timeout: 180_000 });

  if (opts.failure) {
    await page.getByRole('button', { name: '✕ Failure' }).click();
    await page.getByTestId('save-episode').waitFor();
  }

  const saved = page.getByTestId('save-episode');
  await expect(saved).toBeEnabled();
  await saved.click();

  // The save is the first review write for this capture (§4.1), so it is done
  // when the screen has left the result phase.
  await expect(phaseTitle(page)).not.toHaveText(/result$/, { timeout: 60_000 });

  const after = await api.allCaptures(true);
  const fresh = after.filter((c) => !before.has(c.capture_id));
  if (fresh.length !== 1) {
    throw new Error(
      `expected exactly one new capture after the Collect flow, saw ${fresh.length}: ` +
        JSON.stringify(fresh.map((c) => [c.capture_id, c.state])),
    );
  }
  return fresh[0].capture_id;
}

// ---- Review -----------------------------------------------------------------

export const reviewRow = (page: Page, id: string): Locator => page.getByTestId(`review-row-${id}`);

export const availabilityChip = (page: Page, id: string): Locator =>
  page.getByTestId(`review-availability-${id}`);

/** The `data-availability` kind the chip is currently showing, or null when the
 *  row is not on screen. `verifying` = digest pending, `verified` = complete,
 *  `missing` = the files vanished outside kairos (§7). */
export async function availabilityKind(page: Page, id: string): Promise<string | null> {
  const chip = availabilityChip(page, id);
  if ((await chip.count()) === 0) return null;
  return chip.getAttribute('data-availability');
}

export async function selectReviewRow(page: Page, id: string): Promise<void> {
  await openTab(page, 'review');
  await expect(reviewRow(page, id)).toBeVisible({ timeout: 60_000 });
  await reviewRow(page, id).click();
  await expect(page.getByTestId('review-detail-header')).toBeVisible();
}

/** The detail panel's revision line: "not reviewed yet" or "revision N". */
export async function shownRevision(page: Page): Promise<number> {
  const text = (await page.getByTestId('review-revision').textContent()) ?? '';
  if (/not reviewed yet/i.test(text)) return 0;
  const m = /revision\s+(\d+)/i.exec(text);
  if (!m) throw new Error(`review-revision did not read as a revision: "${text}"`);
  return Number(m[1]);
}

// ---- Monitor › Store --------------------------------------------------------

export async function openStoreHealth(page: Page): Promise<void> {
  await openTab(page, 'monitor');
  await page.getByTestId('mon-nav-Store').click();
  await expect(page.getByTestId('store-health-panel')).toBeVisible({ timeout: 30_000 });
}

/** Re-read the store's condition through the panel's own Refresh button — the
 *  panel polls on a 30 s timer and a test should not be waiting on that. */
export async function refreshStoreHealth(page: Page): Promise<void> {
  const refresh = page.getByTestId('store-health-refresh');
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
}

// ---- misc -------------------------------------------------------------------

/** Capture ids the Review screen is listing right now, in DOM order.
 *  Reads the current page — the caller opens the tab and waits for whatever it
 *  expects to be there, so an empty result here means "the list is empty",
 *  not "the list has not loaded". */
export function listedCaptureIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="review-row-"]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.captureId ?? ''));
}

export function summarise(c: Capture): string {
  return `${c.capture_id.slice(0, 8)} state=${c.state} review=${c.review_status}#${c.review_revision} digest=${c.digest_state} replica=${c.replica?.state ?? 'none'}`;
}
