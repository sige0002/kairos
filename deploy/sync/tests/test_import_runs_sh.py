"""``import_runs.sh`` end to end, against a fake robot directory.

The real script runs: it really greps manifests for a terminal state, really
stages into ``.incoming/<capture_id>``, really verifies what landed, and really
performs the move. Only the transport is stubbed — ``ssh`` and ``rsync`` are
replaced on ``PATH`` by scripts that operate on local directories — because the
part worth testing is the discovery and staging logic, not OpenSSH.

That boundary is deliberate. Mocking one layer higher (faking the script itself)
would test nothing; mocking one layer lower (a real sshd) would make the suite
depend on a daemon. The stub sits exactly where the network would be.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "import_runs.sh"

CAPTURE_A = "01920000-0000-7000-8000-00000000000a"
CAPTURE_B = "01920000-0000-7000-8000-00000000000b"

# `ssh user@host "<command>"` -> run <command> locally. The script's remote
# find(1) then operates on the fake robot's real directories.
_FAKE_SSH = """#!/usr/bin/env bash
args=()
for a in "$@"; do args+=("$a"); done
cmd="${args[${#args[@]}-1]}"
exec bash -c "$cmd"
"""

# `rsync [opts] user@host:/src/ /dst/` -> a local recursive copy. Mirrors the
# real invocation's trailing-slash semantics (contents, not the directory).
_FAKE_RSYNC = """#!/usr/bin/env bash
argv=("$@")
dst="${argv[${#argv[@]}-1]}"
src="${argv[${#argv[@]}-2]}"
src="${src#*:}"
mkdir -p "$dst"
cp -a "$src". "$dst" 2>/dev/null || cp -a "$src"* "$dst" 2>/dev/null || true
"""


def _manifest(capture_id: str, state: str) -> str:
    return json.dumps(
        {
            "schema_version": 2,
            "capture_id": capture_id,
            "source_instance_id": "11111111-2222-3333-4444-555555555555",
            "run_id": "run_20260801_120000",
            "state": state,
            "started_at": "2026-08-01T00:00:00.000Z",
            "digest_state": "pending",
        }
    )


def _robot_capture(robot: Path, capture_id: str, state: str) -> Path:
    capture = robot / "objects" / capture_id
    capture.mkdir(parents=True, exist_ok=True)
    (capture / "object_manifest.json").write_text(_manifest(capture_id, state))
    (capture / "metadata.yaml").write_text("rosbag2_bagfile_information:\n")
    (capture / f"{capture_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 512)
    return capture


@pytest.fixture
def stub_path(tmp_path: Path) -> Path:
    """A PATH entry whose ssh/rsync work locally."""
    bin_dir = tmp_path / "stub-bin"
    bin_dir.mkdir()
    for name, body in (("ssh", _FAKE_SSH), ("rsync", _FAKE_RSYNC)):
        script = bin_dir / name
        script.write_text(body)
        script.chmod(0o755)
    return bin_dir


def _run(
    tmp_path: Path, stub_path: Path, robot: Path, data: Path, **env: str
) -> subprocess.CompletedProcess[str]:
    environ = {
        **os.environ,
        "PATH": f"{stub_path}:{os.environ['PATH']}",
        "ROBOT_SSH": "robot@fake",
        "ROBOT_DATA_DIR": str(robot),
        "DATA_DIR": str(data),
        "BWLIMIT": "0",
        # The script falls back to the repo's .env / .env.split for anything
        # unset; an empty HOME plus explicit values keeps a developer's real
        # config out of the test.
        "HOME": str(tmp_path / "home"),
        **env,
    }
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env=environ,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestDiscovery:
    def test_a_finished_capture_is_pulled_into_objects(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")

        result = _run(tmp_path, stub_path, robot, data)
        assert result.returncode == 0, result.stderr

        landed = data / "objects" / CAPTURE_A
        assert (landed / "object_manifest.json").is_file()
        assert (landed / f"{CAPTURE_A}_0.mcap").is_file()
        # §2: staging is emptied by the move, never left behind as a second copy.
        assert not (data / ".incoming" / CAPTURE_A).exists()

    def test_an_interrupted_capture_is_pulled_too(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "interrupted")
        _run(tmp_path, stub_path, robot, data)
        # §10.6 names both terminal states: an interrupted recording still has
        # data worth reviewing, and leaving it on the robot would strand it.
        assert (data / "objects" / CAPTURE_A / "object_manifest.json").is_file()

    def test_a_recording_capture_is_left_on_the_robot(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "recording")

        result = _run(tmp_path, stub_path, robot, data)
        assert result.returncode == 0
        # Copying a bag the recorder is still appending to is the exact failure
        # the terminal-state test exists to prevent.
        assert not (data / "objects" / CAPTURE_A).exists()
        # And it is not even STAGED: discovery must reject it, not merely the
        # publish check. Asserting only the objects/ half would still pass if
        # discovery regressed to "any dir with a metadata.yaml", because the
        # arrival verification would quietly catch it one layer later.
        assert not (data / ".incoming" / CAPTURE_A).exists()

    def test_digest_state_is_not_part_of_the_test(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")
        # The digest is the RECEIVING side's job (§11); waiting for the robot to
        # do it would deadlock the pull.
        assert (
            '"digest_state": "pending"'
            in (robot / "objects" / CAPTURE_A / "object_manifest.json").read_text()
        )
        _run(tmp_path, stub_path, robot, data)
        assert (data / "objects" / CAPTURE_A).is_dir()

    def test_only_the_requested_capture_is_pulled(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")
        _robot_capture(robot, CAPTURE_B, "completed")

        _run(tmp_path, stub_path, robot, data, CAPTURE_ID=CAPTURE_A)
        assert (data / "objects" / CAPTURE_A).is_dir()
        # A targeted pull that swept everything is the B1 regression.
        assert not (data / "objects" / CAPTURE_B).exists()

    def test_an_unfinished_target_exits_3_for_the_retry_loop(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "recording")

        result = _run(tmp_path, stub_path, robot, data, CAPTURE_ID=CAPTURE_A)
        # Distinct from a generic failure so the sidecar can retry a capture
        # the recorder is still finalising rather than giving up on it.
        assert result.returncode == 3

    def test_a_malformed_capture_id_is_refused_before_any_ssh(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")

        result = _run(
            tmp_path, stub_path, robot, data, CAPTURE_ID="../../etc; rm -rf /"
        )
        # It is interpolated into a remote command and into local paths.
        assert result.returncode == 2
        assert "UUIDv7" in result.stderr


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestIdempotenceAndSafety:
    def test_a_second_run_skips_what_is_already_here(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")
        _run(tmp_path, stub_path, robot, data)

        second = _run(tmp_path, stub_path, robot, data, QUIET="0")
        assert second.returncode == 0
        assert "skipped(already present)=1" in second.stdout

    def test_the_robot_copy_is_left_in_place(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")
        _run(tmp_path, stub_path, robot, data)
        # A pull is a copy, never a move: robot-side retention is a separate
        # decision and this script must not make it.
        assert (robot / "objects" / CAPTURE_A / f"{CAPTURE_A}_0.mcap").is_file()

    def test_an_arrival_without_a_terminal_manifest_stays_in_staging(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        capture = _robot_capture(robot, CAPTURE_A, "completed")
        # The manifest changed under us mid-transfer: what lands is no longer
        # something we may publish.
        rsync = stub_path / "rsync"
        rsync.write_text(
            _FAKE_RSYNC
            + f"\nprintf %s {json.dumps(_manifest(CAPTURE_A, 'recording'))!r}"
            f' > "$dst/object_manifest.json"\n'
        )
        rsync.chmod(0o755)
        assert capture.is_dir()

        result = _run(tmp_path, stub_path, robot, data)
        assert result.returncode == 0
        # §2's invariant: an incomplete dir under objects/ can only ever be a
        # LOCAL live recording, never a half-arrived transfer.
        assert not (data / "objects" / CAPTURE_A).exists()
        assert (data / ".incoming" / CAPTURE_A).is_dir()
        assert "left in .incoming" in result.stderr

    def test_staging_is_a_sibling_of_objects_not_a_child(
        self, tmp_path: Path, stub_path: Path
    ) -> None:
        robot, data = tmp_path / "robot", tmp_path / "data"
        _robot_capture(robot, CAPTURE_A, "completed")
        _run(tmp_path, stub_path, robot, data)
        # A .incoming inside objects/ would be walked by every scan of the
        # capture store, and §2 places it beside objects/ for that reason.
        assert (data / ".incoming").is_dir()
        assert not (data / "objects" / ".incoming").exists()
