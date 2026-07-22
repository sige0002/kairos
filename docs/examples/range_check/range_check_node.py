"""Second dora_live extension (self-authored): a numeric range-check detector.

This is a dora node in a dataflow of MY OWN (see dataflow.yml), run under its
own ``dora run`` with the dora CLI bundled in the dora_live image — fully
outside the kairos-managed dataflow, and WITHOUT modifying any kairos file.

It exercises the *numeric* extension seam the spec claims:

  1. poll the PUBLIC probe contract  GET :8006/fields  +  GET :8006/sample
     for a numeric field of a bridged topic,
  2. apply a trivial rule (value outside [LO, HI] -> event),
  3. POST the verdict to the analysis-event ring  :8005/internal/analysis/events,
  4. (read back via GET :8005/live/events -- done from the shell for clarity).

Only the public :8006 probe API and the :8005 control API are used; the
internal :8005/internal/probe/* surface is NOT touched.

Env (all optional):
  PROBE_URL      probe-compat base   (default http://127.0.0.1:8006)
  DORA_LIVE_URL  control base        (default http://127.0.0.1:8005)
  TOPIC          numeric topic to watch
                 (default /left_arm_controller/joint_states)
  FIELD          explicit field; empty = auto-pick first numeric field
  LO, HI         inclusive allowed range (default 0.0 .. 0.001 so any real
                 joint value fires -- a deliberately trivial rule)
"""

from __future__ import annotations

import json
import os
import sys
import time

import httpx
from dora import Node


def log(*parts: object) -> None:
    print("[range_check]", *parts, file=sys.stderr, flush=True)


def pick_field(client: httpx.Client, probe: str, topic: str) -> str | None:
    """Ask the PUBLIC probe /fields what numeric fields this topic exposes."""
    r = client.get(f"{probe}/fields", params={"topic": topic})
    if r.status_code != 200:
        log("/fields http", r.status_code)
        return None
    body = r.json()
    fields = body.get("fields") or []
    if not fields:
        log("no fields yet:", body.get("reason"))
        return None
    # Prefer an indexed scalar (e.g. position.0) -- probe samples scalars.
    for f in fields:
        if f.endswith(".0") or f[-1:].isdigit():
            return f
    return fields[0]


def main() -> int:
    probe = os.environ.get("PROBE_URL", "http://127.0.0.1:8006").rstrip("/")
    control = os.environ.get("DORA_LIVE_URL", "http://127.0.0.1:8005").rstrip("/")
    topic = os.environ.get("TOPIC", "/left_arm_controller/joint_states")
    field = os.environ.get("FIELD", "")
    lo = float(os.environ.get("LO", "0.0"))
    hi = float(os.environ.get("HI", "0.001"))
    client = httpx.Client(timeout=6.0)

    node = Node()
    log(f"up; probe={probe} control={control} topic={topic} range=[{lo},{hi}]")
    posted = 0
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            break
        if ev["type"] != "INPUT" or ev["id"] != "tick":
            continue

        try:
            if not field:
                picked = pick_field(client, probe, topic)
                if not picked:
                    continue
                field = picked
                log("auto-selected field:", field)

            r = client.get(
                f"{probe}/sample", params={"topic": topic, "field": field}
            )
            if r.status_code != 200:
                log("/sample http", r.status_code)
                continue
            s = r.json()
            value = s.get("value")
            if value is None:
                log("no live value yet (topic silent?) for", topic, field)
                continue

            in_range = lo <= float(value) <= hi
            log(f"sample {topic}.{field} = {value:.4f} in_range={in_range}")
            if in_range:
                continue

            event = {
                "t": time.time(),
                "detector": "ext_test/range_check",
                "topic": topic,
                "field": field,
                "value": float(value),
                "lo": lo,
                "hi": hi,
                "verdict": "out_of_range",
                "severity": "warn",
            }
            pr = client.post(f"{control}/internal/analysis/events", json=event)
            if pr.status_code == 200:
                posted += 1
                log(f"POSTED event #{posted}:", json.dumps(event))
            else:
                log("POST failed", pr.status_code, pr.text[:120])
        except Exception as exc:  # noqa: BLE001 - dora_live may be restarting
            log("loop error:", exc)
            continue

    log("STOP; events posted:", posted)
    return 0


if __name__ == "__main__":
    sys.exit(main())
