"""api_orchestrator: API hub / job & state management (Stage 0 skeleton).

The single public API the frontend talks to. Stage 0 provides only a runnable
FastAPI shell (/healthz, /readyz, stub root) plus a minimal stub
``GET /api/v1/config`` so the frontend's render-gate has an endpoint to fetch.
Run lifecycle, SSE event hub, recorder proxying, SQLite persistence, and the
job/pipeline APIs land in Stages 1-3.
"""
