// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Validation — the screen that answers "is this recording usable?"
//
//   pick fast_validation → point it at a recording → Run → the required-topic
//   checklist comes back with a verdict beside every topic the template asked
//   for, and the report on disk says the same thing.
//
// This screen had no acceptance evidence at all until now (see the table in
// README.md): its unit suites cover `buildChecklist` and the job-polling hook,
// but nothing above them had ever shown that a job STARTED from the browser
// reaches a real dora coordinator, comes back, and renders. That gap matters
// more here than elsewhere, because `fast_validation` is the only pipeline with
// a bespoke result view — every other one lands in the generic SummaryResult,
// so a checklist that silently stopped rendering would take the screen's whole
// reason for existing with it and no other test would notice.
//
// The recording is SETUP, not the claim (§13-1 owns the Collect flow), so it is
// made through the API like §13-5's and §6.1's arrangements.

import { expect, test } from "@playwright/test";
import { api, recordCaptureViaApi, until } from "../fixtures/api";
import { store } from "../fixtures/store";
import { openTab } from "../fixtures/ui";

const PIPELINE = "fast_validation";

test.describe.configure({ mode: "serial" });

test("Validation: fast_validation runs from the screen and reports every required topic", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);

  // ---- what the template actually demands ---------------------------------
  // Read from the config catalog rather than hard-coded, so this asserts "the
  // checklist shows the ACTIVE template's required topics" — the property —
  // instead of "the checklist shows these five strings", which would be a copy
  // of config/airoa_hsr/validation/default.yaml that rots the day it is edited.
  const options = await api.configOptions();
  const validation = options.aspects.validation;
  const activeId = validation?.active ?? null;
  const template = (validation?.options ?? []).find((o) => o.id === activeId);
  expect(
    template,
    `no active validation template in the config catalog (active=${activeId}) — ` +
      "fast_validation would fall back to an empty required list and pass vacuously",
  ).toBeDefined();
  const required = template!.meta.required_topics ?? [];
  expect(
    required.length,
    "the active template declares no required topics",
  ).toBeGreaterThan(0);

  // ---- arrange: one healthy recording to validate --------------------------
  // Settled = terminal AND digest complete: a pipeline reads objects/<id>, and
  // starting one while the digest still holds its lease is a race this scenario
  // is not about.
  const captureId = await recordCaptureViaApi({
    operator: "e2e",
    task: "validation",
    seconds: 4,
  });
  await until(
    `capture ${captureId} to settle before validating it`,
    () => api.getCapture(captureId),
    (c) => c.state === "completed" && c.digest_state === "complete",
    180_000,
  );
  expect(
    store.reportSummary(PIPELINE, captureId),
    "this capture was already validated",
  ).toBeNull();

  // ---- the operator sets up the run ---------------------------------------
  await openTab(page, "validation");
  await page.getByTestId(`pipeline-card-${PIPELINE}`).click();
  await expect(page.getByTestId("detail-header")).toContainText(PIPELINE, {
    timeout: 30_000,
  });

  // The target select carries every capture whose bytes are readable HERE; the
  // one just recorded has to be among them, and choosing it explicitly is what
  // makes the verdict below attributable to a known recording.
  const target = page.getByLabel("target", { exact: true });
  await target.selectOption(captureId);
  await expect(target).toHaveValue(captureId);

  // The template param is seeded from the catalog's active selection, so the
  // screen must already be pointing at the template whose topics were read
  // above — otherwise the checklist would be measured against the wrong list.
  await expect(page.getByLabel("template", { exact: true })).toHaveValue(
    activeId!,
  );

  // A capture whose files are here must not be flagged as unreachable.
  await expect(page.getByTestId("target-availability")).toHaveAttribute(
    "data-availability",
    /verified|present/,
  );

  // ---- PRIMARY: run it, and get a verdict on screen ------------------------
  await page.getByRole("button", { name: "Run on selection" }).click();

  // The run is server-owned. Once its stable id reaches the URL, a browser
  // reload must reconnect to that same run instead of losing its job ids or
  // submitting a second run.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("vrun"), {
      message: "the durable validation run id never reached the URL",
      timeout: 30_000,
    })
    .toMatch(/^validation_run_/);
  const durableRunId = new URL(page.url()).searchParams.get("vrun");
  await page.reload();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("vrun"))
    .toBe(durableRunId);

  const checklist = page.getByTestId("fast-validation-checklist");
  const submitError = page.getByTestId("validation-submit-error");
  // Two ways this ends and they need different words. A refused Validation Run
  // (`pipeline_unavailable` when the image carries no dora, a deleted capture)
  // renders an error note and NO checklist — reporting that as "the checklist
  // never appeared" would send the reader looking at the wrong half.
  await expect
    .poll(
      async () => {
        if ((await submitError.count()) > 0) {
          return `the run was refused: ${(await submitError.textContent())?.trim()}`;
        }
        return (await checklist.count()) > 0 ? "checklist" : "still running";
      },
      {
        message: "fast_validation never produced a result on screen",
        timeout: 5 * 60_000,
        intervals: [1_000],
      },
    )
    .toBe("checklist");

  // Every topic the template demanded is named on screen, with the message type
  // it was declared with — an operator reading a FAIL has to be able to see
  // WHICH topic, not just that something was missing.
  for (const topic of required) {
    await expect(
      checklist,
      `the checklist does not mention ${topic.name}`,
    ).toContainText(topic.name);
    if (topic.type) await expect(checklist).toContainText(topic.type);
  }

  // The count line and the badge are the two things read at a glance, and they
  // have to agree with each other and with the rows.
  await expect(checklist).toContainText(
    `${required.length}/${required.length} required`,
  );
  await expect(checklist).toContainText("PASS");

  // The sample bag carries every required topic, so a ✕ here is a real defect
  // rather than a strict assertion: something the template demanded did not
  // reach the recording.
  const marks = (await checklist.textContent()) ?? "";
  expect(
    (marks.match(/✕/g) ?? []).length,
    "a required topic is marked missing — the replayed bag publishes all of them",
  ).toBe(0);
  expect((marks.match(/✓/g) ?? []).length).toBe(required.length);

  // ---- SECONDARY: the report on disk says the same thing -------------------
  // §10.5: report/<pipeline>/<capture_id>/. The screen renders the job result;
  // this is the artefact that outlives the browser, and a UI verdict with no
  // report behind it (or a report that disagrees) is the failure worth naming.
  const summary = await until(
    `${PIPELINE} to write its summary for ${captureId}`,
    async () => store.reportSummary(PIPELINE, captureId),
    (s) => s !== null,
    60_000,
  );
  expect(summary!.pipeline).toBe(PIPELINE);
  expect(
    summary!.result,
    `the report disagrees with the PASS on screen: ${summary!.message}`,
  ).toBe("pass");
  expect(summary!.capture_id).toBe(captureId);
  expect(summary!.missing).toEqual([]);
  // The verdict came from the bundled bagflow flow on dora, not from some
  // in-process fallback — which is the whole point of the pipeline moving there.
  expect(summary!.engine).toBe("bagflow");
  expect((summary!.template as { name?: string }).name).toBe(
    template!.meta.name,
  );
});
