// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
import { expect, test } from '@playwright/test';
import { openMonitorTopics } from '../fixtures/ui';

test('Monitor topic search filters the table and extra charts', async ({ page }) => {
  await openMonitorTopics(page);
  const rows = page.locator('[data-testid^="topic-row-"]');
  await expect.poll(() => rows.count()).toBeGreaterThan(1);
  const topic = (await rows.first().getAttribute('data-testid'))!.slice('topic-row-'.length);
  const search = page.getByTestId('topics-search');
  await search.fill(`  ${topic.toUpperCase()}  `);
  await expect(page.getByTestId(`topic-row-${topic}`)).toBeVisible();
  await search.fill('no_such_topic_search_fixture');
  await expect(page.getByTestId('topics-table-no-results')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toBeFocused();
  await expect.poll(() => rows.count()).toBeGreaterThan(1);

  await page.getByTestId('add-chart').click();
  const chartSearch = page.getByTestId('freq-topic-search-1');
  const chartSelect = page.getByTestId('freq-add-topic-1');
  const chartTopic = await chartSelect.locator('option').nth(1).getAttribute('value');
  expect(chartTopic).toBeTruthy();
  await chartSearch.fill(` ${chartTopic!.toUpperCase()} `);
  await chartSelect.selectOption(chartTopic!);
  await expect(page.getByTestId(`freq-legend-1-${chartTopic}`)).toBeVisible();
  await chartSearch.fill('no_such_topic_search_fixture');
  await expect(chartSelect).toBeDisabled();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByTestId(`freq-legend-1-${chartTopic}`)).toBeVisible();
});
