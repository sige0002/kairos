// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Multi-terminal recording control: two independent browser cookie jars.

import { expect, test } from "@playwright/test";
import { openTab } from "../fixtures/ui";

test("§13-11 Collect: a foreign browser must explicitly take control before normal Stop", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const other = await otherContext.newPage();
  try {
    await openTab(owner, "collect");
    await openTab(other, "collect");
    const started = await owner.evaluate(async () => {
      const response = await fetch("/api/v1/record/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topics: "all",
          operator: "e2e",
          task: "control",
        }),
      });
      return response.json();
    });
    const captureId = String(started.capture_id);
    expect(captureId).not.toBe("undefined");

    // Secondary API evidence: a second context has no owner cookie.
    const foreignStop = await other.evaluate(async (id) => {
      const response = await fetch("/api/v1/record/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capture_id: id }),
      });
      return { status: response.status, body: await response.json() };
    }, captureId);
    expect(foreignStop.status).toBe(409);
    expect(foreignStop.body.error.code).toBe("record_control_token_invalid");

    // Primary evidence: the second operator sees recovery controls, not an
    // ordinary Stop.  They explicitly take control through the Collect UI.
    await expect(other.getByTestId("phase-title")).toHaveText(
      /recording in progress/i,
    );
    const takeControl = other.getByRole("button", { name: "Take control" });
    await expect(takeControl).toBeVisible();
    await takeControl.click();
    await expect(
      other.getByRole("dialog", { name: "Recording control" }),
    ).toBeVisible();
    await other.getByRole("button", { name: "Take control" }).last().click();
    const stop = other.getByRole("button", { name: "Stop recording" });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect
      .poll(async () =>
        other.evaluate(async (id) => {
          const status = await (await fetch("/api/v1/record/status")).json();
          return (
            Array.isArray(status.live_capture_ids) &&
            status.live_capture_ids.includes(id)
          );
        }, captureId),
      )
      .toBe(false);
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});
