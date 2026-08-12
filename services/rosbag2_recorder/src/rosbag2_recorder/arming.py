# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""The --start-paused readiness gate: everything here talks to ROS.

Split out of :mod:`rosbag2_recorder.recorder` unchanged, to keep every rclpy and
``rosbag2_interfaces`` touch in one file. ``ros2 bag record`` is spawned paused
so the bag opens with all topics already subscribed (no first frames lost to DDS
discovery); these functions wait for that subscription match on the ROS graph and
then either resume the subprocess (the single-call
``recording.start_paused`` gate) or hand back live service clients for a later
resume (two-phase ``prepare()`` -> ``start()``).

**rclpy is imported lazily, inside the functions that need it, never at module
scope.** The recorder must import on a host with no ROS installed — that is what
lets the unit tests drive the whole state machine — and the live path runs in the
ROS image (verified in Docker, like the monitor's rclpy paths).

The session's own state is not owned here. ``_arming``/``_armed`` stay on
:class:`~rosbag2_recorder.recorder.RecorderSession`; these functions take the
live session and read or write it through it, and call back through
``session._readiness_view`` and friends so the dispatch is the same one the
methods had before the split (the tests substitute several of them per instance).
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from rosbag2_recorder.recorder import RecorderSession, _Armed

# Deliberately the same logger the recorder itself uses: these lines are the
# recorder's voice while it arms, and splitting the module must not split the
# log stream an operator greps when a start hangs.
logger = logging.getLogger("kairos.rosbag2_recorder")

# `ros2 bag record` registers its node under this name; its pause/resume/
# is_paused services live at /<node>/... (rosbag2_interfaces). Used by the
# --start-paused readiness gate.
RECORDER_NODE_NAME = "rosbag2_recorder"
# How often the readiness gate polls the ROS graph for the recorder's
# subscriptions while it is paused.
SUBSCRIPTION_POLL_S = 0.2
# How long to wait for the recorder's resume/is_paused services to appear.
RESUME_SERVICE_TIMEOUT_S = 5.0


def arm_and_resume(
    session: RecorderSession, run_id: str, topics: list[str], all_mode: bool
) -> None:
    """Wait until ``ros2 bag record`` has subscribed to the target topics,
    then resume it (it was spawned ``--start-paused``).

    Raises on any hard failure so the caller fails the start rather than
    leaving a paused recorder capturing nothing. rclpy + rosbag2_interfaces
    are imported lazily so the module imports without ROS; the live path runs
    in the ROS image (verified in Docker, like the monitor's rclpy paths).

    This is the single-call gate (``recording.start_paused``): the node it
    creates is transient — it exists purely to arm-then-resume within this
    one call, unlike :func:`prepare_arm`'s node, which is kept alive across
    ``prepare()`` -> ``start()``.
    """
    import rclpy
    from rclpy.node import Node
    from rosbag2_interfaces.srv import IsPaused, Resume

    timeout = (
        session._config.recording.subscription_ready_timeout_s
        if session._config is not None
        else 5.0
    )
    owns_rclpy = not rclpy.ok()
    if owns_rclpy:
        rclpy.init()
    node = Node("kairos_recorder_arming")
    try:
        session._await_subscription_match(node, rclpy, topics, all_mode, timeout)
        session._resume_recorder(rclpy, node, Resume, IsPaused)
        # Resumed: no longer waiting. Keep the final matched/missing snapshot
        # (a non-empty ``missing`` means the gate timed out and resumed anyway).
        if session._arming is not None:
            session._arming.active = False
        logger.info("recording armed + resumed", extra={"run_id": run_id})
    finally:
        node.destroy_node()
        if owns_rclpy:
            rclpy.shutdown()


def prepare_arm(
    session: RecorderSession, run_id: str, topics: list[str], all_mode: bool
) -> tuple[Any, Any, Any, bool]:
    """Wait for subscription match and create MATCHED Resume/IsPaused clients.

    Unlike :func:`arm_and_resume`, this does NOT call resume and does NOT
    destroy the node on success: both the node and the clients are handed
    back to the caller (``RecorderSession.prepare``) to hold on the armed
    session, so a later fast ``start()`` is just a resume call — no repeat
    DDS-participant creation or service discovery (the whole point of
    two-phase start).

    Returns ``(node, resume_client, is_paused_client, owns_rclpy)``. On any
    failure the node/context are torn down here before raising, so the
    caller's except-clause only has to deal with the subprocess + capture dir.
    """
    import rclpy
    from rclpy.node import Node
    from rosbag2_interfaces.srv import IsPaused, Resume

    timeout = (
        session._config.recording.subscription_ready_timeout_s
        if session._config is not None
        else 5.0
    )
    owns_rclpy = not rclpy.ok()
    if owns_rclpy:
        rclpy.init()
    node = Node("kairos_recorder_arming")
    try:
        session._await_subscription_match(node, rclpy, topics, all_mode, timeout)
        resume_client = node.create_client(Resume, f"/{RECORDER_NODE_NAME}/resume")
        is_paused_client = node.create_client(
            IsPaused, f"/{RECORDER_NODE_NAME}/is_paused"
        )
        if not resume_client.wait_for_service(timeout_sec=RESUME_SERVICE_TIMEOUT_S):
            raise RuntimeError("recorder resume service did not appear")
        # is_paused is only used to CONFIRM resume; best-effort like
        # _resume_recorder (arm anyway if it never appears).
        is_paused_client.wait_for_service(timeout_sec=2.0)
        logger.info("recording armed (two-phase prepare)", extra={"run_id": run_id})
        return node, resume_client, is_paused_client, owns_rclpy
    except Exception:
        node.destroy_node()
        if owns_rclpy:
            rclpy.shutdown()
        raise


def resume_armed(armed: _Armed) -> None:
    """Resume an armed subprocess via its already-matched clients.

    No ``wait_for_service`` calls: ``prepare()`` (:func:`prepare_arm`)
    already confirmed both services are present, so re-waiting here would
    reintroduce the exact discovery latency two-phase start exists to
    remove. Same fail-safe confirmation as :func:`resume_recorder`: raises
    if resume doesn't return, or if ``is_paused`` still reports paused
    afterwards.
    """
    import rclpy
    from rosbag2_interfaces.srv import IsPaused, Resume

    fut = armed.resume_client.call_async(Resume.Request())
    rclpy.spin_until_future_complete(
        armed.node, fut, timeout_sec=RESUME_SERVICE_TIMEOUT_S
    )
    if fut.result() is None:
        raise RuntimeError("recorder resume call did not return")
    f2 = armed.is_paused_client.call_async(IsPaused.Request())
    rclpy.spin_until_future_complete(armed.node, f2, timeout_sec=3.0)
    res = f2.result()
    if res is not None and getattr(res, "paused", False):
        raise RuntimeError("recorder still paused after resume")


def teardown_armed_rclpy(armed: _Armed) -> None:
    """Destroy the armed session's held rclpy node (+ shutdown if owned).

    Called both when a session is committed (resume succeeded — the node
    is no longer needed, the subprocess runs unattended until ``stop()``)
    and when it is disarmed/failed. Best-effort: teardown must not raise
    over a session that is being torn down anyway.
    """
    try:
        armed.node.destroy_node()
    except Exception:  # noqa: BLE001 - best-effort teardown
        logger.exception("failed to destroy the armed rclpy node")
    if armed.owns_rclpy:
        import rclpy

        try:
            if rclpy.ok():
                rclpy.shutdown()
        except Exception:  # noqa: BLE001
            logger.exception("failed to shut down the armed rclpy context")


def readiness_targets(node: Any, topics: list[str], all_mode: bool) -> list[str]:
    """Topics the readiness gate waits on: the explicit list, or (for
    ``--all``) every currently-published topic at this instant."""
    if not all_mode:
        return list(topics)
    return [
        name
        for name, _types in node.get_topic_names_and_types()
        if node.count_publishers(name) > 0
    ]


def recorder_subscribed(node: Any, topic: str) -> bool:
    """True once a publisher exists AND the recorder node has subscribed."""
    if node.count_publishers(topic) == 0:
        return False
    return any(
        info.node_name == RECORDER_NODE_NAME
        for info in node.get_subscriptions_info_by_topic(topic)
    )


def readiness_view(
    session: RecorderSession, node: Any, topics: list[str], all_mode: bool
) -> tuple[list[str], list[str], list[str]]:
    """One graph read -> ``(matched, unsubscribed, missing)`` for the targets.

    The gate's "pending" set is ``unsubscribed + missing``; splitting it by
    CAUSE is what lets the UI say "not publishing" only about a topic that
    really has no publisher (see :class:`RecordArming`).
    """
    matched: list[str] = []
    unsubscribed: list[str] = []
    missing: list[str] = []
    for topic in session._readiness_targets(node, topics, all_mode):
        if node.count_publishers(topic) == 0:
            missing.append(topic)
        elif session._recorder_subscribed(node, topic):
            matched.append(topic)
        else:
            unsubscribed.append(topic)
    return matched, unsubscribed, missing


def await_recorder_subscribed(
    session: RecorderSession,
    rclpy_mod: Any,
    node: Any,
    topics: list[str],
    all_mode: bool,
    timeout: float,
) -> None:
    """Poll the ROS graph until the recorder has subscribed to every target
    topic that has a publisher, or until *timeout* (then resume anyway).

    Each poll refreshes the observational arming snapshot (matched vs missing)
    so the state reflects the latest readiness view (OL-①.4)."""
    deadline = time.monotonic() + timeout
    while True:
        rclpy_mod.spin_once(node, timeout_sec=SUBSCRIPTION_POLL_S)
        matched, unsubscribed, missing = session._readiness_view(node, topics, all_mode)
        pending = unsubscribed + missing
        session._update_arming(matched, unsubscribed, missing)
        if matched and not pending:
            return
        if time.monotonic() >= deadline:
            if pending:
                logger.warning(
                    "arming timed out; resuming with topics not yet matched",
                    extra={"pending_topics": pending},
                )
            return


def resume_recorder(
    rclpy_mod: Any, node: Any, resume_srv: Any, is_paused_srv: Any
) -> None:
    """Call the recorder's ``~/resume`` service and confirm it is no longer
    paused. Raises if the service is missing or it stays paused."""
    resume = node.create_client(resume_srv, f"/{RECORDER_NODE_NAME}/resume")
    if not resume.wait_for_service(timeout_sec=RESUME_SERVICE_TIMEOUT_S):
        raise RuntimeError("recorder resume service did not appear")
    fut = resume.call_async(resume_srv.Request())
    rclpy_mod.spin_until_future_complete(
        node, fut, timeout_sec=RESUME_SERVICE_TIMEOUT_S
    )
    if fut.result() is None:
        raise RuntimeError("recorder resume call did not return")
    # Confirm it actually resumed (fail-safe against a silent paused bag).
    is_paused = node.create_client(is_paused_srv, f"/{RECORDER_NODE_NAME}/is_paused")
    if is_paused.wait_for_service(timeout_sec=2.0):
        f2 = is_paused.call_async(is_paused_srv.Request())
        rclpy_mod.spin_until_future_complete(node, f2, timeout_sec=3.0)
        res = f2.result()
        if res is not None and getattr(res, "paused", False):
            raise RuntimeError("recorder still paused after resume")
