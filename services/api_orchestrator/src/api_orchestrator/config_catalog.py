"""Robot-first selectable config catalog for the Config tab.

The config tree is robot-first: ``config/<robot>/<aspect>/<option>.yaml`` for the
committed robots (``airoa_hsr`` / ``template``) and ``config/local/<robot>/...``
for the gitignored ones (e.g. ``<robot>``). The four aspects are ``recording`` /
``stream`` / ``validation`` / ``validators``.

The Config tab flow is **robot -> aspect -> option**: pick the active robot, then
per aspect pick which ``*.yaml`` option is active. Nothing is hardcoded — robots
come from scanning the dirs, options from each aspect dir. Selections are
in-memory (reset to the env defaults on restart); persisting them is future work.

Apply semantics (the router does the hot-swap; see ``routers/config.py``):

- ``recording`` / ``stream`` — selecting hot-swaps the orchestrator's live copy so
  ``GET /api/v1/config`` reflects it at once; recorder QoS / monitor expected_hz
  load at service startup, so those parts fully apply on restart.
- ``validation`` — applies immediately (the active template is injected into
  template-less ``fast_validation`` jobs).
- ``validators`` — informational here; the dora_runner reads its file via
  ``LOSS_REPORT_CONFIG`` at job time, so a switch fully applies on restart.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml
from kairos_common import (
    ApiError,
    ValidationTemplate,
    load_recording_config,
    load_stream_config,
    load_validation_template,
)
from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger("kairos")

# Selectable config aspects (each a subdir of a robot's config dir).
ASPECTS = ("recording", "stream", "validation", "validators")
# Categories POST /config/select accepts: a robot switch, or an aspect option.
SELECTABLE_CATEGORIES = ("robot", *ASPECTS)
# Aspects whose selection applies without a service restart (UI hint).
IMMEDIATE_ASPECTS = ("validation",)
# The conventional default option stem in each aspect dir.
DEFAULT_OPTION = "default"
# Robot-level file (sibling to the aspect dirs) listing one-click validation
# presets for the Validation tab. Not an aspect (not selectable) — a flat list.
PRESETS_FILE = "validation_presets.yaml"


class RobotOption(BaseModel):
    """One selectable robot (a committed or gitignored config/<robot>/ dir)."""

    id: str
    local: bool


class AspectOption(BaseModel):
    """One selectable ``*.yaml`` option within an aspect of the active robot.

    ``meta`` carries a few aspect-specific, display-only fields (topic counts,
    template name/version, stream columns) so the UI can label options without a
    second round-trip. Absent / unparseable files still appear (``meta={}``).
    """

    id: str
    path: str
    local: bool
    meta: dict


class ValidationPreset(BaseModel):
    """A one-click validation defined in ``<robot>/validation_presets.yaml``.

    A preset binds a dora_runner ``pipeline`` to fixed ``params`` under a stable
    ``id``, so the Validation tab can run it against every recording that has not
    been validated by it yet, with no per-preset UI code. ``params`` is passed to
    ``POST /jobs`` verbatim (e.g. ``{template: airoa_hsr}`` for fast_validation).
    """

    id: str = Field(pattern=r"^[a-z0-9_]+$")
    name: str
    description: str = ""
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class ConfigCatalog:
    """Scans the robot-first config tree and holds the active selections."""

    def __init__(
        self,
        config_dir: str | Path,
        config_local_dir: str | Path,
        active_robot: str,
    ) -> None:
        self._root = Path(config_dir)
        self._local_root = Path(config_local_dir)
        self._active_robot = active_robot
        # Per-aspect active option id; absent -> resolved to DEFAULT_OPTION / first.
        self._active_option: dict[str, str] = {}

    # ---- robot scanning ---------------------------------------------------

    def _is_robot_dir(self, d: Path) -> bool:
        return d.is_dir() and any((d / a).is_dir() for a in ASPECTS)

    def _robot_dir(self, robot: str) -> tuple[Path | None, bool]:
        """Resolve a robot id to its dir (committed first, then local)."""
        committed = self._root / robot
        if self._is_robot_dir(committed):
            return committed, False
        local = self._local_root / robot
        if self._is_robot_dir(local):
            return local, True
        return None, False

    def list_robots(self) -> list[RobotOption]:
        """All robots: committed (``config/*``) then gitignored (``config/local/*``)."""
        out: list[RobotOption] = []
        seen: set[str] = set()
        if self._root.is_dir():
            for d in sorted(self._root.iterdir()):
                if d.resolve() == self._local_root.resolve():
                    continue  # the local container is not itself a robot
                if self._is_robot_dir(d) and d.name not in seen:
                    out.append(RobotOption(id=d.name, local=False))
                    seen.add(d.name)
        if self._local_root.is_dir():
            for d in sorted(self._local_root.iterdir()):
                if self._is_robot_dir(d) and d.name not in seen:
                    out.append(RobotOption(id=d.name, local=True))
                    seen.add(d.name)
        return out

    def active_robot(self) -> str:
        return self._active_robot

    # ---- aspect scanning --------------------------------------------------

    def _aspect_files(self, robot: str, aspect: str) -> dict[str, tuple[Path, bool]]:
        """``{option stem: (path, is_local)}`` for ``<robot>/<aspect>/*.yaml``."""
        rdir, local = self._robot_dir(robot)
        if rdir is None:
            return {}
        adir = rdir / aspect
        if not adir.is_dir():
            return {}
        return {p.stem: (p, local) for p in sorted(adir.glob("*.yaml"))}

    def active_option(self, aspect: str) -> str:
        """The resolved active option id for *aspect* of the active robot.

        Falls back to the selected id if still present, else ``default``, else the
        first available; ``""`` when the aspect has no options.
        """
        files = self._aspect_files(self._active_robot, aspect)
        if not files:
            return ""
        chosen = self._active_option.get(aspect)
        if chosen in files:
            return chosen
        if DEFAULT_OPTION in files:
            return DEFAULT_OPTION
        return next(iter(files))

    def resolve_path(self, aspect: str, option_id: str | None = None) -> Path | None:
        """File path of *option_id* (or the active option) in *aspect*."""
        option_id = option_id or self.active_option(aspect)
        entry = self._aspect_files(self._active_robot, aspect).get(option_id)
        return entry[0] if entry else None

    def robot_config_file(self, subdir: str, filename: str) -> Path | None:
        """Absolute path to ``<active_robot>/<subdir>/<filename>`` (committed or
        local base dir), whether or not the file exists yet.

        Used by the config editors for aspects that are a single fixed file
        rather than a selectable ``*.yaml`` option — Signals
        (``signals/default.yaml``) and the monitor alerts
        (``monitoring/alerts.yaml``). The base dir is the active robot's
        committed dir when it has one, else its ``config/local`` dir, so a PUT
        writes back to the same file the robot's own services read. Returns
        ``None`` only when the active robot has no config dir at all (so there is
        nowhere to read or write).
        """
        rdir, _ = self._robot_dir(self._active_robot)
        if rdir is None:
            return None
        return rdir / subdir / filename

    def _option_meta(self, aspect: str, path: Path) -> dict:
        """Best-effort display metadata for an aspect option (never raises)."""
        try:
            if aspect == "recording":
                cfg = load_recording_config(path)
                return {
                    "name": cfg.robot_name or path.stem,
                    "default_topics": len(cfg.default_topics),
                }
            if aspect == "stream":
                cfg = load_stream_config(path)
                return {"columns": cfg.columns, "panes": len(cfg.panes)}
            if aspect == "validation":
                tmpl = load_validation_template(path)
                return {
                    "name": tmpl.name,
                    "version": tmpl.version,
                    "required_topics": [t.model_dump() for t in tmpl.required_topics],
                }
        except (ValueError, OSError) as exc:
            logger.warning(
                "config option failed to load",
                extra={"path": str(path), "aspect": aspect, "error": str(exc)},
            )
        return {}

    def list_aspect(self, aspect: str) -> list[AspectOption]:
        """All options for *aspect* of the active robot (with display metadata)."""
        return [
            AspectOption(
                id=stem,
                path=str(path),
                local=local,
                meta=self._option_meta(aspect, path),
            )
            for stem, (path, local) in self._aspect_files(
                self._active_robot, aspect
            ).items()
        ]

    # ---- read-only robot inspection (GET /config/robots/{robot}) ----------

    def _resolved_option(self, robot: str, aspect: str) -> str | None:
        """The selected/default option id for *aspect* of *robot* (or ``None``).

        For the active robot this honours the in-memory per-aspect pick (like
        :meth:`active_option`); for any other robot there is no selection to
        honour, so it falls back to ``default`` then the first available file.
        """
        files = self._aspect_files(robot, aspect)
        if not files:
            return None
        if robot == self._active_robot:
            chosen = self._active_option.get(aspect)
            if chosen in files:
                return chosen
        if DEFAULT_OPTION in files:
            return DEFAULT_OPTION
        return next(iter(files))

    def _read_yaml_mapping(self, path: Path) -> dict[str, Any] | None:
        """Best-effort parse of a config file to a plain dict (never raises).

        Read-only inspection must not 500 on a file that fails strict schema
        validation, so this returns the raw YAML mapping (or ``None`` when the
        file is unreadable / not a mapping) rather than a validated model.
        """
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            logger.warning(
                "config file failed to parse",
                extra={"path": str(path), "error": str(exc)},
            )
            return None
        return data if isinstance(data, dict) else None

    def describe_robot(self, robot: str) -> dict[str, Any] | None:
        """Read-only view of *robot*'s config, or ``None`` if it is not a known robot.

        For each aspect returns the selected/default file's parsed content (or
        ``None`` when the robot has no file for that aspect), plus a derived
        summary (robot name, default_topics, ros_domain_id if present in the
        recording file). Nothing here mutates the active selection — it is a pure
        inspection of *robot*, active or not.
        """
        if robot not in {r.id for r in self.list_robots()}:
            return None
        aspects: dict[str, dict[str, Any] | None] = {}
        for aspect in ASPECTS:
            option_id = self._resolved_option(robot, aspect)
            if option_id is None:
                aspects[aspect] = None
                continue
            path, is_local = self._aspect_files(robot, aspect)[option_id]
            aspects[aspect] = {
                "id": option_id,
                "path": str(path),
                "local": is_local,
                "content": self._read_yaml_mapping(path),
            }
        recording = aspects.get("recording")
        rec_content = recording["content"] if recording else None
        rec_content = rec_content if isinstance(rec_content, dict) else {}
        topics = rec_content.get("default_topics")
        summary = {
            "robot_name": rec_content.get("robot_name") or robot,
            "default_topics": topics if isinstance(topics, list) else [],
            # Not part of RecordingConfig (ros_domain_id is a global setting), so
            # normally absent; surfaced only if a file actually carries it.
            "ros_domain_id": rec_content.get("ros_domain_id"),
        }
        _, local = self._robot_dir(robot)
        return {
            "robot": robot,
            "local": local,
            "active": robot == self._active_robot,
            "summary": summary,
            "aspects": aspects,
        }

    # ---- selection --------------------------------------------------------

    def select(self, category: str, option_id: str) -> None:
        """Switch the active robot, or an aspect option; 400/404 on bad input."""
        if category not in SELECTABLE_CATEGORIES:
            raise ApiError(
                status_code=400,
                code="unknown_category",
                message=f"Unknown or non-selectable config category: {category}",
            )
        if category == "robot":
            if option_id not in {r.id for r in self.list_robots()}:
                raise ApiError(
                    status_code=404,
                    code="config_not_found",
                    message=f"Robot not found: {option_id}",
                    details={"category": category, "id": option_id},
                )
            self._active_robot = option_id
            # Aspect selections re-resolve against the new robot (active_option
            # falls back to default), so drop stale per-aspect picks.
            self._active_option.clear()
            return
        if option_id not in self._aspect_files(self._active_robot, category):
            raise ApiError(
                status_code=404,
                code="config_not_found",
                message=f"Config not found: {category}/{option_id}",
                details={
                    "category": category,
                    "id": option_id,
                    "robot": self._active_robot,
                },
            )
        self._active_option[category] = option_id

    # ---- validation helpers (used by routers/jobs.py) ---------------------

    def validation_template_by_id(self, option_id: str) -> ValidationTemplate | None:
        """Load the active robot's validation template with id *option_id*."""
        path = self.resolve_path("validation", option_id)
        if path is None:
            return None
        try:
            return load_validation_template(path)
        except (ValueError, OSError):
            return None

    def active_validation_template(self) -> ValidationTemplate | None:
        """Load the active robot's active validation template (best effort)."""
        path = self.resolve_path("validation")
        if path is None:
            return None
        try:
            return load_validation_template(path)
        except (ValueError, OSError):
            return None

    # ---- validation presets (one-click validations) -----------------------

    def _presets_path(self) -> Path | None:
        """Path to the active robot's ``validation_presets.yaml`` (or ``None``)."""
        rdir, _ = self._robot_dir(self._active_robot)
        if rdir is None:
            return None
        path = rdir / PRESETS_FILE
        return path if path.is_file() else None

    def list_validation_presets(self) -> list[ValidationPreset]:
        """Load the active robot's one-click validation presets (best effort).

        Reads ``<robot>/validation_presets.yaml`` (``presets:`` list). A missing
        file yields ``[]``; a single malformed entry is skipped with a warning so
        one typo never hides the rest (mirrors plugin discovery's failure
        isolation). Returns them in file order.
        """
        path = self._presets_path()
        if path is None:
            return []
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError) as exc:
            logger.warning(
                "validation presets failed to load",
                extra={"path": str(path), "error": str(exc)},
            )
            return []
        out: list[ValidationPreset] = []
        seen: set[str] = set()
        for raw in data.get("presets", []) or []:
            try:
                preset = ValidationPreset.model_validate(raw)
            except ValidationError as exc:
                logger.warning(
                    "skipping invalid validation preset",
                    extra={"path": str(path), "error": str(exc)},
                )
                continue
            if preset.id in seen:  # first wins, like the aspect/plugin registries
                logger.warning("duplicate validation preset id: %s", preset.id)
                continue
            seen.add(preset.id)
            out.append(preset)
        return out
