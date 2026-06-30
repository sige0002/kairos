"""Downstream service hosts are configurable for the robot-edge split.

The orchestrator reaches the recorder/monitor/streamer/dora over HTTP. In the
single-host (co-located) deploy these default to localhost; for the robot-edge
split the DDS-reading services run ON the robot, so the orchestrator (on the
recording PC) must address them at the robot's LAN IP. These tests pin that the
*_HOST settings flow into the built clients' base URLs, and that the default is
unchanged (localhost) so co-located deploys keep working.
"""

from __future__ import annotations

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from kairos_common import Settings


def _app(settings: Settings, store: RunStore, fake_recorder):
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    return create_orchestrator_app(settings, store=store, http_client=http_client)


def test_default_service_hosts_are_localhost(fake_recorder, store: RunStore) -> None:
    settings = Settings(recording_config="/nonexistent/recording.yaml")
    app = _app(settings, store, fake_recorder)
    assert app.state.recorder_client.base_url == "http://localhost:8010"
    assert app.state.monitor_client.base_url == "http://localhost:8001"
    assert app.state.streamer_client.base_url == "http://localhost:8002"
    assert app.state.dora_runner_client.base_url == "http://localhost:8020"


def test_split_service_hosts_point_at_robot(fake_recorder, store: RunStore) -> None:
    # Recording-PC orchestrator in split mode: DDS-reading services live on the
    # robot; dora_runner stays local (CPU-heavy, runs beside the orchestrator).
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        recorder_host="10.0.0.5",
        topic_monitor_host="10.0.0.5",
        webrtc_host="10.0.0.5",
        dora_runner_host="localhost",
    )
    app = _app(settings, store, fake_recorder)
    assert app.state.recorder_client.base_url == "http://10.0.0.5:8010"
    assert app.state.monitor_client.base_url == "http://10.0.0.5:8001"
    assert app.state.streamer_client.base_url == "http://10.0.0.5:8002"
    # dora stays local even when the ROS services are remote.
    assert app.state.dora_runner_client.base_url == "http://localhost:8020"
