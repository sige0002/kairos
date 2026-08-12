# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""api_orchestrator service entry point (Stage 1: run lifecycle).

Builds the wired app via :func:`create_orchestrator_app` (runs store, recorder
client, run-lifecycle routers, recorder-aware ``/readyz``, startup
reconciliation). The Stage 0 health endpoints and the ``GET /api/v1/config``
render-gate stub remain. Run/job/SSE work beyond the run lifecycle lands later.
"""

from __future__ import annotations

from kairos_common import get_settings

from api_orchestrator.app_factory import create_orchestrator_app

settings = get_settings()
app = create_orchestrator_app(settings)


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    uvicorn.run(app, host=settings.bind_host, port=settings.api_orch_port)


if __name__ == "__main__":
    main()
