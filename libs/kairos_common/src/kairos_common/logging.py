"""JSON-lines logging setup shared by all kairos services.

Logs are emitted as one JSON object per line so they aggregate cleanly. Per
``config.md`` log records may carry ``run_id`` / ``component`` / ``request_id``;
those are read from the record's ``extra`` when present.
"""

from __future__ import annotations

import json
import logging
import sys

from kairos_common.time import utc_now_iso8601

# Standard ``LogRecord`` attributes; anything else in ``__dict__`` is treated
# as caller-supplied structured context and merged into the JSON line.
_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__)


class JsonLinesFormatter(logging.Formatter):
    """Format a log record as a single JSON object (one line)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": utc_now_iso8601(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
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
