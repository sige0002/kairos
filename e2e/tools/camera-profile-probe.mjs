// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Real-stack regression: changing one window must not stop another's preview.
// Requires a freshly built frontend + streamer and a looping camera bag.
// KAIROS_CAMERA_UI defaults to the isolated E2E UI. No explicit recording/store
// actions; Collect's normal background pre-arm may still create an armed session.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const errors = [];
const stops = [];
async function state(video) {
  return video.evaluate((v) => ({
    id: v.srcObject?.id,
    width: v.videoWidth,
    height: v.videoHeight,
    frames: v.getVideoPlaybackQuality().totalVideoFrames,
  }));
}
async function until(fn, message) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/stream/stop')) stops.push(request.url());
    });
    await page.goto(`${process.env.KAIROS_CAMERA_UI || 'http://127.0.0.1:28080'}/?tab=collect`);
    const video = page.getByTestId('main-camera-video');
    await video.waitFor({ state: 'attached' });
    await until(async () => (await state(video)).frames > 10, `window ${i} has no live video`);
    pages.push(page);
  }
  const first = pages[0].getByTestId('main-camera-video');
  const second = pages[1].getByTestId('main-camera-video');
  const untouched = await state(second);
  const changes = [];
  for (const resolution of ['240p', '360p', '480p']) {
    const previous = await state(first);
    await pages[0].getByTestId('main-res-group').getByRole('radio', { name: resolution, exact: true }).click();
    await until(async () => {
      const current = await state(first);
      return current.id && current.id !== previous.id && current.height > 0
        && current.height <= Number.parseInt(resolution) && current.frames > 10;
    }, `new ${resolution} profile did not deliver video`);
    const otherBefore = await state(second);
    await until(async () => (await state(second)).frames > otherBefore.frames + 20,
      'the other window stopped receiving frames');
    const otherAfter = await state(second);
    assert.equal(otherAfter.id, untouched.id, 'the other window reconnected');
    assert.equal(otherAfter.width, untouched.width, 'the other window changed width');
    assert.equal(otherAfter.height, untouched.height, 'the other window changed height');
    changes.push({ resolution, changed: await state(first), unchanged: otherAfter });
  }
  assert.deepEqual(stops, [], 'the UI stopped a shared stream');
  assert.deepEqual(errors, [], 'browser or HTTP errors');
  console.log(JSON.stringify({ passed: true, changes, errors, stops }, null, 2));
} finally {
  await browser.close();
}
