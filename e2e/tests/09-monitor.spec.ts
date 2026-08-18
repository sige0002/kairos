// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Monitor — the screen whose failure mode is "nothing shows up".
//
//   a bag is on the graph → Monitor › Topics → every configured topic carries a
//   real measured rate, and a topic the monitor was never asked to watch says
//   so instead of showing a zero.
//
// The Monitor tab had no acceptance evidence (see the table in README.md), and
// it is the screen where the absence hurts most: an empty topics table is what
// a broken DDS domain, a mismatched robot config, a dead SSE stream and a
// healthy-but-idle robot ALL look like. Its unit suites cannot tell those
// apart, because every one of them starts by handing the component the metrics
// snapshot whose arrival is the thing in doubt.
//
// Two claims, and the second is the one that keeps the first honest:
//
//   1. The configured topics show measured rates. This is the "何も出ない"
//      acceptance — the whole path from the replayed bag through the monitor's
//      subscriptions, the orchestrator's SSE stream and into the table.
//
//   2. A discovered topic OUTSIDE the allowlist shows no rate. topic_monitor
//      subscribes to `default_topics` alone (RosTopicSubscriber), while
//      discovery lists the entire graph, so most rows in this table are
//      legitimately unmeasured — and a screen that filled them with 0.0 Hz
//      would be reporting silence for topics nobody is listening to. That is
//      the honesty rule this table lives under, and it is invisible to a test
//      that only checks that numbers appear somewhere.

import { expect, test } from '@playwright/test';
import { api } from '../fixtures/api';
import { openMonitorTopics, topicRow, topicRowCells } from '../fixtures/ui';

/** A measured rate as the table prints it: `hz.toFixed(1)`. */
const RATE = /^\d+(\.\d+)?$/;
/** A measured size as `formatBandwidth` prints it. */
const BANDWIDTH = /^\d+(\.\d+)? ?(bps|kbps|Mbps)$/;
/** The status vocabulary a MEASURED row can show (TopicsTable's STATUS_LABEL).
 *  `—` is the unmeasured spelling and is deliberately not in this set. */
const LIVE_STATUS = ['OK', 'CHECK', 'DANGER', 'SILENT'];

test.describe.configure({ mode: 'serial' });

test('Monitor: the configured topics show live rates, and an unwatched one shows none', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);

  // ---- what the stack is configured to watch, and what is on the graph -----
  const config = await api.runtimeConfig();
  const configured = config.defaults.default_topics ?? [];
  expect(configured.length, 'the active robot config declares no default_topics').toBeGreaterThan(
    0,
  );
  // The allowlist is matched with globs upstream (features/record/topics
  // `matchesTopic`). The bundled sample config declares concrete names, so
  // plain set membership is the same answer here — and asserting that keeps a
  // future glob from silently making the "unwatched" pick below wrong.
  expect(
    configured.filter((t) => t.includes('*')),
    'a default_topics entry is a glob — the set arithmetic below needs the UI matcher mirrored',
  ).toEqual([]);

  const discovered = (await api.topics()).topics.map((t) => t.name).sort();
  expect(discovered.length, 'nothing is publishing — is the replay running?').toBeGreaterThan(0);

  const watched = configured.filter((t) => discovered.includes(t));
  expect(
    watched.length,
    `none of the configured topics ${JSON.stringify(configured)} are on the graph — ` +
      'the replayed bag and the robot config disagree',
  ).toBeGreaterThan(0);

  // Any discovered topic outside the allowlist would demonstrate the claim, but
  // prefer one from a namespace the watched set also uses: those come off the
  // replayed bag, so they are exactly as stable on the graph as the rows this
  // compares them against. The harness's own `/clock` would work too and reads
  // worse — the case worth pinning is a real robot topic nobody was asked to
  // watch (the sample config leaves /hsrb/base_scan out), not a test artefact.
  const unwatched = discovered.filter((t) => !configured.includes(t));
  expect(
    unwatched.length,
    'every discovered topic is configured — nothing here can demonstrate the unmeasured case',
  ).toBeGreaterThan(0);
  const namespaceOf = (t: string): string => t.split('/')[1] ?? '';
  const watchedNamespaces = new Set(watched.map(namespaceOf));
  const unwatchedTopic =
    unwatched.find((t) => watchedNamespaces.has(namespaceOf(t))) ?? unwatched[0]!;

  // ---- PRIMARY: the table is populated, with real numbers -----------------
  await openMonitorTopics(page);

  for (const topic of [...watched, unwatchedTopic]) {
    await expect(topicRow(page, topic), `${topic} is on the graph but not in the table`).toHaveCount(
      1,
      { timeout: 60_000 },
    );
  }

  // Metrics arrive over SSE, so the first paint is legitimately rate-less. Wait
  // for the whole configured set rather than for one lucky row: "some number
  // appeared" is exactly the weak reading that lets a half-subscribed monitor
  // pass.
  await expect
    .poll(
      async () => {
        const pending: string[] = [];
        for (const topic of watched) {
          const { hz } = await topicRowCells(page, topic);
          if (!RATE.test(hz)) pending.push(`${topic}=${hz || '(empty)'}`);
        }
        return pending.join(', ');
      },
      {
        message: 'configured topics never showed a measured rate',
        timeout: 3 * 60_000,
        intervals: [1_000],
      },
    )
    .toBe('');

  for (const topic of watched) {
    const cells = await topicRowCells(page, topic);
    expect(Number(cells.hz), `${topic} is being measured at 0 Hz`).toBeGreaterThan(0);
    expect(cells.bandwidth, `${topic} has a rate but no bandwidth`).toMatch(BANDWIDTH);
    // Which verdict is right depends on how the bag replays against the
    // configured expected_hz, so the assertion is that the row HAS a live
    // verdict — not which one. `—` here would mean the row is being rendered as
    // unmeasured while showing a rate.
    expect(LIVE_STATUS, `${topic} shows no live status (${cells.status})`).toContain(cells.status);
  }

  // ---- PRIMARY: what is NOT watched says nothing, rather than zero --------
  const idle = await topicRowCells(page, unwatchedTopic);
  expect(
    idle.hz,
    `${unwatchedTopic} is outside default_topics but the table printed a rate for it`,
  ).toBe('—');
  expect(idle.bandwidth).toBe('—');
  expect(idle.gap).toBe('—');
  expect(
    idle.status,
    `${unwatchedTopic} was given a health verdict without being measured`,
  ).toBe('—');
  // The Expected column is deliberately NOT asserted: it is read from the
  // config's expected_hz patterns, not from a measurement, and a topic can
  // legitimately carry a configured rate while sitting outside the allowlist
  // (the sample config does exactly that for /hsrb/base_scan).

  // ---- SECONDARY: the table is fed by discovery, not only by metrics ------
  // If it listed only what the monitor measures, the unmeasured case above
  // could never arise on a real robot — the operator would simply never see the
  // topics nobody is watching, which is the failure this screen exists to
  // prevent. So the table must carry more rows than the allowlist has entries.
  const listed = await page.locator('[data-testid^="topic-row-"]').count();
  expect(
    listed,
    'the table lists no more than the configured topics — it is rendering metrics, not the graph',
  ).toBeGreaterThan(watched.length);
});
