"""importer sidecar — tiny HTTP trigger around import_runs.sh (stdlib only).

Runs on the RECORDING PC beside the orchestrator (compose.recording.yaml; it is
deliberately absent from the single-host compose.yaml, where the data is already
local). The orchestrator POSTs /pull {"run_id": ...} right after a Collect Save
when the recording config opts in (transfer.auto_pull_on_save, default false),
and this daemon rsyncs that capture's files from the robot into the PC-local
./data/objects — the same script, guarantees (finalised-only, idempotent,
resumable, BWLIMIT) and auth (ROBOT_SSH_KEY / ROBOT_SSH_PASSWORD) as the manual
`make import-runs`.

API (capture store v2 — keyed by capture_id, contract §10.6):
    POST /pull {"capture_id": "<uuid7>"} -> 202 {"queued": true} (one capture)
    POST /pull {"all": true}             -> 202 {"queued": true} (every capture)
    POST /pull {} / anything else        -> 400
    GET  /healthz                        -> 200 {"ok": true}

**The empty body is a 400, not a sweep.** It used to mean "pull everything",
which made the v1→v2 rename dangerous in a way no test would catch: a caller
still sending ``{"run_id": ...}`` would have had its key ignored and silently
triggered a full sweep of every capture on the robot — the opposite of a
targeted pull, and a lot of bandwidth off a robot that is supposed to be left
alone. Sweeping is now an explicit ``{"all": true}``, and an unrecognised body
is refused with a message naming the key it should have used.

Pulls are serialised by a single worker thread (two rsyncs of the same capture
would corrupt --append-verify resume state). A capture pull retries while the
recorder is still finalising it on the robot (import_runs.sh exit 3): a Save
lands seconds after stop, so the first attempt can race the finaliser.
Failures are logged and dropped — the periodic sweep (IMPORT_SWEEP_S > 0) and
the manual `make import-runs` are the catch-up paths.

Binds 127.0.0.1 by default: only the co-located orchestrator needs it, so the
trigger is not exposed on the LAN (the stack is otherwise no-auth by design).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s importer: %(message)s")
logger = logging.getLogger("importer")

BIND = os.environ.get("IMPORTER_BIND", "127.0.0.1")
PORT = int(os.environ.get("IMPORTER_PORT", "8030"))
# Sweep cadence in seconds; 0 (default) disables — nothing is pulled unless
# explicitly triggered. Enable as a catch-up for pulls that failed (robot
# offline at Save) or runs that never got a Save.
SWEEP_S = float(os.environ.get("IMPORT_SWEEP_S", "0"))
# A just-saved run can still be finalising on the robot (exit 3): retry budget.
FINALISE_RETRIES = int(os.environ.get("IMPORT_FINALISE_RETRIES", "10"))
FINALISE_RETRY_DELAY_S = float(os.environ.get("IMPORT_FINALISE_RETRY_DELAY_S", "3"))

SCRIPT = Path(__file__).resolve().parent / "import_runs.sh"

# capture_id must be a canonical UUIDv7 (contract §1). Re-implemented here
# rather than imported from kairos_common because this sidecar is deliberately
# stdlib-only (see the Dockerfile: no pip installs). The check is not cosmetic —
# the id is interpolated into a remote find(1) pattern and into local paths on
# both hosts, so anything that is not a bare UUIDv7 must never get that far.
_UUID7_RE = re.compile(
    r"\A[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)


class PullRequestError(ValueError):
    """A /pull body that cannot be honoured. The message goes to the client."""


def parse_pull_body(body: object) -> str | None:
    """Validate a ``/pull`` body. Returns the capture_id, or ``None`` for a sweep.

    Deliberately strict, because the failure mode of leniency here is expensive:
    a body this function does not understand used to fall through to "pull
    everything from the robot". Every branch below therefore ends in either a
    validated capture_id or an exception — there is no default.

    Raises :class:`PullRequestError` with a message intended for the operator.
    """
    if not isinstance(body, dict):
        raise PullRequestError("body must be a JSON object")

    if "run_id" in body:
        # The exact v1→v2 migration hazard, named explicitly: silently ignoring
        # this key is what would turn a targeted pull into a full sweep.
        raise PullRequestError(
            "run_id is not accepted; this API is keyed by capture_id "
            "(capture store v2, contract §10.6)"
        )

    unknown = set(body) - {"capture_id", "all"}
    if unknown:
        raise PullRequestError(f"unknown field(s): {sorted(unknown)}")

    capture_id = body.get("capture_id")
    sweep = body.get("all", False)
    if capture_id is not None and sweep:
        raise PullRequestError("give capture_id or all, not both")

    if capture_id is not None:
        if not isinstance(capture_id, str) or not _UUID7_RE.match(capture_id):
            raise PullRequestError("capture_id must be a UUIDv7 string")
        return capture_id

    if sweep is True:
        return None
    if sweep is not False:
        raise PullRequestError("all must be true or false")

    raise PullRequestError(
        'capture_id is required; send {"all": true} to pull every capture'
    )


_queue: queue.Queue[str | None] = queue.Queue()
_queued: set[str | None] = set()  # dedup guard for identical pending jobs
_queued_lock = threading.Lock()
_stop = threading.Event()


def _enqueue(capture_id: str | None) -> bool:
    """Queue a pull job unless an identical one is already pending."""
    with _queued_lock:
        if capture_id in _queued:
            return False
        _queued.add(capture_id)
    _queue.put(capture_id)
    return True


def _run_script(capture_id: str | None) -> int:
    """Run import_runs.sh once (QUIET; CAPTURE_ID when given); return its exit."""
    env = dict(os.environ, QUIET="1")
    if capture_id is not None:
        env["CAPTURE_ID"] = capture_id
    else:
        env.pop("CAPTURE_ID", None)
    proc = subprocess.run(  # noqa: S603 - fixed script path, env-driven args
        ["bash", str(SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=3600,
    )
    for line in (proc.stdout + proc.stderr).splitlines():
        if line.strip():
            logger.info("%s", line)
    return proc.returncode


def _worker() -> None:
    """Serialise pulls; retry a not-yet-finalised run (exit 3) briefly."""
    while not _stop.is_set():
        try:
            capture_id = _queue.get(timeout=1.0)
        except queue.Empty:
            continue
        with _queued_lock:
            _queued.discard(capture_id)
        label = capture_id or "<all finalised>"
        try:
            for attempt in range(FINALISE_RETRIES + 1):
                code = _run_script(capture_id)
                if code != 3 or capture_id is None:
                    break
                if attempt < FINALISE_RETRIES:
                    logger.info(
                        "%s not finalised yet, retry %d/%d in %.0fs",
                        label,
                        attempt + 1,
                        FINALISE_RETRIES,
                        FINALISE_RETRY_DELAY_S,
                    )
                    if _stop.wait(FINALISE_RETRY_DELAY_S):
                        return
            if code == 0:
                logger.info("pull ok: %s", label)
            else:
                logger.warning("pull failed (exit %d): %s", code, label)
        except Exception:  # noqa: BLE001 - the worker must never die
            logger.exception("pull crashed: %s", label)


def _sweeper() -> None:
    """Periodic full pull as a catch-up (only when IMPORT_SWEEP_S > 0)."""
    while not _stop.wait(SWEEP_S):
        _enqueue(None)


class Handler(BaseHTTPRequestHandler):
    """POST /pull + GET /healthz; everything else is 404."""

    def _reply(self, status: int, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path == "/healthz":
            self._reply(200, {"ok": True})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path != "/pull":
            self._reply(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._reply(400, {"error": "invalid JSON body"})
            return
        try:
            capture_id = parse_pull_body(body)
        except PullRequestError as exc:
            logger.warning("rejected pull request: %s", exc)
            self._reply(400, {"error": str(exc)})
            return
        queued = _enqueue(capture_id)
        logger.info(
            "pull request: %s (%s)",
            capture_id or "<all finalised>",
            "queued" if queued else "already pending",
        )
        self._reply(202, {"queued": True, "capture_id": capture_id})

    def log_message(self, fmt: str, *args: object) -> None:
        """Route the default access log through logging (quiet healthchecks)."""
        if "/healthz" not in str(args[0] if args else ""):
            logger.info(fmt, *args)


def main() -> None:
    if not os.environ.get("ROBOT_SSH"):
        logger.warning(
            "ROBOT_SSH is empty - pulls will fail until it is set "
            "(see .env.split.example). Serving anyway."
        )
    threading.Thread(target=_worker, daemon=True, name="pull-worker").start()
    if SWEEP_S > 0:
        threading.Thread(target=_sweeper, daemon=True, name="sweeper").start()
        logger.info("sweep enabled: every %.0fs", SWEEP_S)
    logger.info("listening on %s:%d (sweep=%s)", BIND, PORT, SWEEP_S or "off")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
