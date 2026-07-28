"""Running bagflow flows: a private dora stack, one subprocess per job, cleanup.

dora is a real runtime here (not the in-process interpreter): a job shells out to
the bundled ``bagflow`` CLI, which generates a dora dataflow and starts it on a
coordinator/daemon pair. Three deployment realities shape this module.

**The dora stack is private to dora_runner.** Every kairos service runs with
``network_mode: host``, and dora 0.5's ``dora up`` can only bind its default
control port (6012) — so any other dora on the host would answer there. A
shared coordinator would mean bagflow dataflows landing on a differently-patched
dora build, and a "stop everything" cleanup reaching flows we do not own. So the
service spawns ``dora coordinator`` + ``dora daemon`` itself on loopback-only
ports of its own (``KAIROS_DORA_*_PORT``) and points the vendored CLI at them
(``DORA_COORDINATOR_ADDR`` / ``DORA_COORDINATOR_PORT``, see bagflow/VENDOR.md).

**Timeouts are layered, shortest first**, so a stuck flow is reported by the layer
with the best diagnostics rather than by a blunt outer kill:

1. ``bagflow run --timeout`` (``KAIROS_BAGFLOW_TIMEOUT_S``, default 600s) — prints
   which node's process is already gone and which are still waiting;
2. this module's ``+30s`` grace on the subprocess — covers a wedged CLI;
3. ``KAIROS_DORA_JOB_TIMEOUT_S`` (default 900s) in ``main._execute_job``, the
   backstop for the whole job.

**Cleanup is targeted, never global.** dora 0.5 does not propagate a node's
abnormal exit downstream (no ``InputClosed``), so surviving nodes wait forever and
keep ``/dev/shm`` pinned. A failed or timed-out run is therefore always followed by
``dora stop --name <job_id>`` (the run is named for exactly this reason), escalating
to ``--force`` when the dataflow is still listed as running. There is no
``dora stop --all`` in dora 0.5, and the "stop whatever is running" equivalent is
deliberately not reimplemented: on shutdown we ``dora destroy`` OUR coordinator,
which can only ever reach our own dataflows.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("kairos")

BAGFLOW_BIN = "bagflow"
DORA_BIN = "dora"

# Private dora endpoint (loopback only). Defaults deliberately differ from dora's
# own (6012 / 53290 / 53291) so any other dora on this host keeps working
# untouched — and so we never adopt a coordinator we do not own.
COORDINATOR_ADDR_ENV = "KAIROS_DORA_COORDINATOR_ADDR"
CONTROL_PORT_ENV = "KAIROS_DORA_CONTROL_PORT"
DAEMON_PORT_ENV = "KAIROS_DORA_DAEMON_PORT"
DAEMON_LISTEN_PORT_ENV = "KAIROS_DORA_DAEMON_LISTEN_PORT"
DEFAULT_COORDINATOR_ADDR = "127.0.0.1"
DEFAULT_CONTROL_PORT = 6112
DEFAULT_DAEMON_PORT = 53390
DEFAULT_DAEMON_LISTEN_PORT = 53391

# Per-flow wall-clock budget handed to `bagflow run --timeout`.
FLOW_TIMEOUT_ENV = "KAIROS_BAGFLOW_TIMEOUT_S"
DEFAULT_FLOW_TIMEOUT_S = 600.0
# Extra time the CLI gets to finish reporting after its own timeout fires.
_SUBPROCESS_GRACE_S = 30.0
# How long the daemon may take to answer after we spawn the stack.
_STACK_READY_TIMEOUT_S = 15.0
# `dora stop --grace-duration`: Stop event -> SIGTERM -> kill.
_STOP_GRACE = "5s"


def bagflow_available() -> bool:
    """Whether this deployment can run bagflow flows at all.

    Both binaries live in the dora_runner image; a source checkout / CI host has
    neither, which is why ``full_validation`` stays a non-runnable placeholder
    there instead of failing at job time (honesty rule: advertise what runs).
    """
    return shutil.which(BAGFLOW_BIN) is not None and shutil.which(DORA_BIN) is not None


def flow_timeout_s() -> float:
    """Per-flow budget (``KAIROS_BAGFLOW_TIMEOUT_S``, default 600s)."""
    try:
        return max(1.0, float(os.environ.get(FLOW_TIMEOUT_ENV, "")))
    except ValueError:
        return DEFAULT_FLOW_TIMEOUT_S


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return default


@dataclass(frozen=True)
class DoraEndpoint:
    """Where this service's own dora coordinator/daemon listen."""

    addr: str = DEFAULT_COORDINATOR_ADDR
    control_port: int = DEFAULT_CONTROL_PORT
    daemon_port: int = DEFAULT_DAEMON_PORT
    daemon_listen_port: int = DEFAULT_DAEMON_LISTEN_PORT

    @classmethod
    def from_env(cls) -> DoraEndpoint:
        return cls(
            addr=os.environ.get(COORDINATOR_ADDR_ENV) or DEFAULT_COORDINATOR_ADDR,
            control_port=_int_env(CONTROL_PORT_ENV, DEFAULT_CONTROL_PORT),
            daemon_port=_int_env(DAEMON_PORT_ENV, DEFAULT_DAEMON_PORT),
            daemon_listen_port=_int_env(
                DAEMON_LISTEN_PORT_ENV, DEFAULT_DAEMON_LISTEN_PORT
            ),
        )

    @property
    def cli_args(self) -> list[str]:
        """``--coordinator-addr/-port`` for a ``dora`` subcommand."""
        return [
            "--coordinator-addr",
            self.addr,
            "--coordinator-port",
            str(self.control_port),
        ]

    def child_env(self, base: dict[str, str] | None = None) -> dict[str, str]:
        """Environment for the bagflow CLI so it targets THIS coordinator."""
        env = dict(base if base is not None else os.environ)
        env["DORA_COORDINATOR_ADDR"] = self.addr
        env["DORA_COORDINATOR_PORT"] = str(self.control_port)
        return env

    def reachable(self, timeout_s: float = 0.2) -> bool:
        try:
            with socket.create_connection(
                (self.addr, self.control_port), timeout=timeout_s
            ):
                return True
        except OSError:
            return False


