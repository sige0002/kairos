// Regression pin for the defect class the §13 scenarios cannot reach:
// **a live claim that outruns what the UI actually knows.**
//
//   record → the recorder dies mid-take → the screen must stop asserting
//   RECORDING → the recorder comes back → the screen must NOT resurrect the
//   recording it can no longer see.
//
// The five contract scenarios all ask "did the store keep its promise?", and a
// stack whose recorder never dies answers yes to every one of them while the
// Collect screen is free to invent a recording. It did: qa-ui watched the
// elapsed timer climb 00:12 → 00:37 against a recorder that had been dead the
// whole time, and after the B1 fix landed, watched the returning recorder put a
// FRESH 00:00:00 timer on screen for a capture that no longer existed. Both
// were shipped-looking green: every service was healthy, every API answered.
//
// So the fault is injected where it really lives — one container of the running
// stack — and the verdict is read off the screen:
//
//   * while the recorder is gone: RECORDER UNREACHABLE, the timer FROZEN (a
//     moving clock is an active claim that a recording is progressing), and the
//     System status Recorder row saying it has no answer rather than a state.
//   * once it returns: `ready`, no timer at all, and the interrupted take
//     offered for recovery with its REAL bytes and the recorder's own reason —
//     §3's rule that the manifest is authoritative, seen from the UI end.
//
// Ordering: this is the only spec that stops a SERVICE rather than the whole
// stack, and it leaves one capture deliberately unreviewed (the interrupted
// one). The `06-` prefix puts it last under the suite's alphabetical, workers=1
// execution, so neither can reach another scenario; the recorder is restored in
// a `finally` regardless.

import { expect, test, type Page } from '@playwright/test';
import { api } from '../fixtures/api';
import { stack } from '../fixtures/stack';
import { store } from '../fixtures/store';
import { elapsedSeconds, ensureOperator, openTab, phaseTitle } from '../fixtures/ui';

/** Seconds of real recording before the recorder is killed. Long enough that
 *  rosbag2 has flushed MCAP chunks to disk — the recovered manifest's `bytes`
 *  is measured by stat'ing those files, and "the take kept its bytes" is half
 *  of what this scenario claims. */
const RECORD_SECONDS = 6;

/** How long the frozen timer is watched. Comfortably longer than the UI's
 *  5 s recorder poll (RECORD_STATUS_POLL_MS) plus its one retry, so a clock
 *  that is still ticking has had several chances to prove it. This is a
 *  deliberate wait, not a sleep standing in for a signal: the claim IS that
 *  nothing changes over an interval, and only elapsed time can test it. */
const FREEZE_WATCH_MS = 8_000;

const banner = (page: Page) => page.getByTestId('unsaved-take-banner');
const recorderRow = (page: Page) => page.getByTestId('sys-recorder');

/**
 * Dismiss any recovery banner the earlier scenarios left behind.
 *
 * SETUP, done through the operator's own control ("Later"). §13-5 bulk-records
 * six captures over the API and never reviews them, so by the time this spec
 * runs the banner may already be offering several takes — and with more than
 * one pending it summarises ("3 unsaved takes. Most recent: …") instead of
 * naming this take's kind. Clearing the backlog first is what makes the banner
 * asserted at the end unambiguously OUR interrupted take rather than a
 * coincidence of ordering.
 *
 * "Later" dismisses every take it currently knows about and remembers them by
 * id, so a take recorded AFTER this point still surfaces on its own.
 */
async function clearUnsavedTakeBacklog(page: Page): Promise<void> {
  // Mirrors the screen's own scan (newest 10, never-reviewed, recoverable
  // state) so we only wait for a banner that must actually appear — a blind
  // wait here would turn "nothing to dismiss" into a timeout.
  const scanned = (await api.listCaptures('?limit=10')).items;
  const offered = scanned.filter(
    (c) =>
      (c.state === 'completed' || c.state === 'interrupted') && c.review_revision === 0,
  );
  if (offered.length === 0) return;

  await expect(banner(page), 'unreviewed takes exist but no recovery banner offered them')
    .toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Later' }).click();
  await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
}

