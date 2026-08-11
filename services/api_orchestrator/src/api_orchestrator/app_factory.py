"""Application factory for api_orchestrator — capture store v2.

Builds the FastAPI app on ``kairos_common.create_app`` and wires the v2 stack:
the :class:`~api_orchestrator.store.CaptureStore`, the capture / record /
dataset services, the digest job and the reconciler.

Two things happen in a deliberate order and are worth stating:

**Identity is settled synchronously, before anything is constructed.**
``prepare_store`` creates the directory layout, reads or mints ``instance.json``
and checks the ``objects``/``.trash``/``.incoming`` filesystem invariant. Every
service below is keyed by ``instance_id``, so it cannot be deferred to startup.
A corrupt ``instance.json`` therefore fails app construction — which is correct:
starting with a fresh id would orphan every replica row on the volume.

**Rebuild and delete-resume happen in the lifespan, not the factory.** They are
async (the recorder is asked which captures are live, §8 rule 1) and they must
run once per process rather than once per app object.

The factory accepts injected ``store`` / ``http_client`` so tests can supply a
temporary data directory and an ``httpx.MockTransport`` without a live recorder.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from kairos_common import (
    ApiError,
    Settings,
    create_app,
    get_settings,
    ledger_v2,
    load_recording_config_or_none,
    load_stream_config,
    resolve_config_path,
)
from kairos_common.recording_config import RecordingConfig
from kairos_common.stream_config import StreamConfig

from api_orchestrator import bag_import
from api_orchestrator import views as views_mod
from api_orchestrator.batch_service import BatchService
from api_orchestrator.bootstrap import StoreStartupError, bootstrap_store, prepare_store
from api_orchestrator.capture_archive import CaptureArchiveRuns
from api_orchestrator.captures import CaptureService
from api_orchestrator.config_catalog import ConfigCatalog
from api_orchestrator.dataset_archive import DatasetArchiver
from api_orchestrator.dataset_service import DatasetService
from api_orchestrator.digest import DigestJob
from api_orchestrator.dora_runner_client import DoraRunnerClient
from api_orchestrator.events import EventHub
from api_orchestrator.health import StoreHealth
from api_orchestrator.importer_client import ImporterClient
from api_orchestrator.models import Capture
from api_orchestrator.monitor_client import MonitorClient
from api_orchestrator.reconciler import Reconciler
from api_orchestrator.record_service import RecordService
from api_orchestrator.recorder_client import RecorderClient
from api_orchestrator.routers import batches as batches_router
from api_orchestrator.routers import captures as captures_router
from api_orchestrator.routers import config as config_router
from api_orchestrator.routers import datasets as datasets_router
from api_orchestrator.routers import events as events_router
from api_orchestrator.routers import files as files_router
from api_orchestrator.routers import imports as imports_router
from api_orchestrator.routers import jobs as jobs_router
from api_orchestrator.routers import pipelines as pipelines_router
from api_orchestrator.routers import plans as plans_router
from api_orchestrator.routers import record as record_router
from api_orchestrator.routers import retention as retention_router
from api_orchestrator.routers import store as store_router
from api_orchestrator.routers import system as system_router
from api_orchestrator.routers import topics as topics_router
from api_orchestrator.routers import transfer as transfer_router
from api_orchestrator.routers import validation as validation_router
from api_orchestrator.store import CaptureStore
from api_orchestrator.streamer_client import StreamerClient

logger = logging.getLogger("kairos")

SERVICE_NAME = "api_orchestrator"


def _warn_recording_config(log: logging.Logger, path: Path, exc: Exception) -> None:
    """Report an unusable RECORDING_CONFIG in the orchestrator's own wording."""
    if isinstance(exc, FileNotFoundError):
        log.warning("RECORDING_CONFIG not found", extra={"path": str(path)})
    else:
        log.warning("RECORDING_CONFIG invalid", extra={"error": str(exc)})


def _load_recording_config(settings: Settings) -> RecordingConfig | None:
    """Load RECORDING_CONFIG if present; tolerate its absence in dev/tests."""
    return load_recording_config_or_none(
        resolve_config_path(settings.recording_config),
        logger,
        on_unavailable=_warn_recording_config,
    )


