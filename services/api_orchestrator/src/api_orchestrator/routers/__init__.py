"""Feature-based routers for the api_orchestrator public API (``/api/v1``).

Each module is one feature group (``record``, ``captures``), kept loosely coupled
per the spec's recommended router layout. Routers resolve their
:class:`~api_orchestrator.record_service.RecordService` and the capture /
dataset services from ``app.state`` via the dependencies in ``deps.py``.
"""