test('Recorder honesty: a dead recorder stops the RECORDING claim, and a returning one offers the interrupted take instead of resurrecting it', async ({
  page,
}) => {
  let recorderDown = false;
  try {
    // ---- arrange: one real recording, running -------------------------------
    await openTab(page, 'collect');
    // This scenario drives Start itself rather than through `recordThroughUi`
    // (it has to kill the recorder mid-take), so it names the operator itself
    // too — Start is disabled until it does.
    await ensureOperator(page);
    await clearUnsavedTakeBacklog(page);

    const before = new Set((await api.allCaptures(true)).map((c) => c.capture_id));

    await expect(phaseTitle(page)).toHaveText('READY', { timeout: 90_000 });
    await page.getByRole('button', { name: /Start recording/ }).click();
    await expect(phaseTitle(page)).toHaveText('RECORDING', { timeout: 120_000 });

    // The timer is ADVANCING — the baseline for the freeze assertion below.
    // Without this, a clock that never started would pass the freeze check.
    await expect
      .poll(() => elapsedSeconds(page), {
        message: `the elapsed timer never reached ${RECORD_SECONDS}s while the recorder was alive`,
        timeout: (RECORD_SECONDS + 60) * 1_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(RECORD_SECONDS);

    // And the side panel agrees a recording is running, so its later denial is
    // a change of answer rather than a row that never said anything.
    await expect(recorderRow(page)).toContainText('recording');
    await expect(recorderRow(page)).toContainText('REC');

    // The Collect screen never shows a capture_id, so WHICH capture this is is
    // a lookup, not an assertion (same rule as `recordThroughUi`).
    const live = (await api.allCaptures(true)).filter((c) => !before.has(c.capture_id));
    expect(live.map((c) => c.capture_id), 'expected exactly one new capture').toHaveLength(1);
    const captureId = live[0].capture_id;

    // ---- act: the recorder dies, mid-take -----------------------------------
    stack('stop-recorder');
    recorderDown = true;

    // ---- PRIMARY: the screen stops claiming a recording it cannot see -------
    await expect(phaseTitle(page), 'the UI kept claiming RECORDING after the recorder died')
      .toHaveText('RECORDER UNREACHABLE', { timeout: 90_000 });
    const note = page.getByTestId('recorder-unreachable-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('The recorder is not answering');

    // PRIMARY: and the clock stops. Two readings, one poll cycle apart.
    // The reading is checked for being a real, running clock first: two absent
    // or zeroed values compare equal, and a freeze assertion that passes on
    // "there was never a timer" pins nothing.
    const frozenAt = await page.getByTestId('elapsed').textContent();
    expect(
      await elapsedSeconds(page),
      `the unreachable card is not showing the last known elapsed time ("${frozenAt}")`,
    ).toBeGreaterThan(0);
    await page.waitForTimeout(FREEZE_WATCH_MS);
    const stillFrozenAt = await page.getByTestId('elapsed').textContent();
    expect(
      stillFrozenAt,
      `the elapsed timer kept climbing (${frozenAt} -> ${stillFrozenAt}) against a recorder ` +
        'that is not answering — an animating clock is an active claim that the recording is ' +
        'progressing, and there is no evidence for it',
    ).toBe(frozenAt);

    // PRIMARY: System status stops reporting a recorder state it cannot read.
    await expect(recorderRow(page)).toContainText('no answer');
    await expect(recorderRow(page)).toContainText('CHECK');
    expect(
      (await recorderRow(page).textContent()) ?? '',
      'the System status row still reported the recorder as recording',
    ).not.toContain('recording');

    // ---- act: the recorder comes back ---------------------------------------
    stack('start-recorder');
    recorderDown = false;

    // ---- PRIMARY: the return does not resurrect the dead recording ----------
    // The recorder answers again with an empty live set, so the take we could
    // not see through the outage is over. Re-entering RECORDING here (with a
    // fresh 00:00:00, which is what the second bug did) would be the same lie
    // the outage card had just stopped telling.
    await expect(
      phaseTitle(page),
      'the returning recorder resurrected the dead recording instead of releasing it',
    ).toHaveText('READY', { timeout: 180_000 });
    await expect(
      page.getByTestId('elapsed'),
      'a timer is on screen for a recording that no longer exists',
    ).toHaveCount(0);

    // ---- PRIMARY: the take is offered back, with the truth about it ---------
    await expect(banner(page), 'the interrupted take was never offered for recovery').toBeVisible({
      timeout: 120_000,
    });
    const identity = page.getByTestId('unsaved-take-identity');
    await expect(identity).toContainText('Interrupted take from');

    // Its REAL bytes. "0 B" is the shape of the bug this replaced: the generic
    // interrupt path left the live session's counters behind, and 10 MB of
    // recording was offered back as an empty take nobody would keep.
    // The size is parsed rather than string-matched: `not.toContain('0 B')`
    // alone also rejects a legitimate "900 B" and would then blame it for
    // being empty.
    const identityText = (await identity.textContent()) ?? '';
    const size = /—\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\b/.exec(identityText);
    expect(size, `the banner stated no size at all: "${identityText}"`).not.toBeNull();
    const [, amount, unit] = size!;
    expect(`${amount} ${unit}`, 'the interrupted take was offered as empty').not.toBe('0 B');
    expect(Number(amount), `the banner stated a zero size: "${identityText}"`).toBeGreaterThan(0);

    // And WHY it ended. A take the operator did not stop themselves is the case
    // where the reason is the whole question, and the toast is long gone by the
    // time they look at it.
    const reason = page.getByTestId('unsaved-take-reason');
    await expect(reason).toContainText('It ended on its own');
    await expect(
      reason,
      "the banner gave the orchestrator's generic note instead of the recorder's own account",
    ).toContainText('recorder restarted while the capture was');

    // ---- SECONDARY: the sidecar truth behind what was shown -----------------
    const capture = await api.getCapture(captureId);
    expect(capture.state).toBe('interrupted');

    // §3: the manifest is authoritative. The recorder re-measured the bytes it
    // had actually written at startup; the API must be carrying that number and
    // not the live session's stale one.
    const manifest = store.manifest(captureId);
    expect(manifest.state).toBe('interrupted');
    expect(manifest.bytes ?? 0, 'the recovered manifest recorded no bytes').toBeGreaterThan(0);
    expect(capture.bytes, "the API's byte count is not the manifest's").toBe(manifest.bytes);

    // The recorder's own account of the ending survived the orchestrator's
    // reconciliation, rather than being overwritten by the status-poll path's
    // "No active recorder session found."
    expect(capture.error?.message ?? '', 'the capture carries no reason for its ending').toContain(
      'recorder restarted while the capture was',
    );
    expect(capture.error?.code).toBe('recorder_failed');
  } finally {
    // A failure between the two must not leave the recorder down for whatever
    // runs next (nothing does today — but that is an ordering fact, not a
    // guarantee this spec is entitled to lean on).
    if (recorderDown) stack('start-recorder');
  }
});
