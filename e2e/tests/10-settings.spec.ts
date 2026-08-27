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
  elapsedSeconds,
  ensureOperator,
  openRecordingJsonEditor,
  openRecordingSettings,
  openTab,
  phaseTitle,
} from "../fixtures/ui";

test.describe.configure({ mode: "serial" });

test("Settings: appearance follows System and persists explicit Dark locally", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openTab(page, "settings");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();

  const section = page.getByTestId("settings-appearance");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("appearance-system")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(section).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await section.getByTestId("appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(section).toHaveCSS("background-color", "rgb(30, 41, 59)");
  await expect(section.getByTestId("appearance-status")).toContainText(
    "Using dark appearance",
  );
  expect(await page.evaluate(() => localStorage.getItem("kairos.appearance"))).toBe(
    "dark",
  );

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByTestId("appearance-dark")).toBeChecked();

  await page.getByTestId("appearance-system").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Appearance is a browser-local presentation preference: carrying a Collect
  // preference through Settings must not reset that frontend state.
  await openTab(page, "collect");
  const soundToggle = page.getByTestId("recording-sounds-toggle");
  const before = await soundToggle.getAttribute("aria-label");
  await openTab(page, "settings");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByTestId("appearance-light").click();
  await openTab(page, "collect");
  await expect(soundToggle).toHaveAttribute("aria-label", before ?? "");
});

test("Settings: changing appearance leaves an active Collect recording alone", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const recordRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/v1\/record\/(?:start|stop)$/.test(path)) recordRequests.push(path);
  });

  let recordingStarted = false;
  try {
    await openTab(page, "collect");
    await ensureOperator(page);
    const before = new Set((await api.allCaptures(true)).map((capture) => capture.capture_id));

    await expect(phaseTitle(page)).toHaveText("READY", { timeout: 90_000 });
    await page.getByRole("button", { name: /Start recording/ }).click();
    recordingStarted = true;
    await expect(phaseTitle(page)).toHaveText("RECORDING", { timeout: 120_000 });
    await expect.poll(() => elapsedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    const live = (await api.allCaptures(true)).filter((capture) => !before.has(capture.capture_id));
    expect(live, "starting Collect did not create one live capture").toHaveLength(1);
    const captureId = live[0].capture_id;
    const commandsBeforeAppearance = [...recordRequests];

    // Use the shell tabs, not `page.goto`: this is the in-app journey an
    // operator takes while a take is live, so its local machine must survive.
    await page.locator("#tab-settings").click();
    await expect(page.locator("#tab-settings")).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByTestId("appearance-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("appearance-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(recordRequests, "appearance sent a recorder command").toEqual(commandsBeforeAppearance);

    await page.locator("#tab-collect").click();
    await expect(page.locator("#tab-collect")).toHaveAttribute("aria-selected", "true");
    await expect(phaseTitle(page)).toHaveText("RECORDING");
    await expect.poll(() => elapsedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const afterAppearance = await api.allCaptures(true);
    expect(afterAppearance.map((capture) => capture.capture_id)).toContain(captureId);
    expect(recordRequests, "returning from Settings sent a recorder command").toEqual(commandsBeforeAppearance);

    await page.getByRole("button", { name: /Stop recording/ }).click();
    await expect(phaseTitle(page)).toHaveText(/result$/, { timeout: 180_000 });
    recordingStarted = false;
    await page.getByTestId("save-episode").click();
    await expect(phaseTitle(page)).not.toHaveText(/result$/, { timeout: 60_000 });
    expect(recordRequests.filter((path) => path.endsWith("/stop"))).toHaveLength(1);
  } finally {
    if (recordingStarted && (await page.getByRole("button", { name: /Stop recording/ }).count())) {
      await page.getByRole("button", { name: /Stop recording/ }).click();
    }
  }
});

test("Settings: changing language leaves an active Collect recording alone", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const recordRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/v1\/record\/(?:start|stop)$/.test(path)) recordRequests.push(path);
  });

  let recordingStarted = false;
  try {
    await openTab(page, "collect");
    await ensureOperator(page);
    const before = new Set((await api.allCaptures(true)).map((capture) => capture.capture_id));

    await expect(phaseTitle(page)).toHaveText("READY", { timeout: 90_000 });
    await page.getByRole("button", { name: /Start recording/ }).click();
    recordingStarted = true;
    await expect(phaseTitle(page)).toHaveText("RECORDING", { timeout: 120_000 });
    await expect.poll(() => elapsedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    const live = (await api.allCaptures(true)).filter((capture) => !before.has(capture.capture_id));
    expect(live, "starting Collect did not create one live capture").toHaveLength(1);
    const captureId = live[0].capture_id;
    const commandsBeforeLanguage = [...recordRequests];

    await page.locator("#tab-settings").click();
    await page.getByTestId("settings-menu-item-language").click();
    const language = page.getByTestId("settings-language");
    await expect(language).toBeVisible();
    await expect(language.getByTestId("language-en")).toBeChecked();
    await language.getByTestId("language-ja").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.locator("#tab-collect")).toHaveText("収録");
    expect(await page.evaluate(() => localStorage.getItem("kairos.locale"))).toBe("ja");
    expect(recordRequests, "language sent a recorder command").toEqual(commandsBeforeLanguage);

    // Tab IDs are semantic navigation identities, so the return path does not
    // depend on translated display text.
    await page.locator("#tab-collect").click();
    await expect(phaseTitle(page)).toHaveText("録画中");
    await expect.poll(() => elapsedSeconds(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    expect((await api.allCaptures(true)).map((capture) => capture.capture_id)).toContain(captureId);
    expect(recordRequests, "returning from Settings sent a recorder command").toEqual(
      commandsBeforeLanguage,
    );

    await page.getByRole("button", { name: "録画を停止" }).click();
    await expect(phaseTitle(page)).toHaveText(/結果$/, { timeout: 180_000 });
    recordingStarted = false;
    await page.getByTestId("save-episode").click();
    await expect(phaseTitle(page)).not.toHaveText(/結果$/, { timeout: 60_000 });
    expect(recordRequests.filter((path) => path.endsWith("/stop"))).toHaveLength(1);
  } finally {
    if (recordingStarted && (await page.getByRole("button", { name: "録画を停止" }).count())) {
      await page.getByRole("button", { name: "録画を停止" }).click();
    }
    await page.locator("#tab-settings").click();
    await page.getByTestId("settings-menu-item-language").click();
    await page.getByTestId("language-en").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  }
});