class DoraStack:
    """The service's own ``dora coordinator`` + ``dora daemon`` child processes.

    ``start()`` is idempotent and non-fatal: a deployment without the binaries (or
    a coordinator that refuses to come up) leaves ``running`` false, and jobs fail
    with that reason instead of the service refusing to boot.
    """

    def __init__(self, endpoint: DoraEndpoint, workdir: Path) -> None:
        self.endpoint = endpoint
        # dora writes its logs (out/) relative to the process cwd, so give the
        # stack a writable directory of its own under the data root.
        self.workdir = workdir
        self._procs: list[subprocess.Popen[bytes]] = []
        self._external = False

    @property
    def running(self) -> bool:
        return self._external or bool(self._procs)

    def start(self) -> bool:
        """Spawn (or adopt) the coordinator/daemon pair; return whether it answers."""
        if not bagflow_available():
            logger.info(
                "bagflow binaries absent; full_validation stays unavailable",
                extra={"bin": DORA_BIN},
            )
            return False
        if self.endpoint.reachable():
            # Someone already listens on our private port: adopt it rather than
            # fight for the port, but say so — an unexpected owner (a stray
            # coordinator, another kairos stack) explains later oddities.
            logger.warning(
                "adopting an existing dora coordinator",
                extra={"port": self.endpoint.control_port},
            )
            self._external = True
            return True
        self.workdir.mkdir(parents=True, exist_ok=True)
        log_path = self.workdir / "dora_stack.log"
        log = log_path.open("ab")
        try:
            self._spawn(
                [
                    DORA_BIN,
                    "coordinator",
                    # Loopback only: with host networking, dora's 0.0.0.0 default
                    # would expose the control port on the LAN.
                    "--control-interface",
                    self.endpoint.addr,
                    "--control-port",
                    str(self.endpoint.control_port),
                    "--interface",
                    self.endpoint.addr,
                    "--port",
                    str(self.endpoint.daemon_port),
                    "--quiet",
                ],
                log,
            )
            if not self._wait_reachable():
                logger.error(
                    "dora coordinator did not come up",
                    extra={"port": self.endpoint.control_port, "log": str(log_path)},
                )
                self.stop()
                return False
            self._spawn(
                [
                    DORA_BIN,
                    "daemon",
                    "--coordinator-addr",
                    self.endpoint.addr,
                    "--coordinator-port",
                    str(self.endpoint.daemon_port),
                    "--local-listen-port",
                    str(self.endpoint.daemon_listen_port),
                    "--quiet",
                ],
                log,
            )
        finally:
            log.close()
        if not self._wait_daemon_registered():
            # The coordinator answers as soon as it binds, but a dataflow cannot
            # start until the DAEMON has registered with it — `dora start` fails
            # with "no unnamed daemon connections" in that window (measured: the
            # coordinator is reachable ~2 polls before the daemon registers).
            # Readiness therefore means "a dataflow can start", not "the port
            # accepts a connection", or the first job after every restart dies.
            logger.error(
                "dora daemon did not register with the coordinator",
                extra={"port": self.endpoint.control_port, "log": str(log_path)},
            )
            self.stop()
            return False
        logger.info(
            "dora stack up",
            extra={
                "control_port": self.endpoint.control_port,
                "daemon_port": self.endpoint.daemon_port,
            },
        )
        return True

    def _spawn(self, argv: list[str], log: object) -> None:
        self._procs.append(
            subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                argv,
                cwd=self.workdir,
                stdout=log,  # type: ignore[arg-type]
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        )

    def _wait_reachable(self) -> bool:
        deadline = time.monotonic() + _STACK_READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if self.endpoint.reachable():
                return True
            if any(p.poll() is not None for p in self._procs):
                return False
            time.sleep(0.1)
        return False

    def _wait_daemon_registered(self) -> bool:
        """Block until ``dora check`` reports a registered daemon.

        ``dora check`` (alias of ``system status``) exits non-zero while the
        daemon has not connected — it prints ``Daemon: Not running`` even with a
        healthy coordinator — and 0 once a dataflow could actually be started.
        """
        deadline = time.monotonic() + _STACK_READY_TIMEOUT_S
        while time.monotonic() < deadline:
            if _run_dora(["check", *self.endpoint.cli_args]).returncode == 0:
                return True
            if any(p.poll() is not None for p in self._procs):
                return False
            time.sleep(0.2)
        return False

    def stop(self) -> None:
        """Tear the stack down: ``dora destroy`` (stops our dataflows first), then
        terminate the children. Never touches a coordinator we merely adopted."""
        if self._external:
            self._external = False
            return
        if self._procs:
            _run_dora(["destroy", *self.endpoint.cli_args], timeout_s=15.0)
        for proc in reversed(self._procs):
            if proc.poll() is None:
                proc.terminate()
        for proc in self._procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        self._procs.clear()