def _load_stream_config(settings: Settings) -> StreamConfig | None:
    """Load STREAM_CONFIG if present; tolerate its absence (UI hint only)."""
    path = Path(resolve_config_path(settings.stream_config))
    if not path.exists():
        return None
    try:
        return load_stream_config(path)
    except (ValueError, OSError) as exc:
        logger.warning("STREAM_CONFIG invalid", extra={"error": str(exc)})
        return None


def _component_state(ok: bool) -> str:
    return "ok" if ok else "unreachable"


def _readyz_probe(
    recorder: RecorderClient,
    monitor: MonitorClient,
    streamer: StreamerClient,
) -> Callable[[], Awaitable[dict[str, object]]]:
    """Build the ``/readyz`` probe that checks the downstreams.

    The recorder gates readiness; monitor and streamer outages are degraded
    dependencies. The store's own condition is deliberately NOT folded in here:
    a SUSPECT catalog still records and still serves reviews (§9-3), so failing
    readiness would take the service out of rotation for a condition it is
    designed to keep working through. ``GET /api/v1/store/health`` is where that
    lives instead.
    """

    async def readyz() -> dict[str, object]:
        recorder_ok = await recorder.healthz()
        monitor_ok = await monitor.healthz()
        streamer_ok = await streamer.healthz()
        any_unreachable = not (recorder_ok and monitor_ok and streamer_ok)
        status = "ready" if recorder_ok and not any_unreachable else "degraded"
        return {
            "status": status,
            "components": {
                "recorder": _component_state(recorder_ok),
                "monitor": _component_state(monitor_ok),
                "streamer": _component_state(streamer_ok),
            },
        }

    return readyz


