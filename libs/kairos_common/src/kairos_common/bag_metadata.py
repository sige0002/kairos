"""Topic signature of a recorded bag, derived from its rosbag2 ``metadata.yaml``.

WHY (2026-07-26 ML-consumer review, finding F1): a (task, condition) group is
presented as one dataset, but nothing guaranteed its episodes share an
observation/action space. In the real catalog, one ``Pick_and_Place`` group held
nine ``/hsrb/*`` episodes and two ``/camera/*`` + ``rm_ros_interfaces`` ones —
**zero shared topics**, i.e. two different robots' schemas in one group, with the
UI showing a single success rate over both. That only surfaced at conversion
time, after the download and the converter were already written.

The fix is to make the topic set a first-class, comparable attribute: a stable
hash over the topics the bag ACTUALLY contains, computed once at export and
carried on the catalog row so the UI can say "this group holds 2 topic sets" and
mark the odd episodes out.

The bag's own ``metadata.yaml`` is the source — not ``session.json``'s topic
list (that is what the recorder was ASKED to record, which is exactly the thing
that can silently differ from what landed) and not the MCAP itself (opening a
multi-hundred-MB bag per episode is far too expensive for an index field; the
YAML is a few kB).

The declared robot is deliberately NOT the discriminator: the same real catalog
carries ``batch.robot == "airoa_hsr"`` on episodes whose topics are plainly a
different robot's, so the observed topic set is the only trustworthy identity.

Signature definition (``TOPIC_SIGNATURE_ALGO``, versioned so a future change is
detectable rather than silent):

* the input is every entry of ``topics_with_message_count`` with a **non-zero**
  message count — a subscribed topic that recorded nothing is a MISSING modality
  for training, so it must change the signature rather than hide inside it;
* each topic contributes ``"<name>\\t<type>"``: the type matters as much as the
  name, since the same topic name carrying a different message type is a
  different schema to a converter;
* the pairs are de-duplicated and sorted, joined with ``"\\n"``, and hashed with
  SHA-256, so the signature is stable across machines, orderings and rebuilds.

Unknown stays unknown: a bag with no readable ``metadata.yaml`` (or one whose
metadata carries no topic list at all) yields ``None``, never a fabricated hash
that would make it compare equal to something.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml

# Identity of the hashing rule above. Bump when the rule changes so old and new
# signatures are never compared as if they meant the same thing.
TOPIC_SIGNATURE_ALGO = "sha256/name+type/v1"

METADATA_FILENAME = "metadata.yaml"


class TopicSignature:
    """A bag's topic signature: the stable ``hash`` plus the ``count`` behind it.

    ``count`` is the number of distinct topics that fed the hash (topics with at
    least one message), which the UI shows alongside the set ("7 topics").
    """

    __slots__ = ("hash", "count")

    def __init__(self, hash: str, count: int) -> None:  # noqa: A002 - field name
        self.hash = hash
        self.count = count

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, TopicSignature)
            and other.hash == self.hash
            and other.count == self.count
        )

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"TopicSignature(hash={self.hash[:12]}…, count={self.count})"


def topic_pairs(metadata: dict[str, Any] | None) -> list[str] | None:
    """The ``"<name>\\t<type>"`` pairs a signature is built from, sorted.

    ``None`` when the metadata carries no topic list at all (unknown); an empty
    list is a VALID answer meaning "the bag recorded no messages on any topic" —
    a real, degenerate recording that should compare equal to other empty ones
    and unequal to everything else.
    """
    if not isinstance(metadata, dict):
        return None
    info = metadata.get("rosbag2_bagfile_information")
    root = info if isinstance(info, dict) else metadata
    entries = root.get("topics_with_message_count")
    if not isinstance(entries, list):
        return None
    pairs: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        # A topic that recorded nothing is an absent modality, not a present
        # one: leaving it out is what makes the signature differ.
        try:
            count = int(entry.get("message_count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            continue
        meta = entry.get("topic_metadata")
        if not isinstance(meta, dict):
            continue
        name = meta.get("name")
        if not isinstance(name, str) or not name:
            continue
        type_ = meta.get("type")
        pairs.add(f"{name}\t{type_ if isinstance(type_, str) else ''}")
    return sorted(pairs)


def signature_from_metadata(metadata: dict[str, Any] | None) -> TopicSignature | None:
    """Hash a parsed ``metadata.yaml`` payload; ``None`` when the topics are unknown."""
    pairs = topic_pairs(metadata)
    if pairs is None:
        return None
    digest = hashlib.sha256("\n".join(pairs).encode("utf-8")).hexdigest()
    return TopicSignature(hash=digest, count=len(pairs))


# Ceiling on metadata.yaml (bytes). Generous: the largest bundled sample is a
# few tens of KB, and a 512-topic bag is still well under this.
MAX_METADATA_BYTES = 16 * 1024 * 1024


def read_bag_metadata(bag_dir: Path) -> dict[str, Any] | None:
    """Best-effort parse of ``<bag_dir>/metadata.yaml`` (``None`` on any failure).

    Never raises: a dataset with a lost or malformed metadata file must still
    list and serve — it just has an unknown signature.
    """
    path = Path(bag_dir) / METADATA_FILENAME
    try:
        # A real rosbag2 metadata.yaml is kilobytes. Anything wildly bigger is
        # a damaged or duplicated file (a half-finished copy, a concatenation
        # accident) — parsing it would spend memory proportional to somebody
        # else's mistake, and the answer would be garbage anyway.
        if path.stat().st_size > MAX_METADATA_BYTES:
            return None
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, yaml.YAMLError):
        return None
    return raw if isinstance(raw, dict) else None


def topic_signature(bag_dir: Path) -> TopicSignature | None:
    """The topic signature of the bag in *bag_dir*; ``None`` when it can't be read.

    Cost is one small-YAML parse per episode (single-digit milliseconds), which
    is why this is affordable at export time and during a catalog rebuild.
    """
    return signature_from_metadata(read_bag_metadata(bag_dir))
