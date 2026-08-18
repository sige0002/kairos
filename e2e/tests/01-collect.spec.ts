// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Contract §13, scenario 1 — Collect.
//
//   record → stop → the capture appears in the UI → digest_state pending →
//   complete.
//
// The whole recording is driven through the Collect screen against the real
// recorder, with a real rosbag replayed onto the stack's ROS domain. Nothing is
// stubbed: if the recorder cannot subscribe, or the bag is not reaching the
// graph, this test fails — which is the point of an acceptance gate that sits
// above the unit suites.

import { expect, test } from '@playwright/test';
import { api, until } from '../fixtures/api';
import { store } from '../fixtures/store';
import {
  E2E_OPERATOR,
  availabilityKind,
  listedCaptureIds,
  openTab,
  recordThroughUi,
  reviewRow,
  summarise,
} from '../fixtures/ui';

/** Availability kinds a healthy capture may legitimately pass through.
 *  `missing`/`corrupt`/`unknown` appearing here would be a real defect, not a
 *  timing artefact, so the walk asserts membership rather than only the end. */
const HEALTHY_KINDS = new Set(['verifying', 'present', 'verified']);

test.describe.configure({ mode: 'serial' });

test('§13-1 Collect: a recording made in the UI appears in the UI and its digest completes', async ({
  page,
}, testInfo) => {
  // ---- the operator records ------------------------------------------------
  const captureId = await recordThroughUi(page, { seconds: 5 });

  // ---- PRIMARY: the capture is on screen -----------------------------------
  // Review is where a finished recording surfaces; a capture the operator
  // cannot see is not collected, whatever the database says.
  await openTab(page, 'review');
  await expect(reviewRow(page, captureId)).toBeVisible({ timeout: 60_000 });
  expect(await listedCaptureIds(page)).toContain(captureId);

  // ---- PRIMARY: digest pending -> complete, as the operator sees it --------
  // The availability chip IS the digest's user-visible face: `verifying` while
  // digest_state is pending, `verified` once the per-file hashes are in the
  // manifest. The Review list does not poll, so each look is a fresh read.
  const walk: string[] = [];
  const note = (kind: string | null) => {
    if (kind && walk[walk.length - 1] !== kind) walk.push(kind);
  };
  note(await availabilityKind(page, captureId));

  await expect
    .poll(
      async () => {
        await page.reload();
        await expect(reviewRow(page, captureId)).toBeVisible({ timeout: 30_000 });
        const kind = await availabilityKind(page, captureId);
        note(kind);
        return kind;
      },
      {
        message: `availability never reached "verified" (saw: ${walk.join(' -> ')})`,
        timeout: 120_000,
        intervals: [1_000],
      },
    )
    .toBe('verified');

  // The chip must also read as the words an operator acts on, not just an
  // attribute a test can see.
  await expect(page.getByTestId(`review-availability-${captureId}`)).toHaveText(/verified/i);

  for (const kind of walk) {
    expect(HEALTHY_KINDS, `availability showed an unhealthy kind: ${kind}`).toContain(kind);
  }
  // Whether the short pending window was still open when the UI first looked is
  // a race with a sub-second digest, so it is REPORTED rather than asserted —
  // and the sidecar assertions below prove a digest actually ran either way.
  const digestWalk =
    walk.join(' -> ') +
    (walk.includes('verifying')
      ? '  (the pending phase was visible in the UI)'
      : '  (the digest completed before the first look; end state and sidecars asserted)');
  testInfo.annotations.push({ type: 'digest walk', description: digestWalk });
  // Also on stdout: a CI log that does not say whether the pending phase was
  // seen leaves the reader guessing which half of the claim was demonstrated.
  // eslint-disable-next-line no-console
  console.log(`  digest walk: ${digestWalk}`);

  // ---- SECONDARY: the sidecar truth behind what was shown ------------------
  const capture = await api.getCapture(captureId);
  expect(capture.state, summarise(capture)).toBe('completed');
  expect(capture.digest_state).toBe('complete');
  expect(capture.replica?.state).toBe('present_verified');
  expect(capture.message_count ?? 0).toBeGreaterThan(0);
  expect(capture.bytes ?? 0).toBeGreaterThan(0);

  const manifest = store.manifest(captureId);
  expect(manifest.schema_version).toBe(2);
  expect(manifest.capture_id).toBe(captureId);
  expect(manifest.state).toBe('completed');
  expect(manifest.digest_state).toBe('complete');
  expect(manifest.manifest_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(manifest.files, 'digest complete with no per-file hashes').not.toBeNull();
  expect(manifest.files!.length).toBeGreaterThan(0);
  for (const f of manifest.files!) {
    expect(f.sha256, `${f.path} has no sha256`).toMatch(/^[0-9a-f]{64}$/);
    expect(f.size).toBeGreaterThan(0);
  }
  // §3: the bag itself is under objects/<capture_id>/, keyed by nothing else.
  expect(manifest.files!.some((f) => f.path.endsWith('.mcap'))).toBe(true);

  // §11: the digest is written once, after the recorder has finished — the
  // manifest the orchestrator produced must still describe the same run.
  expect(manifest.run_id).toBe(capture.run_id);

  // Collection provenance is fixed at actual Start, before the review below.
  // The API row and the recorder-owned manifest must expose the same snapshot;
  // otherwise a reload or later Batch edit could silently relabel this take.
  expect(manifest.collection_context).not.toBeNull();
  expect(capture.collection_context).toEqual(manifest.collection_context);
  expect(manifest.collection_context?.batch_id).toBeTruthy();
  expect(manifest.collection_context?.batch_id).toBe(capture.batch_id);
  expect(manifest.collection_context?.batch_seq).toBeGreaterThan(0);
  expect(manifest.collection_context?.operator).toBe(E2E_OPERATOR);
  expect(manifest.collection_context?.robot).toBeTruthy();

  // The Collect screen's Save is the capture's FIRST review write (§4.1), so
  // record.json exists at revision 1 with no second write behind it.
  await until(
    'record.json to exist after the Collect save',
    async () => store.record(captureId),
    (r) => r !== null,
    30_000,
  );
  const record = store.record(captureId)!;
  expect(record.schema_version).toBe(2);
  expect(record.capture_id).toBe(captureId);
  expect(record.revision).toBe(1);
  expect(record.batch_id).toBe(manifest.collection_context?.batch_id);
  expect(record.index_in_batch).toBeGreaterThan(0);
});