def create_orchestrator_app(
    settings: Settings | None = None,
    *,
    store: CaptureStore | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """Build the wired api_orchestrator FastAPI app.

    Args:
        settings: Shared settings (defaults to the cached instance).
        store: Injected catalog. Defaults to ``<data_dir>/kairos.db``.
        http_client: Injected httpx client for the downstream services (tests
            pass one backed by a ``MockTransport``).
    """
    settings = settings or get_settings()
    recording_config = _load_recording_config(settings)
    stream_config = _load_stream_config(settings)

    health = StoreHealth()
    prepared = prepare_store(settings.data_dir, health)
    layout = prepared.layout
    instance_id = prepared.instance_id

    capture_store = store or CaptureStore(
        layout.db, data_dir=layout.data_dir, instance_id=instance_id
    )
    capture_store.set_instance_id(instance_id)

    owns_client = http_client is None
    # trust_env=False: every downstream is LAN-internal, so a host-injected
    # HTTP(S)_PROXY must never be used — behind a corporate proxy it would
    # black-hole the robot-edge calls.
    client = http_client or httpx.AsyncClient(trust_env=False)
    recorder = RecorderClient(
        f"http://{settings.recorder_host}:{settings.recorder_port}", client
    )
    monitor = MonitorClient(
        f"http://{settings.topic_monitor_host}:{settings.topic_monitor_port}", client
    )
    streamer = StreamerClient(
        f"http://{settings.webrtc_host}:{settings.webrtc_port}", client
    )
    dora_runner = DoraRunnerClient(
        f"http://{settings.dora_runner_host}:{settings.dora_runner_port}", client
    )
    importer = ImporterClient(
        f"http://{settings.importer_host}:{settings.importer_port}", client
    )
    event_hub = EventHub(monitor)
    config_catalog = ConfigCatalog(
        settings.config_dir, settings.config_local_dir, settings.robot
    )

    app = create_app(
        SERVICE_NAME,
        settings=settings,
        readyz=_readyz_probe(recorder, monitor, streamer),
    )

    async def on_first_review(capture: Capture) -> None:
        """The side effects §4.1 moved off the retired ``POST /episodes``.

        Both are best-effort *after* the review is durable: the review is saved
        whether or not the batch counter can be bumped or the robot is
        reachable, because losing a label is worse than losing a count.
        """
        if capture.batch_id:
            capture_store.increment_episodes_recorded(capture.batch_id)
        config = getattr(app.state, "recording_config", None)
        if config is None or not config.transfer.auto_pull_on_save:
            return
        try:
            await importer.pull(capture.capture_id)
            logger.info(
                "importer pull queued", extra={"capture_id": capture.capture_id}
            )
        except ApiError as exc:
            # Single-host deploys have no importer; a robot may be offline. The
            # manual pull and the next save both remain recovery paths.
            logger.warning(
                "importer pull failed",
                extra={"capture_id": capture.capture_id, "error": exc.code},
            )

    # Built before the capture service so a label edit can schedule a
    # regeneration: a capture's operator/task reach views/ whenever the dataset
    # holding it sets none of its own (``list_view_entries`` COALESCEs to them).
    views_refresh = _ViewsRefresher(capture_store, layout)
    capture_service = CaptureService(
        capture_store,
        layout,
        health,
        instance_id=instance_id,
        on_first_review=on_first_review,
        on_views_change=views_refresh.schedule,
    )
    digest = DigestJob(
        capture_store,
        layout,
        health,
        instance_id=instance_id,
        recorder=recorder,
        captures=capture_service,
    )
    record_service = RecordService(
        capture_store,
        layout,
        capture_service,
        recorder,
        recording_config,
        event_hub,
        instance_id=instance_id,
        monitor=monitor,
        digest=digest,
        # A callable, not a value: the Config tab can switch robots at runtime
        # and the NEXT recording must carry the new one into its manifest.
        active_robot=config_catalog.active_robot,
    )
    # Views regeneration runs off the request path: it walks every membership
    # and rebuilds a symlink tree, which a dataset mutation should not wait on.
    # A single-slot flag rather than a task per change — ten rapid edits need
    # one regeneration, not ten, and the last one is the only correct answer.
    batch_service = BatchService(capture_store, layout, instance_id=instance_id)
    dataset_service = DatasetService(
        capture_store,
        layout,
        instance_id=instance_id,
        on_change=views_refresh.schedule,
    )
    dataset_archiver = DatasetArchiver(
        capture_store,
        layout,
        health,
        capture_service,
        instance_id=instance_id,
        on_views_change=views_refresh.schedule,
    )
    reconciler = Reconciler(
        capture_store,
        layout,
        health,
        capture_service,
        digest,
        instance_id=instance_id,
        recorder=recorder,
        on_settle=record_service.settle_adopted,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await event_hub.start()
        # Rebuild (if the index is untrustworthy) and finish any interrupted
        # deletion. A StoreStartupError from here is deliberately NOT caught:
        # an unreadable ledger means a rebuild would resurrect destroyed
        # captures, and starting anyway is the one outcome that cannot be undone.
        report = await bootstrap_store(
            capture_store, prepared, capture_service, recorder=recorder
        )
        if report is not None:
            try:
                # The datasets half of the rebuild. Its warnings join the
                # capture half's in the same store-health list, because an
                # operator looking at "what did this rebuild find" should not
                # have to know the catalog is reconstructed in two passes.
                # Batches first: they are plain rows with no cross-references,
                # and a dataset warning should not be lost to a batch failure.
                health.add_rebuild_warnings(
                    batch_service.restore_from_ledger().warnings
                    + dataset_service.restore_from_ledger().warnings
                )
            except ledger_v2.LedgerUnreadableError as exc:
                # The same refusal bootstrap_store makes, for the same reason
                # and one step later: the dataset replay rebuilds the
                # never-reuse watermark, and a history it cannot read would
                # rebuild no watermark at all. Reached only if the file is
                # damaged between the capture rebuild's read and this one —
                # narrow, but the alternative is a traceback where an operator
                # needs a sentence telling them what to repair.
                raise StoreStartupError(
                    f"{exc}. The dataset history is what records which "
                    "display_index numbers were issued, so rebuilding the "
                    "catalog without it would re-issue numbers that already "
                    "belong to a recording. Restore or repair the ledger, "
                    "then start again."
                ) from exc
        try:
            await record_service.reconcile_on_startup()
        except Exception:  # noqa: BLE001 - never block startup on reconcile
            logger.exception("startup reconciliation failed")
        await reconciler.start()
        yield
        await reconciler.stop()
        # Before the views drain: a finishing archive run schedules one last
        # views refresh, which must still find a refresher to schedule on.
        await dataset_archiver.drain()
        await views_refresh.drain()
        # Let in-flight work finish (and persist) before the HTTP client it may
        # still be using is torn down.
        await record_service.drain_settlements()
        await digest.drain()
        await event_hub.stop()
        if owns_client:
            await client.aclose()

    app.router.lifespan_context = lifespan

    app.state.capture_store = capture_store
    app.state.capture_service = capture_service
    app.state.record_service = record_service
    app.state.dataset_service = dataset_service
    app.state.batch_service = batch_service
    app.state.dataset_archiver = dataset_archiver
    app.state.digest_job = digest
    app.state.reconciler = reconciler
    app.state.views_refresher = views_refresh
    app.state.store_health = health
    app.state.data_layout = layout
    app.state.instance_id = instance_id
    app.state.recorder_client = recorder
    app.state.monitor_client = monitor
    app.state.streamer_client = streamer
    app.state.dora_runner_client = dora_runner
    app.state.importer_client = importer
    # In-flight bag imports. Progress only — the capture row and the bytes on
    # disk are the durable outcome, and both appear only once an import has
    # finalised, so this is safe to lose on restart.
    app.state.import_registry = bag_import.ImportRegistry()
    # In-flight per-capture archives (S2-1: 202 + poll). Progress only, same
    # rationale as the import registry: the ledger and the bytes are durable.
    app.state.capture_archive_runs = CaptureArchiveRuns()
    # Per app, not per module. Two apps built in one process (every test that
    # constructs a second one) would otherwise share both: one app's imports
    # would hold the other's copy slots, and an asyncio.Semaphore binds to the
    # first event loop that awaits it, so the second app's first import would
    # fail with "bound to a different event loop". Constructed here rather than
    # in the lifespan because a Semaphore takes no loop until it is awaited.
    app.state.import_tasks = set()
    app.state.import_copy_slots = asyncio.Semaphore(bag_import.COPY_SLOT_LIMIT)
    app.state.event_hub = event_hub
    app.state.config_catalog = config_catalog
    # Live RECORDING_CONFIG: read at request time by GET /api/v1/config and
    # mutated in place by PUT /api/v1/config/recording, so an edit shows up
    # without a restart.
    app.state.recording_config = recording_config
    app.state.recording_config_path = resolve_config_path(settings.recording_config)
    app.state.stream_config = stream_config
    # Where PUT /api/v1/config/stream writes. Set even when the file is absent
    # (stream_config None) so a first save CREATES it; a config select re-points
    # it (or sets it None for a robot without a stream aspect).
    app.state.stream_config_path = resolve_config_path(settings.stream_config)

    app.include_router(config_router.router)
    app.include_router(record_router.router)
    app.include_router(captures_router.router)
    app.include_router(batches_router.router)
    app.include_router(topics_router.router)
    app.include_router(system_router.router)
    app.include_router(events_router.router)
    app.include_router(pipelines_router.router)
    app.include_router(plans_router.router)
    app.include_router(jobs_router.router)
    app.include_router(validation_router.router)
    app.include_router(validation_router.presets_router)
    app.include_router(files_router.router)
    app.include_router(datasets_router.router)
    app.include_router(store_router.router)
    app.include_router(store_router.views_router)
    app.include_router(retention_router.router)
    app.include_router(transfer_router.router)
    app.include_router(imports_router.router)

    _register_root_and_config(app, settings)
    return app


class _ViewsRefresher:
    """Regenerates ``views/`` in the background, coalescing bursts.

    A dataset edit should not block on a filesystem walk, and a burst of edits
    should not queue a walk each. So a request only sets a flag; one worker
    drains it and regenerates once for however many changes arrived while it
    was busy. The tree is derived state — running it once at the end is not a
    shortcut, it is the same answer for less work.
    """

    def __init__(self, store: CaptureStore, layout) -> None:  # noqa: ANN001
        self._store = store
        self._layout = layout
        self._task: asyncio.Task[None] | None = None
        self._pending = False

    def schedule(self) -> None:
        """Mark the tree stale; start a worker if one is not already running."""
        self._pending = True
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop (a synchronous caller, or a test driving the service
            # directly). The reconciler and the manual refresh endpoint both
            # still rebuild the tree, so this is a deferral, not a loss.
            return
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        while self._pending:
            self._pending = False
            try:
                await asyncio.to_thread(
                    views_mod.regenerate, self._layout, self._store.list_view_entries()
                )
            except Exception:  # noqa: BLE001 - a stale tree must not crash the app
                logger.exception("views regeneration failed")

    async def drain(self) -> None:
        """Await an in-flight regeneration (shutdown, and test determinism)."""
        task = self._task
        if task is not None and not task.done():
            await asyncio.gather(task, return_exceptions=True)


def _config_defaults(
    recording_config: RecordingConfig | None, settings: Settings
) -> dict[str, object]:
    """Build the ``defaults`` block of ``GET /api/v1/config``."""
    if recording_config is None:
        return {
            "expected_hz": {},
            "encoding": "vp8",
            "default_topics": [],
            "ros_domain_id": settings.ros_domain_id,
            "video_playback_rate": settings.video_playback_rate,
        }
    expected_hz = {
        p.pattern: p.hz
        for p in recording_config.expected_hz_patterns
        if p.hz is not None
    }
    return {
        "expected_hz": expected_hz,
        "encoding": "vp8",
        "default_topics": list(recording_config.default_topics),
        "robot_name": recording_config.robot_name,
        "ros_domain_id": settings.ros_domain_id,
        "video_playback_rate": settings.video_playback_rate,
    }


# Static fallback used when dora_runner is unreachable so GET /api/v1/config
# never 500s. Mirrors fast_validation's params_schema (the only form the UI
# strictly needs). Dynamic forms come from dora_runner /pipelines when reachable.
_FALLBACK_PIPELINE_FORMS: dict[str, object] = {
    "fast_validation": {
        "type": "object",
        "required": ["template"],
        "properties": {"template": {"type": "string"}},
    }
}


async def _pipeline_forms(request: Request) -> dict[str, object]:
    """Build ``schemas.pipeline_forms`` from dora_runner's ``/pipelines``."""
    cached = getattr(request.app.state, "pipeline_forms_cache", None)
    if cached:
        return cached
    try:
        body = await request.app.state.dora_runner_client.pipelines()
        items = body.get("items", []) if isinstance(body, dict) else []
        forms = {
            str(item["id"]): (item.get("schema") or {})
            for item in items
            if isinstance(item, dict) and item.get("id")
        }
    except Exception:  # noqa: BLE001 - config must never 500 on a dora outage
        logger.warning("pipeline_forms: dora_runner unreachable; using fallback")
        forms = {}
    if not forms:
        return dict(_FALLBACK_PIPELINE_FORMS)
    request.app.state.pipeline_forms_cache = forms
    return forms


def _stream_payload(stream_config: StreamConfig | None) -> dict[str, object]:
    """Build the ``stream`` block of ``GET /api/v1/config``."""
    if stream_config is None:
        return {"columns": 2, "panes": []}
    return {
        "columns": stream_config.columns,
        "panes": [{"topic": p.topic} for p in stream_config.panes],
    }


def _register_root_and_config(app: FastAPI, settings: Settings) -> None:
    """Register the root and ``GET /api/v1/config``.

    ``defaults`` and ``stream`` are sourced from the LIVE app.state at request
    time, so a Config-tab edit is reflected without a restart.
    """

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME}

    @app.get("/api/v1/config")
    async def runtime_config(request: Request) -> dict[str, object]:
        defaults = _config_defaults(request.app.state.recording_config, settings)
        stream = _stream_payload(getattr(request.app.state, "stream_config", None))
        return {
            "endpoints": {
                "api": "/api/v1",
                "events": "/api/v1/events",
                "webrtc": settings.webrtc_public_url,
            },
            "ice_servers": settings.webrtc_ice_servers,
            # v1's backend-driven tab registry is retired; Console v2 fixes its
            # tabs in the frontend. The empty list stays as a tolerated legacy
            # key so an old client deserializes cleanly.
            "tabs": [],
            "defaults": defaults,
            "stream": stream,
            "schemas": {"pipeline_forms": await _pipeline_forms(request)},
        }