def _run_dora(
    args: list[str], *, timeout_s: float = 10.0
) -> subprocess.CompletedProcess[str]:
    """Run a ``dora`` subcommand, never raising (cleanup must not mask the cause)."""
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            [DORA_BIN, *args],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("dora %s failed", " ".join(args), extra={"error": str(exc)})
        return subprocess.CompletedProcess(
            args, returncode=1, stdout="", stderr=str(exc)
        )


@dataclass(frozen=True)
class FlowRun:
    """Outcome of one ``bagflow run``."""

    ok: bool
    exit_code: int
    output: str
    timed_out: bool
    wall_s: float

    @property
    def log_tail(self) -> list[str]:
        return self.output.splitlines()[-20:]

    @property
    def error_line(self) -> str | None:
        """The CLI's own one-line diagnosis, if it printed one.

        bagflow reports the actionable cause (an unknown topic, a dead node, a
        missing bag) as an ``Error:`` line; lifting it into the job's message
        keeps the operator from having to open the log tail for the common case.
        """
        for line in self.output.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("error:"):
                return stripped
        return None


async def run_flow(
    flow_file: Path,
    *,
    name: str,
    endpoint: DoraEndpoint,
    timeout_s: float | None = None,
) -> FlowRun:
    """Run one materialized flow to completion (or to its timeout).

    ``--no-attach`` returns as soon as the report is written and leaves teardown
    to the daemon (~0.5s of a quick gate's wall time); the report is written
    atomically, so an early return never reads a partial file.
    """
    budget = timeout_s if timeout_s is not None else flow_timeout_s()
    argv = [
        BAGFLOW_BIN,
        "run",
        "--no-attach",
        "--name",
        name,
        "--timeout",
        str(int(budget)),
        str(flow_file),
    ]
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(flow_file.parent),
        env=endpoint.child_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    timed_out = False
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(), budget + _SUBPROCESS_GRACE_S
        )
        output = stdout.decode(errors="replace")
    except TimeoutError:
        timed_out = True
        proc.kill()
        stdout, _ = await proc.communicate()
        output = stdout.decode(errors="replace")
    except asyncio.CancelledError:
        # Job cancelled from the API: kill the CLI, then sweep the dataflow so no
        # orphaned node keeps holding shared memory.
        proc.kill()
        await proc.wait()
        await cleanup_flow(name, endpoint)
        raise
    wall = time.monotonic() - started
    ok = not timed_out and proc.returncode == 0
    if not ok:
        await cleanup_flow(name, endpoint)
    return FlowRun(
        ok=ok,
        exit_code=proc.returncode if proc.returncode is not None else -1,
        output=output,
        timed_out=timed_out,
        wall_s=wall,
    )


async def cleanup_flow(name: str, endpoint: DoraEndpoint) -> None:
    """Stop the named dataflow, escalating to ``--force`` if it survives.

    dora 0.5 leaves a dataflow whose node crashed running forever (the survivors
    wait for an end-of-stream that never comes), and every queued message it
    still holds sits in ``/dev/shm`` — so this runs after every failed or
    timed-out flow, not only after a timeout.
    """
    await asyncio.to_thread(
        _run_dora,
        ["stop", "--name", name, "--grace-duration", _STOP_GRACE, *endpoint.cli_args],
        timeout_s=20.0,
    )
    if await asyncio.to_thread(_dataflow_running, name, endpoint):
        logger.warning(
            "dataflow still running after stop; forcing", extra={"name": name}
        )
        await asyncio.to_thread(
            _run_dora,
            ["stop", "--name", name, "--force", *endpoint.cli_args],
            timeout_s=20.0,
        )


def _dataflow_running(name: str, endpoint: DoraEndpoint) -> bool:
    """Whether *name* is still listed as running on our coordinator."""
    result = _run_dora(["list", "--format", "json", *endpoint.cli_args])
    if result.returncode != 0:
        return False
    for line in result.stdout.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("name") == name and str(entry.get("status")) == "Running":
            return True
    return False
