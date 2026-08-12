# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Flow materialization: the seam between kairos config and a bagflow flow.yml."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from dora_runner.bagflow_flow import (
    FlowBindings,
    flow_path,
    list_flows,
    materialize_flow,
    resolve_flow,
    resolve_node_path,
)
from kairos_common.ids import new_capture_id

# A capture_id is a UUIDv7 everywhere it is used as a key or path segment (§1).
CAPTURE_ID = new_capture_id()


def _bindings(tmp_path: Path) -> FlowBindings:
    return FlowBindings(
        capture_id=CAPTURE_ID,
        bag_dir=tmp_path / "objects" / CAPTURE_ID,
        report_path=tmp_path / "report" / "report.json",
        report_dir=tmp_path / "report",
        required_topics=[
            {"name": "/joint_states", "type": "sensor_msgs/msg/JointState"}
        ],
        expect_hz={"/joint_states": 100.0},
    )


def _write_flow(directory: Path, name: str, body: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.yml"
    path.write_text(yaml.safe_dump(body), encoding="utf-8")
    return path


def test_lists_and_resolves_flows(tmp_path: Path) -> None:
    flows = tmp_path / "flows"
    _write_flow(flows, "default", {"nodes": []})
    _write_flow(flows, "cameras", {"nodes": []})
    (flows / "notes.txt").write_text("ignored", encoding="utf-8")

    assert list_flows(flows) == ["cameras", "default"]
    assert flow_path("default", flows).name == "default.yml"
    with pytest.raises(FileNotFoundError):
        flow_path("missing", flows)


def test_flow_name_cannot_escape_the_flows_dir(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        flow_path("../../etc/passwd", tmp_path)


def test_materialize_substitutes_injects_and_resolves(tmp_path: Path) -> None:
    flows = tmp_path / "flows"
    binaries = tmp_path / "bin"
    binaries.mkdir()
    (binaries / "bagflow-topic-rate").write_text("#!/bin/true\n", encoding="utf-8")
    (flows / "nodes").mkdir(parents=True)
    (flows / "nodes" / "custom.py").write_text("", encoding="utf-8")
    _write_flow(
        flows,
        "default",
        {
            # A stale bag/report in the file must lose to the job's own.
            "bag": "/somewhere/else",
            "report": "/somewhere/else/report.json",
            "nodes": [
                {
                    "id": "topic_rate",
                    "path": "bagflow-topic-rate",
                    "env": {"EXPECT_HZ": "${KAIROS_EXPECT_HZ}"},
                },
                {
                    "id": "custom",
                    "path": "nodes/custom.py",
                    "env": {
                        "TOPICS": "${KAIROS_REQUIRED_TOPICS}",
                        "OUT": "${KAIROS_REPORT_DIR}/custom.json",
                    },
                },
                {"id": "abs", "path": "/opt/vendor/checker"},
            ],
        },
    )
    bindings = _bindings(tmp_path)

    written = materialize_flow(
        "default", bindings, tmp_path / "work", directory=flows, binaries=binaries
    )
    spec = yaml.safe_load(written.read_text(encoding="utf-8"))

    assert spec["bag"] == str(bindings.bag_dir)
    assert spec["report"] == str(bindings.report_path)
    nodes = {node["id"]: node for node in spec["nodes"]}
    # bare name -> bundled binary; relative -> the SOURCE dir (not the workdir);
    # absolute -> untouched.
    assert nodes["topic_rate"]["path"] == str(binaries / "bagflow-topic-rate")
    assert nodes["custom"]["path"] == str(flows / "nodes" / "custom.py")
    assert nodes["abs"]["path"] == "/opt/vendor/checker"
    assert json.loads(nodes["topic_rate"]["env"]["EXPECT_HZ"]) == {
        "/joint_states": 100.0
    }
    assert json.loads(nodes["custom"]["env"]["TOPICS"]) == ["/joint_states"]
    assert nodes["custom"]["env"]["OUT"] == f"{bindings.report_dir}/custom.json"


def test_unknown_placeholder_is_an_error(tmp_path: Path) -> None:
    """A typo must fail loudly: passing ``${KAIROS_TOPCIS}`` through verbatim
    would give a node a nonsense value and a green-looking run."""
    flows = tmp_path / "flows"
    _write_flow(
        flows,
        "default",
        {"nodes": [{"id": "n", "path": "x", "env": {"T": "${KAIROS_TOPCIS}"}}]},
    )
    with pytest.raises(ValueError, match="KAIROS_TOPCIS"):
        materialize_flow(
            "default", _bindings(tmp_path), tmp_path / "work", directory=flows
        )


def test_flow_without_nodes_is_rejected(tmp_path: Path) -> None:
    flows = tmp_path / "flows"
    _write_flow(flows, "default", {"defaults": {"queue_size": 8}})
    with pytest.raises(ValueError, match="no nodes"):
        materialize_flow(
            "default", _bindings(tmp_path), tmp_path / "work", directory=flows
        )


def test_bare_name_without_a_bundled_binary_stays_relative(tmp_path: Path) -> None:
    """An unknown bare name is left for bagflow to report, resolved against the
    flow file, rather than silently pointing into the binary dir."""
    resolved = resolve_node_path("nope", tmp_path / "flows", tmp_path / "bin")
    assert resolved == str((tmp_path / "flows" / "nope").resolve())


def test_required_topic_specs_carry_types_and_names_stay_bare(tmp_path: Path) -> None:
    """Two shapes of the same list: ``${KAIROS_REQUIRED_TOPICS}`` for a node that
    only wants names, ``${KAIROS_REQUIRED_TOPIC_SPECS}`` for one that checks the
    declared message type too (bagflow-topic-presence)."""
    flows = tmp_path / "flows"
    _write_flow(
        flows,
        "default",
        {
            "nodes": [
                {
                    "id": "presence",
                    "path": "bagflow-topic-presence",
                    "env": {
                        "NAMES": "${KAIROS_REQUIRED_TOPICS}",
                        "SPECS": "${KAIROS_REQUIRED_TOPIC_SPECS}",
                    },
                }
            ]
        },
    )

    written = materialize_flow(
        "default", _bindings(tmp_path), tmp_path / "work", directory=flows
    )
    node = yaml.safe_load(written.read_text(encoding="utf-8"))["nodes"][0]

    assert json.loads(node["env"]["NAMES"]) == ["/joint_states"]
    assert json.loads(node["env"]["SPECS"]) == [
        {"name": "/joint_states", "type": "sensor_msgs/msg/JointState"}
    ]


def test_flow_search_order_lets_a_robot_shadow_a_bundled_flow(tmp_path: Path) -> None:
    """fast_validation's flow ships with the service; a file of the same name in
    the robot's config dir must win, which is what makes it overridable without
    touching the image."""
    robot = tmp_path / "robot_flows"
    bundled = tmp_path / "bundled_flows"
    _write_flow(bundled, "fast_validation", {"nodes": [{"id": "bundled", "path": "x"}]})

    # Nothing in the robot's dir: the bundled file answers.
    assert resolve_flow("fast_validation", [robot, bundled]).parent == bundled

    _write_flow(robot, "fast_validation", {"nodes": [{"id": "robot", "path": "x"}]})
    assert resolve_flow("fast_validation", [robot, bundled]).parent == robot

    # A name neither directory carries names both in the error.
    with pytest.raises(FileNotFoundError, match=str(bundled)):
        resolve_flow("nope", [robot, bundled])


def test_the_bundled_fast_validation_flow_is_shipped_and_materializes(
    tmp_path: Path,
) -> None:
    """The in-tree flow is the same file the image carries at /opt/kairos/flows;
    a typo in its ``${KAIROS_…}`` tokens would only surface at job time."""
    from dora_runner.bagflow_flow import bundled_flows_dir

    written = materialize_flow(
        "fast_validation",
        _bindings(tmp_path),
        tmp_path / "work",
        directories=[bundled_flows_dir()],
    )
    spec = yaml.safe_load(written.read_text(encoding="utf-8"))
    node = spec["nodes"][0]

    assert node["path"].endswith("bagflow-topic-presence")
    assert json.loads(node["env"]["REQUIRED_TOPICS"]) == [
        {"name": "/joint_states", "type": "sensor_msgs/msg/JointState"}
    ]
    # Metadata-only by construction: reading the bag is what makes a gate slow.
    assert "inputs" not in node
