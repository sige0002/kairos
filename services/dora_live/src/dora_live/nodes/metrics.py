"""Metrics dataflow node: bus taps -> feed batches for the control sidecar.

Receives every bridge output (fan-in over all topics), converts the metadata
to feed rows and POSTs them to the control API in batches (on the 1 Hz tick or
when the batch grows past ``FLUSH_MAX_ROWS``). Payload bytes are never
serialized here — only the tiny attribution metadata travels over HTTP.

Delivery is lossy-tolerant by design: on POST failure the batch is dropped and
the failure logged once per streak; the monitor surfaces staleness through its
own ``snapshot_age`` signal.
"""

from __future__ import annotations

import os
import sys

from dora_live.metrics_feed import FLUSH_MAX_ROWS, row_from_meta


def log(*parts: object) -> None:
    print("[metrics]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    import httpx
    from dora import Node

    control_url = os.environ.get("CONTROL_URL", "http://127.0.0.1:9601")
    endpoint = f"{control_url.rstrip('/')}/internal/samples"
    client = httpx.Client(timeout=2.0)

    node = Node()
    batch: list[dict] = []
    post_failing = False

    def flush() -> None:
        nonlocal post_failing
        if not batch:
            return
        try:
            client.post(endpoint, json={"rows": batch})
            if post_failing:
                log("feed POST recovered")
                post_failing = False
        except Exception as exc:
            if not post_failing:
                log("feed POST failed (dropping batches until recovery):", exc)
                post_failing = True
        finally:
            batch.clear()

    log("up, feeding", endpoint)
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            flush()
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            flush()
            log("STOP")
            break
        if ev["type"] == "INPUT":
            if ev["id"] == "tick":
                flush()
                continue
            row = row_from_meta(ev.get("metadata") or {})
            if row is not None:
                batch.append(row)
                if len(batch) >= FLUSH_MAX_ROWS:
                    flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
