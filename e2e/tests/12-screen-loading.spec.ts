// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from '@playwright/test';

test('Screen chunks load on demand, and a failed load preserves navigation and recovery', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/?tab=collect');
  await expect(page.locator('#panel-collect h1')).toBeAttached();
  expect(
    requests.some((url) =>
      /\/assets\/(Monitor|Settings|Review|Datasets|Validation)Screen-.*\.js/.test(url),
    ),
  ).toBe(false);

  const chunk = '**/assets/MonitorScreen-*.js';
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(chunk, async (route) => {
    await held;
    await route.abort();
  });
  try {
    await page.locator('#tab-monitor').click();
    await expect(page.getByTestId('screen-loading')).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByTestId('panel-error')).toBeVisible();
  await page.locator('#tab-collect').click();
  await expect(page.locator('#panel-collect h1')).toBeAttached();
  await page.locator('#tab-monitor').click();
  await expect(page.getByTestId('panel-error')).toBeVisible();
  await page.unroute(chunk);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('mon-nav-Topics')).toBeVisible();
  await expect(page.getByTestId('panel-error')).toHaveCount(0);
});