test("Settings: Audio is opt-in, independently configurable, and resettable", async ({
  page,
}) => {
  await openTab(page, "settings");
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  const section = page.getByTestId("settings-audio");
  await expect(section).toBeVisible();

  const master = section.getByRole("switch", { name: "Audio feedback" });
  const sound = section.getByRole("switch", { name: "Sound effects" });
  const voice = section.getByRole("switch", { name: "Voice / TTS" });
  await expect(master).not.toBeChecked();
  await expect(sound).toBeChecked();
  await expect(voice).toBeChecked();

  await master.click();
  await sound.click();
  await page.reload();
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await expect(section.getByRole("switch", { name: "Audio feedback" })).toBeChecked();
  await expect(section.getByRole("switch", { name: "Sound effects" })).not.toBeChecked();
  await expect(section.getByRole("switch", { name: "Voice / TTS" })).toBeChecked();

  await section.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(section.getByRole("switch", { name: "Audio feedback" })).not.toBeChecked();
});

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

test("Settings: external-control mapping reaches Collect's effective HUD", async ({
  page,
}) => {
  let original: Awaited<ReturnType<typeof api.plansCatalog>> | null = null;
  let changed = false;

  try {
    await openTab(page, "settings");
    await page.getByTestId("settings-section-external-controls").click();
    await expect(page.getByTestId("settings-ext-controls")).toBeVisible();
    // A never-set installation seeds all catalog halves on this first mount.
    // Snapshot only after that reconcile, so cleanup restores an actual saved
    // catalog rather than inventing an empty replacement for `projects: null`.
    await expect
      .poll(async () => (await api.plansCatalog()).external_controls)
      .not.toBeNull();
    original = await api.plansCatalog();

    // Moving Start is intentionally a two-step operation: duplicate actions
    // are disabled, so the old channel is cleared before the new one is set.
    await page.getByTestId("ext-control-ready-center").selectOption("none");
    await page.getByTestId("ext-control-ready-left").selectOption("start");
    changed = true;

    await expect(page.getByTestId("ext-control-ready-left")).toHaveValue(
      "start",
    );
    await expect(page.getByTestId("ext-control-ready-center")).toHaveValue(
      "none",
    );
    await expect
      .poll(async () => {
        const controls = (await api.plansCatalog()).external_controls as {
          ready?: { left?: string; center?: string };
        } | null;
        return [controls?.ready?.left, controls?.ready?.center];
      })
      .toEqual(["start", "none"]);

    // The Collect HUD consumes the same resolved mapping as the key handler.
    // READY therefore exposes Start on LEFT, not on the old CENTER channel.
    await openTab(page, "collect");
    await ensureOperator(page);
    await expect(page.getByTestId("phase-title")).toHaveText("READY");
    await expect(page.getByTestId("ext-action-left-meaning")).toHaveText(
      "Start",
    );
    await expect(page.getByTestId("ext-action-center-meaning")).toHaveText("—");
  } finally {
    if (changed && original !== null) {
      const latest = await api.plansCatalog();
      await api.replacePlansCatalog({
        base_revision: latest.revision,
        projects: original.projects ?? [],
        failure_reasons: original.failure_reasons,
        operators: original.operators,
        external_controls: original.external_controls,
      });
    }
  }
});
