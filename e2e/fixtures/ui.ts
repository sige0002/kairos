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

// ---- Monitor › Topics -------------------------------------------------------

/** Open Monitor and switch to the Topics sub-view. The sub-nav is component
 *  state, not URL state, so there is no `?tab=` shortcut to the table — the
 *  operator clicks, and so does this. */
export async function openMonitorTopics(page: Page): Promise<void> {
  await openTab(page, 'monitor');
  await page.getByTestId('mon-nav-Topics').click();
  await expect(page.getByTestId('add-chart')).toBeVisible({ timeout: 30_000 });
}

export const topicRow = (page: Page, name: string): Locator =>
  page.getByTestId(`topic-row-${name}`);

/**
 * One Monitor topic row as the operator reads it, cell by cell.
 *
 * The cells carry no testids — only the row does — so they are read in the
 * order the table's own header declares: Rec | Topic | Hz | Expected |
 * Bandwidth | Max gap | Status. That positional read is safe here only because
 * every assertion built on it is also SHAPE-checked (`hz` must look like a
 * rate, `bandwidth` like a unit-carrying size): a column inserted upstream
 * shifts the indices and fails those regexes loudly rather than quietly
 * comparing the wrong column. If a scenario ever needs finer access than this,
 * the fix is a testid in `services/frontend`, not a cleverer selector here.
 */
export async function topicRowCells(
  page: Page,
  name: string,
): Promise<{ hz: string; expected: string; bandwidth: string; gap: string; status: string }> {
  const cells = await topicRow(page, name).locator(':scope > *').allTextContents();
  const at = (i: number): string => (cells[i] ?? '').trim();
  return { hz: at(2), expected: at(3), bandwidth: at(4), gap: at(5), status: at(6) };
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

// ---- Settings › Recording ---------------------------------------------------

/** "Recording" in the Settings menu rail. The rail's testids are positional,
 *  so the section is confirmed by its OWN testid immediately after the click —
 *  a reordered menu then fails with "settings-recording never appeared"
 *  instead of quietly asserting against whatever section index 4 became. */
const RECORDING_MENU_INDEX = 4;

export async function openRecordingSettings(page: Page): Promise<void> {
  await openTab(page, 'settings');
  await page.getByTestId(`settings-menu-item-${RECORDING_MENU_INDEX}`).click();
  await expect(page.getByTestId('settings-recording')).toBeVisible({ timeout: 30_000 });
}

/** Reveal the raw-JSON editor — the screen demotes JSON to an "Advanced" disclosure,
 *  so it is closed on arrival — and hand back its textarea, seeded.
 *
 *  The seeding is an effect over `GET /config/recording`, so the textarea is
 *  mounted and EMPTY for a beat before it holds the config. Reading it in that
 *  beat yields "" and fails as a JSON parse error several assertions later,
 *  blaming the wrong thing; waiting for content here keeps that from being a
 *  race every caller has to remember. */
export async function openRecordingJsonEditor(page: Page): Promise<Locator> {
  const toggle = page.getByTestId('recording-advanced-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('recording-advanced')).toBeVisible({ timeout: 30_000 });
  const editor = page.getByLabel('recording config json', { exact: true });
  await expect(editor, 'the config editor never loaded the recording config').not.toHaveValue('', {
    timeout: 30_000,
  });
  return editor;
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
