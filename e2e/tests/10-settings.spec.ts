// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings › Recording — the one screen that WRITES the config the rest of the
// stack runs on.
//
//   the screen shows the active recording config → an edit that is not valid
//   JSON is refused before it can be sent → the same config saved back comes
//   home unchanged.
//
// Settings had no acceptance evidence (see the table in README.md), and its
// exposure is asymmetric: every other screen reads. This one rewrites
// `config/<robot>/recording/default.yaml` through `PUT /api/v1/config/recording`
// — the file that decides which topics get recorded, whether the recorder
// pre-arms, and what the monitor measures. A save that mangled it would not
// fail here; it would fail on the next recording, as missing topics.
//
// So the scenario is deliberately a round trip to the SAME value. It proves the
// path works end to end (form → textarea → server → file → back onto the
// screen) while asserting the one property that matters to every other
// scenario: what the system reads afterwards is what it read before.
//
// ---- why this test cleans up after itself ----------------------------------
// The config tree is NOT the per-run data dir. compose mounts the repo's own
// `./config` read-write into the orchestrator, so a save here rewrites a
// TRACKED file in the working tree — shared with the developer's `make up`
// stack and with git. It is also not byte-stable: the writer re-serialises the
// whole validated model, so a field omitted from the file because its default
// was fine comes back written out. That is faithful in meaning and noisy in
// git. Hence: "unchanged" is asserted against what the system reads, and the
// original bytes are put back in a `finally` so an acceptance run leaves no
// diff behind.

import { expect, test } from "@playwright/test";
import { api } from "../fixtures/api";
import { repoConfig } from "../fixtures/config";
import {
  openRecordingJsonEditor,
  openRecordingSettings,
  openTab,
} from "../fixtures/ui";

test.describe.configure({ mode: "serial" });

test("Settings: setup check runs only on request and returns within five seconds", async ({
  page,
}) => {
  const setupRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/system/setup-check")) {
      setupRequests.push(request.method());
    }
  });

  await openTab(page, "settings");
  await expect(page.getByTestId("setup-check")).toBeVisible();
  await expect(page.getByTestId("setup-check-result")).toHaveCount(0);
  expect(
    setupRequests,
    "setup check ran merely because Settings opened",
  ).toEqual([]);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/system/setup-check") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("run-setup-check").click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  const report = (await response.json()) as {
    duration_ms: number;
    checks: { id: string }[];
  };
  expect(report.duration_ms).toBeLessThan(5_000);
  expect(report.checks.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "recording_config",
      "recorder",
      "topic_graph",
      "monitor_intake",
    ]),
  );

  const result = page.getByTestId("setup-check-result");
  await expect(result).toBeVisible();
  await expect(result).toContainText("Recorder preflight");
  await expect(result).toContainText("Configured topic coverage");
  expect(setupRequests).toEqual(["POST"]);
});

test("Settings: the recording config loads, a broken edit is refused, and a save changes nothing", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);

  // ---- the truth the screen has to be showing -----------------------------
  const before = await api.recordingConfig();
  expect(
    before.config,
    "no recording config is loaded — the screen has nothing to show",
  ).not.toBeNull();
  const cfg = before.config as Record<string, unknown>;
  const robotName = String(cfg.robot_name ?? "");
  const topics = (cfg.default_topics ?? []) as string[];
  expect(
    robotName.length,
    "the active recording config has no robot_name",
  ).toBeGreaterThan(0);
  expect(
    topics.length,
    "the active recording config has no default_topics",
  ).toBeGreaterThan(0);

  // The bytes as the working tree has them right now. Read BEFORE anything is
  // driven, so the restore below is to the developer's file, not to whatever an
  // earlier assertion left.
  const originalBytes = repoConfig.read(before.path);

  try {
    // ---- PRIMARY: the screen shows the real config, not a placeholder ------
    await openRecordingSettings(page);
    await expect(page.getByTestId("recording-robot")).toHaveText(robotName);
    await expect(page.getByTestId("recording-topic-count")).toHaveText(
      `${topics.length} topic${topics.length === 1 ? "" : "s"}`,
    );
    // Every configured topic is listed by name. A count with the wrong rows
    // behind it is the failure a count alone cannot catch.
    for (const topic of topics) {
      await expect(
        page.getByTestId(`recording-topic-${topic}`),
        `${topic} is configured but not listed`,
      ).toBeVisible();
    }

    // ---- PRIMARY: the raw editor is seeded from that same config ----------
    const editor = await openRecordingJsonEditor(page);
    const loaded = (await editor.inputValue()).trim();
    expect(
      JSON.parse(loaded),
      "the JSON in the editor is not the config the server reports",
    ).toEqual(cfg);
    await expect(page.getByText("Valid JSON", { exact: true })).toBeVisible();

    const advanced = page.getByTestId("recording-advanced");
    const save = advanced.getByRole("button", { name: "Save" });
    await expect(save).toBeEnabled();

    // ---- PRIMARY: a broken edit never reaches the server ------------------
    // The refusal has to be visible AND actionable: the operator is told what
    // is wrong, and Save is taken away rather than left to produce a 422 that
    // reads like a server fault.
    await editor.fill('{ "robot_name": ');
    await expect(page.getByText(/^Invalid JSON — /)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      save,
      "Save stayed live on a buffer that is not JSON",
    ).toBeDisabled();
    // Nothing was sent: the file and the live config are still the originals.
    expect((await api.recordingConfig()).config).toEqual(cfg);

    // ---- PRIMARY: put it back, and save it --------------------------------
    await editor.fill(loaded);
    await expect(page.getByText("Valid JSON", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(save).toBeEnabled();
    await save.click();

    await expect(
      advanced.getByText("Saved", { exact: true }),
      "the save never acknowledged",
    ).toBeVisible({ timeout: 60_000 });
    // The acknowledgement is honest about WHEN it applies — the recorder's QoS
    // and the monitor's rates are read at service startup, and a screen that
    // implied otherwise would have operators believing an edit had taken hold.
    await expect(advanced).toContainText(/apply after a service restart/i);

    // ---- the point of the whole round trip -------------------------------
    // Not "a save succeeded" but "the config every other scenario depends on is
    // the one it was". The editor is re-seeded from what the server actually
    // wrote, so the screen has to agree too.
    const after = await api.recordingConfig();
    expect(
      after.config,
      "saving the same config back changed what the server reads",
    ).toEqual(cfg);
    expect(after.path).toBe(before.path);
    expect(JSON.parse((await editor.inputValue()).trim())).toEqual(cfg);
  } finally {
    // Housekeeping, not an assertion: put the tracked file back exactly as it
    // was found. The written file is semantically identical (asserted above)
    // but not byte-identical, and an acceptance run must not leave a diff in
    // somebody's working tree. The live config in memory is the value that was
    // just proven equal, so nothing downstream changes.
    if (repoConfig.read(before.path) !== originalBytes) {
      repoConfig.write(before.path, originalBytes);
    }
  }

  expect(
    repoConfig.read(before.path),
    "the acceptance run left the tracked recording config rewritten",
  ).toBe(originalBytes);
});
