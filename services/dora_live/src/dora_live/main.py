"""dora_live service entry point.

Wires the pieces: DoraFeedSubscriber (samples in, discovery), the
DataflowSupervisor (manifest -> generated dataflow -> ``dora run``), and the
topic_monitor-compatible control app; then serves it with uvicorn.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from kairos_common import get_settings, resolve_config_path

from dora_live.control import create_control_app, load_config
from dora_live.feed_subscriber import DoraFeedSubscriber
from dora_live.live_config import load_live_config
from dora_live.probe_app import create_probe_compat_app
from dora_live.probe_state import ProbeHub
from dora_live.supervisor import DataflowSupervisor

logger = logging.getLogger("kairos.dora_live")

DEFAULT_PORT = 8005
DEFAULT_PROBE_PORT = 8006


def service_port(settings: object) -> int:
    """DORA_LIVE_PORT env wins; falls back to settings field, then default."""
    env = os.environ.get("DORA_LIVE_PORT")
    if env:
        return int(env)
    return int(getattr(settings, "dora_live_port", DEFAULT_PORT))


def main() -> None:
    import threading

    import uvicorn

    settings = get_settings()
    port = service_port(settings)
    probe_port = int(os.environ.get("DORA_LIVE_PROBE_PORT", DEFAULT_PROBE_PORT))
    config = load_config(resolve_config_path(settings.recording_config))
    # LIVE_CONFIG separates the live topic set / QoS / video lane from the
    # recording decision; absent = inherit the recording default_topics. A
    # malformed file is a loud startup failure (see load_live_config), so a
    # typo cannot silently revert the live lanes to defaults.
    live_config_path = os.environ.get("LIVE_CONFIG")
    try:
        live_config = load_live_config(
            resolve_config_path(live_config_path) if live_config_path else None
        )
    except Exception:
        logger.exception("invalid LIVE_CONFIG %s", live_config_path)
        raise

    feed = DoraFeedSubscriber()
    hub = ProbeHub()
    supervisor = DataflowSupervisor(
        config=config,
        feed=feed,
        workdir=Path(os.environ.get("DORA_LIVE_WORKDIR", "/tmp/dora_live")),
        control_url=f"http://127.0.0.1:{port}",
        live_config=live_config,
    )
    app = create_control_app(
        subscriber=feed,
        config=config,
        live_status=supervisor.status,
        reload_manifest=supervisor.reload,
        probe_hub=hub,
    )
    probe_app = create_probe_compat_app(
        hub=hub, feed=feed, dataflow_alive=supervisor.alive
    )

    # Probe surface on its own port (nginx /probe/ proxies to a service root,
    # so the two contracts cannot share one port without path collisions).
    probe_server = uvicorn.Server(
        uvicorn.Config(probe_app, host=settings.bind_host, port=probe_port)
    )
    probe_thread = threading.Thread(
        target=probe_server.run, name="dora-live-probe", daemon=True
    )
    probe_thread.start()

    # The subscriber starts inside the app lifespan; the supervisor waits on
    # discovery internally, so starting it before uvicorn serves is safe.
    supervisor.start()
    try:
        uvicorn.run(app, host=settings.bind_host, port=port)
    finally:
        supervisor.stop()
        probe_server.should_exit = True


if __name__ == "__main__":
    main()
