// Contract §6.1, E2E scenario 6 — the dataset's terminal transition.
//
//   build a dataset → Archive → archived badge → the destination holds the
//   views shape plus a manifest whose hashes measure true → the members are
//   gone from objects/ → delete kairos.db, restart → still archived, still
//   able to say where it went.
//
// The claim under test is the whole §6.1 chain seen from the operator's chair:
// the confirm dialog promises a path, the run copies and verifies, the seal is
// durable in the ledger — and because the record survives the database, the
// answer to "where did this dataset go?" survives everything short of the
// ledger itself. The disk reads are corroboration in the §13 sense: the UI
// says archived, and the folder + lifecycle.jsonl must agree in detail.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { api, recordCaptureViaApi, until } from '../fixtures/api';
import { stack } from '../fixtures/stack';
import { store } from '../fixtures/store';
import { openTab } from '../fixtures/ui';

const DATASET_NAME = 'e2e-archive-set';
const OPERATOR = 'e2e';
const TASK = 'archive';
// KAIROS_ARCHIVE_ROOTS in stack.env; the server appends <operator>/<task>/<name>.
const EXPECTED_DEST = `/archive/${OPERATOR}/${TASK}/${DATASET_NAME}`;

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

test('§6.1 Dataset archive: freeze → copy+verify out → seal, and the record survives a rebuild', async ({
  page,
}) => {
  // ---- arrange: two adopted recordings that belong to no dataset ----------
  // Recording is SETUP here (the Collect behaviour is §13-1's claim), so the
  // captures come from the API, like §13-5's bulk arrangement. They must be
  // adopted to enter a dataset (m10), and their digests must have settled so
  // the digest job's lease cannot collide with the run's preflight.
  const memberIds: string[] = [];
  for (const _ of [0, 1]) {
    const id = await recordCaptureViaApi({ operator: OPERATOR, task: TASK, seconds: 3 });
    await until(
      `capture ${id} to settle (terminal + digest complete = no lease in the way)`,
      () => api.getCapture(id),
      (c) => c.state === 'completed' && c.digest_state === 'complete',
      120_000,
    );
    await api.saveReview(id, {
      base_revision: (await api.getCapture(id)).review_revision,
      task_result: 'success',
      quality: 'good',
      review_status: 'adopted',
    });
    memberIds.push(id);
  }

  // ---- build the dataset through the UI -----------------------------------
  await openTab(page, 'datasets');
  await page.getByTestId('new-dataset-btn').click();
  await page.getByTestId('new-dataset-name').fill(DATASET_NAME);
  await page.getByTestId('new-dataset-operator').fill(OPERATOR);
  await page.getByTestId('new-dataset-task').fill(TASK);
  await page.getByTestId('new-dataset-submit').click();
  await expect(page.getByTestId('build-target')).toContainText(DATASET_NAME, {
    timeout: 30_000,
  });
  for (const id of memberIds) {
    await page.getByTestId(`dataset-add-${id}`).click();
  }
  await expect(page.getByTestId('build-target')).toContainText('2 members', {
    timeout: 30_000,
  });
  const datasetId = (await api.listDatasets()).items.find((d) => d.name === DATASET_NAME)!
    .dataset_id;

  // ---- the confirm dialog promises the exact final path -------------------
  await page.getByTestId('archive-dataset-btn').click();
  await expect(page.getByTestId('dataset-archive-dialog')).toBeVisible();
  // Both echoes: the destination that is sent, and where the dataset lands —
  // the server appends operator/task/name, and the dialog must not guess.
  await expect(page.getByTestId('dataset-archive-destination')).toHaveText('/archive');
  await expect(page.getByTestId('dataset-archive-final-path')).toHaveText(EXPECTED_DEST);
  await page.getByTestId('dataset-archive-confirm').click();

  // ---- PRIMARY: the UI reaches the terminal state -------------------------
  // The 202 started a server-side run; the badge is the operator's verdict.
  await expect(page.getByTestId(`dataset-status-${datasetId}`)).toHaveText('archived', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('dataset-archived-banner')).toContainText(EXPECTED_DEST);
  // The frozen dataset takes no more members, and says so where Add lived.
  await expect(page.getByTestId('build-target-frozen')).toBeVisible();

  // ---- corroborate: the destination vouches for itself --------------------
  const manifest = store.datasetManifest(EXPECTED_DEST);
  expect(manifest.status).toBe('complete');
  expect(manifest.dataset_id).toBe(datasetId);
  expect(manifest.members.map((m) => m.dir)).toEqual(['001', '002']);
  expect(manifest.totals.members).toBe(2);
  for (const member of manifest.members) {
    expect(memberIds).toContain(member.capture_id);
    expect(member.files, `member ${member.dir} sealed with no file list`).not.toBeNull();
    expect(member.capture_archived_event_id).not.toBeNull();
  }
  // The hashes measure true on the actual bytes at the destination — one file
  // per member is enough to prove the manifest describes THESE bytes.
  for (const member of manifest.members) {
    const file = member.files![0];
    const onDisk = join(store.hostArchivePath(EXPECTED_DEST), member.dir, file.path);
    expect(sha256(onDisk), `${member.dir}/${file.path} does not match its manifest hash`).toBe(
      file.sha256,
    );
  }

  // ---- corroborate: the ledger tells the whole run ------------------------
  const events = store.ledger();
  const started = events.filter(
    (e) => e.kind === 'dataset_archive_started' && e.dataset_id === datasetId,
  );
  const seals = events.filter(
    (e) => e.kind === 'dataset_archived' && e.dataset_id === datasetId,
  );
  expect(started, 'exactly one frozen start').toHaveLength(1);
  expect(seals, 'exactly one seal').toHaveLength(1);
  // The seal's hash is the manifest that is actually on disk — the one-way
  // dependency that lets the ledger alone catch a manifest edited afterwards.
  expect(seals[0].manifest_sha256).toBe(
    createHash('sha256').update(store.datasetManifestBytes(EXPECTED_DEST)).digest('hex'),
  );
  for (const id of memberIds) {
    const archived = store.ledgerFor(id, 'capture_archived');
    expect(archived, `no capture_archived event for member ${id}`).toHaveLength(1);
    expect(archived[0].dataset_id).toBe(datasetId);
    // The member's bytes left objects/ through the verified-copy path.
    expect(store.captureExists(id), `objects/${id} still present after its archive`).toBe(
      false,
    );
  }

  // ---- destroy the index: the record survives -----------------------------
  stack('stop');
  stack('rm-db');
  expect(store.dbExists(), 'kairos.db was not actually deleted').toBe(false);
  stack('start');
  await expect
    .poll(async () => (await api.storeHealth()).rebuilt_at, {
      message: 'the orchestrator never reported a rebuild after kairos.db was deleted',
      timeout: 120_000,
      intervals: [1_000],
    })
    .not.toBeNull();

  // The archived dataset is back — status, destination and members replayed
  // from the ledger alone (§6.1: a dataset has no sidecar of its own).
  await openTab(page, 'datasets');
  const row = page.getByTestId(`dataset-row-${datasetId}`);
  await expect(row, 'the archived dataset did not come back after the rebuild').toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId(`dataset-status-${datasetId}`)).toHaveText('archived');
  await row.click();
  await expect(page.getByTestId('dataset-archived-banner')).toContainText(EXPECTED_DEST, {
    timeout: 30_000,
  });

  // And the archive itself was never touched by any of that.
  expect(existsSync(join(store.hostArchivePath(EXPECTED_DEST), 'dataset_manifest.json'))).toBe(
    true,
  );
});
