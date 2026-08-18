"""importer sidecar — tiny HTTP trigger around import_runs.sh (stdlib only).

Runs on the RECORDING PC beside the orchestrator (compose/recording.yaml; it is
deliberately absent from the single-host compose/compose.yaml, where the data is already
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
    GET  /pull/<capture_id>              -> 200 {per-pull state} | 404
    GET  /pulls                          -> 200 {"pulls": {...}} (all known)
    GET  /healthz                        -> 200 {"ok": true}

Per-pull state (S3-1: a pull whose rsync died used to be invisible — the 202
lands before ssh is even touched, and the exit code went only to this
container's log): every queued pull is tracked through
``queued → running → ok | failed`` with its exit code and a one-line reason,
and the last outcome per capture stays readable. The orchestrator proxies
``GET /pull/<id>`` so the UI can stop saying "Transferring…" about a transfer
that is dead.

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
import signal
import subprocess
import threading
import time
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
_NOTHING_ACTIVE = object()  # sentinel: distinct from None (None = a sweep)
_active: object = _NOTHING_ACTIVE  # the job the worker is executing right now
_queued_lock = threading.Lock()
_stop = threading.Event()

# What each pull exit code means, for the record's one-line reason (the script
# header defines them).
_EXIT_REASON = {
    0: "ok",
    2: "configuration error (see the importer log)",
    3: "the capture is not finalised on the robot yet",
    4: "ssh to the robot failed (auth or network)",
}
_TIMEOUT_EXIT = 124  # our own marker for "the pull ran out of its time budget"

# Per-pull state, keyed by capture_id (None = a full sweep). The LAST outcome
# per key stays readable; a re-queue overwrites it. Never trimmed: entries are
# tiny and bounded by the number of captures ever pulled.
_pulls: dict[str | None, dict[str, object]] = {}
_pulls_lock = threading.Lock()


def _record_pull(capture_id: str | None, **fields: object) -> None:
    with _pulls_lock:
        entry = _pulls.setdefault(capture_id, {})
        entry.update(fields, updated_at=time.time())


def _pull_state(capture_id: str | None) -> dict[str, object] | None:
    with _pulls_lock:
        entry = _pulls.get(capture_id)
        return dict(entry) if entry is not None else None


def _enqueue(capture_id: str | None) -> bool:
    """Queue a pull job unless an identical one is pending OR running.

    Covering the RUNNING one matters: the dedup used to be released the moment
    the worker picked the job up, so a re-click during a long rsync queued a
    second ``--append-verify`` transfer of the same files right behind the
    first (S3-1) — the exact double-run the serial worker exists to prevent.
    """
    with _queued_lock:
        if capture_id in _queued or capture_id == _active:
            return False
        _queued.add(capture_id)
    _record_pull(capture_id, state="queued", exit_code=None, reason=None)
    _queue.put(capture_id)
    return True


def _run_script(capture_id: str | None) -> int:
    """Run import_runs.sh once (QUIET; CAPTURE_ID when given); return its exit.

    The script runs in its own process GROUP, and the timeout kills the group:
    killing only the bash wrapper left the rsync grandchild running, holding
    the transfer's resume state while a second attempt started next to it.
    """
    env = dict(os.environ, QUIET="1")
    if capture_id is not None:
        env["CAPTURE_ID"] = capture_id
    else:
        env.pop("CAPTURE_ID", None)
    proc = subprocess.Popen(  # noqa: S603 - fixed script path, env-driven args
        ["bash", str(SCRIPT)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        output, _ = proc.communicate(timeout=3600)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            output, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output, _ = proc.communicate()
        code = _TIMEOUT_EXIT
    for line in (output or "").splitlines():
        if line.strip():
            logger.info("%s", line)
    return code


def _worker() -> None:
    """Serialise pulls; retry a not-yet-finalised run (exit 3) briefly."""
    global _active
    while not _stop.is_set():
        try:
            capture_id = _queue.get(timeout=1.0)
        except queue.Empty:
            continue
        with _queued_lock:
            _queued.discard(capture_id)
            _active = capture_id
        label = capture_id or "<all finalised>"
        _record_pull(capture_id, state="running")
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
                _record_pull(capture_id, state="ok", exit_code=0, reason="ok")
            else:
                reason = (
                    "the pull ran out of its time budget"
                    if code == _TIMEOUT_EXIT
                    else _EXIT_REASON.get(code, "pull failed (see the importer log)")
                )
                logger.warning("pull failed (exit %d): %s", code, label)
                _record_pull(capture_id, state="failed", exit_code=code, reason=reason)
        except Exception:  # noqa: BLE001 - the worker must never die
            logger.exception("pull crashed: %s", label)
            _record_pull(
                capture_id,
                state="failed",
                exit_code=None,
                reason="the importer crashed running this pull (see its log)",
            )
        finally:
            with _queued_lock:
                _active = _NOTHING_ACTIVE


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
            return
        if self.path == "/pulls":
            with _pulls_lock:
                pulls = {
                    (key if key is not None else "<all>"): dict(entry)
                    for key, entry in _pulls.items()
                }
            self._reply(200, {"pulls": pulls})
            return
        if self.path.startswith("/pull/"):
            capture_id = self.path[len("/pull/") :]
            if not _UUID7_RE.match(capture_id):
                self._reply(400, {"error": "capture_id must be a UUIDv7"})
                return
            entry = _pull_state(capture_id)
            if entry is None:
                self._reply(404, {"error": "no pull is known for this capture"})
                return
            self._reply(200, {"capture_id": capture_id, **entry})
            return
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
