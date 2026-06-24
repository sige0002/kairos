"""Feature-based routers for the api_orchestrator public API (``/api/v1``).

Each module is one feature group (``record``, ``runs``), kept loosely coupled
per the spec's recommended router layout. Routers resolve their
:class:`~api_orchestrator.runs.RunService` from ``app.state`` via a dependency.
"""
