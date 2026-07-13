"""JSON-lines logging setup shared by all kairos services.

Logs are emitted as one JSON object per line so they aggregate cleanly. Per
``config.md`` log records may carry ``run_id`` / ``component`` / ``request_id``;
those are read from the record's ``extra`` when present.
"""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar, Token

from kairos_common.time import utc_now_iso8601

# Standard ``LogRecord`` attributes; anything else in ``__dict__`` is treated
# as caller-supplied structured context and merged into the JSON line.
_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)

# Per-request correlation id. The request-id middleware (see ``app.py``) sets
# this for the duration of each request so every log line emitted while handling
# it carries the same ``request_id`` — without threading the value through every
# call. Contextvars are async-task-local, so concurrent requests never share it.
_request_id_var: ContextVar[str | None] = ContextVar("kairos_request_id", default=None)


def set_request_id(request_id: str | None) -> Token[str | None]:
    """Bind *request_id* to the current context; returns a reset token."""
    return _request_id_var.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    """Restore the request-id context to its pre-:func:`set_request_id` value."""
    _request_id_var.reset(token)


def get_request_id() -> str | None:
    """Return the request id bound to the current context, if any."""
    return _request_id_var.get()


class JsonLinesFormatter(logging.Formatter):
    """Format a log record as a single JSON object (one line)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": utc_now_iso8601(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Per-request correlation id from the contextvar (config.md: log records
        # carry request_id). Added before extras so an explicit
        # ``extra={"request_id": ...}`` on a call site still wins.
        request_id = _request_id_var.get()
        if request_id is not None:
            payload["request_id"] = request_id
        # Merge structured context passed via logger.info(..., extra={...}).
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON-lines formatter on the root logger.

    Idempotent: replaces existing handlers so repeated calls (e.g. in tests)
    do not stack duplicate output.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLinesFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
