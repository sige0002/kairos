"""The dataset lifecycle ledger: what left the catalog, when, and where to.

An exported dataset can leave ``data/<operator>/<task>/<NNN>/`` two ways — it is
**archived** to a storage server, or it is **deleted** because the recording was
no good. Both make it vanish from the Datasets tab, which is exactly what an
operator wants and exactly what makes the next question unanswerable: *where did
episode 011 go?* Until now nothing recorded either event, and on 2026-07-26 that
cost an hour of forensics for runs that simply were not there any more.

So every departure appends one line here, and two properties follow from it.

**The number is never reused.** ``dataset_export`` allocates ``NNN`` as
``max(existing directories) + 1``. Move ``003`` to a NAS and the directory is
gone, so the next export claims ``003`` again — two different recordings wearing
one path, and a manifest that pinned ``.../003`` months ago silently resolves to
the wrong data with no error anywhere. The allocator therefore takes its
high-water mark from the filesystem **and** this ledger, so a retired number
stays retired. A gap in the numbering is information: "003 existed and left".

**The catalog does not pay for history.** This is a separate file that the
Datasets UI never reads: archiving ten thousand episodes adds nothing to
``index.jsonl`` or to the catalog response. A ledger line is ~200 bytes against
a catalog row's ~570, and it is append-only — no rewrite, no compaction.

Format: JSON Lines at ``<data_dir>/lifecycle.jsonl``, newest last. Unreadable
lines are skipped rather than fatal; a ledger that cannot be parsed must not
stop an export, but it must also never silently lower the high-water mark, which
is why :func:`retired_indices` treats a read failure as "no information" and the
caller keeps the filesystem's own maximum.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from kairos_common.time import utc_now_iso8601

logger = logging.getLogger("kairos")

LEDGER_NAME = "lifecycle.jsonl"

# Why a dataset left the catalog. `archived` = the bytes live on somewhere the
# operator chose; `deleted` = the bytes are gone. Both retire the number.
LifecycleEvent = Literal["archived", "deleted"]


@dataclass(frozen=True)
class LedgerEntry:
    """One departure from the catalog."""

    event: LifecycleEvent
    operator: str
    task: str
    index: str
    run_id: str | None = None
    # Where the data went (archive only): the absolute destination path.
    destination: str | None = None
    # Why it went (delete especially — a ledger without a reason answers "when"
    # but not "should this have happened", which is the question people ask).
    reason: str | None = None
    # Carried forward so an archived episode stays identifiable without the bag:
    # the topic signature is what tells you which embodiment it was.
    topics_hash: str | None = None
    topic_count: int | None = None
    bytes: int | None = None
    message_count: int | None = None
    at: str | None = None

    def to_json(self) -> dict[str, Any]:
        record = {
            "event": self.event,
            "operator": self.operator,
            "task": self.task,
            "index": self.index,
            "at": self.at or utc_now_iso8601(),
        }
        optional = {
            "run_id": self.run_id,
            "destination": self.destination,
            "reason": self.reason,
            "topics_hash": self.topics_hash,
            "topic_count": self.topic_count,
            "bytes": self.bytes,
            "message_count": self.message_count,
        }
        record.update({k: v for k, v in optional.items() if v is not None})
        return record


def ledger_path(data_dir: Path) -> Path:
    return Path(data_dir) / LEDGER_NAME


def append(data_dir: Path, entry: LedgerEntry) -> None:
    """Append one entry. Raises ``OSError`` — a departure that cannot be
    recorded must fail loudly, or the number would be quietly reusable."""
    path = ledger_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry.to_json(), ensure_ascii=False) + "\n")


def read_all(data_dir: Path) -> list[dict[str, Any]]:
    """Every ledger entry, oldest first. Missing file = empty; bad lines skipped."""
    path = ledger_path(data_dir)
    if not path.is_file():
        return []
    entries: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("lifecycle ledger unreadable", extra={"error": str(exc)})
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            entries.append(record)
    return entries


def retired_indices(data_dir: Path, operator: str, task: str) -> set[int]:
    """Numeric ``NNN`` values this (operator, task) has already used and released.

    Only well-formed numeric indices count: a malformed line must not be able to
    inflate the high-water mark and skip a whole block of numbers.
    """
    retired: set[int] = set()
    for record in read_all(data_dir):
        if record.get("operator") != operator or record.get("task") != task:
            continue
        raw = record.get("index")
        if isinstance(raw, str) and raw.isdigit():
            retired.add(int(raw))
        elif isinstance(raw, int):
            retired.add(raw)
    return retired


def find(data_dir: Path, operator: str, task: str, index: str) -> dict[str, Any] | None:
    """The most recent ledger entry for one dataset path — "where did it go?"."""
    match = None
    for record in read_all(data_dir):
        if (
            record.get("operator") == operator
            and record.get("task") == task
            and str(record.get("index")) == str(index)
        ):
            match = record
    return match
