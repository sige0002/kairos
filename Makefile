# kairos — convenience targets around docker compose + the test harness.
#
#   make                      # show this help
#   make up                   # start the whole stack (detached) from existing images
#   make rebuild frontend     # apply code changes: build + recreate that service
#   make build monitor        # build one service (positional); `make build` = all
#   make restart monitor orchestrator   # restart service(s)
#
# BUILD vs START are separate on purpose: building needs the network even when
# nothing changed, so `up` never builds — that is what lets the stack come up in
# the field. On a machine that has no images at all, carry them in as a file:
#   make images-save          # where there IS network (robot-images-save for the split)
#   make images-load IMAGES_FILE=kairos-images.tar.gz   # on the offline machine
#   make build-pull           # refresh the upstream base images (needs network)
#   make rosbag-loop          # replay the sample bag on a loop (separate terminal)
#   make table                # live "what's flowing" topic Hz table
#   make smoke                # end-to-end PASS/FAIL check
#   make config-reload        # apply config/*.yaml edits (restart monitor+orchestrator)
#
# Service names are positional: `make build monitor frontend`, `make logs streamer`.
# `make <thing> all` is the same as `make <thing>` (every service).

# ---- config (robot-first) ---------------------------------------------------
# Read a KEY=value from .env. `make` does not read .env by itself (compose
# does), so without this a value set only in .env is invisible to make-derived
# defaults. Precedence: command line > .env > shell env > built-in default.
_env_val = $(if $(wildcard .env),$(strip $(shell sed -n 's/^[[:space:]]*$(1)[[:space:]]*=[[:space:]]*//p' .env | tail -1)))

# Resolve $(1) (a variable name) at that same precedence. Plain `VAR ?= ...`
# can't express "  .env beats shell": `?=` treats a merely-exported shell env
# var as "already set" and skips .env entirely, so a stray `export ROBOT=...`
# left over in someone's shell profile silently wins over the .env this repo
# ships. $(origin) tells apart a genuine `make VAR=x` (highest, left alone)
# from an inherited-but-not-make-set shell var ($($(1)) below still holds it,
# just at lower priority than .env) from unset ($($(1)) is empty).
_prefer_env = $(if $(filter command line,$(origin $(1))),$($(1)),$(or $(call _env_val,$(1)),$($(1)),$(2)))

# A single ROBOT selects the whole config set. compose mounts ./config -> /config,
# so the services read /config/<robot>/{recording,stream,validation,validators}/...
# Committed robots live under config/<robot>/; your own (gitignored) ones under
# config/local/<robot>/ — resolved automatically. Also read from .env so `make`
# and compose agree on the active robot. Override per robot:
#   make up ROBOT=airoa_hsr        # bundled HSR sample (default)
#   make up ROBOT=<robot>          # config/local/<robot>/ (gitignored)
# The airoa_hsr literal is the bundled-sample default, NOT a knob: its single
# source of truth is settings.py (Settings.robot) and compose/compose.yaml repeats it in
# every ${ROBOT:-airoa_hsr} fallback — if the bundled default ever changes, all
# three must move together. Select your own robot via ROBOT (.env or command
# line), never by editing this default.
ROBOT := $(call _prefer_env,ROBOT,airoa_hsr)
export ROBOT
# Resolve committed (config/<robot>) vs local (config/local/<robot>) -> container path.
_ROBOT_REL := $(if $(wildcard config/$(ROBOT)),$(ROBOT),local/$(ROBOT))
RECORDING_CONFIG   ?= /config/$(_ROBOT_REL)/recording/default.yaml
STREAM_CONFIG      ?= /config/$(_ROBOT_REL)/stream/default.yaml
LOSS_REPORT_CONFIG ?= /config/$(_ROBOT_REL)/validators/loss_report.yaml
# full_validation reads its bagflow flows from this DIRECTORY (one file per flow).
BAGFLOW_FLOWS_DIR  ?= /config/$(_ROBOT_REL)/flows
export RECORDING_CONFIG STREAM_CONFIG LOSS_REPORT_CONFIG BAGFLOW_FLOWS_DIR

# Alert rules are OPTIONAL (the monitor runs fine without them). Resolve a local
# override first, then the committed file; empty (= alerts disabled) if neither
# exists. Container path mirrors the ./config -> /config mount (a leading "/" in
# front of the host-relative path). Exported like the paths above so the derived
# value beats a stale ALERT_CONFIG_PATH in .env.
_ALERT_LOCAL     := config/local/$(ROBOT)/monitoring/alerts.yaml
_ALERT_COMMITTED := config/$(ROBOT)/monitoring/alerts.yaml
ALERT_CONFIG_PATH ?= $(if $(wildcard $(_ALERT_LOCAL)),/$(_ALERT_LOCAL),$(if $(wildcard $(_ALERT_COMMITTED)),/$(_ALERT_COMMITTED),))
export ALERT_CONFIG_PATH

# Host uid/gid for the non-root pure-Python services (orchestrator/dora_runner):
# compose runs them as `user: "${UID:-1000}:${GID:-1000}"` so they can write the
# host-owned ./data and ./config bind mounts as the invoking user. bash does NOT
# export UID (and never sets GID), so compose would otherwise fall back to
# 1000:1000 and silently fail to write on a host whose uid != 1000. Derive +
# export them here so every compose invocation below inherits the real values.
UID ?= $(shell id -u)
GID ?= $(shell id -g)
export UID GID

# Host timezone → containers (compose maps TZ through x-ros-env). The recorder
# mints the human-facing run_YYYYMMDD_HHMMSS from ITS clock; without TZ the
# containers sit on UTC and every run name is hours away from the wall clock.
# .env/command line win over the derived value (same precedence as ROBOT).
TZ := $(call _prefer_env,TZ,$(strip $(shell timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)))
export TZ

# Sample bag for the replay harness. Bags live UNDER data/ (the rule), so BAG is
# a path RELATIVE to data/ — e.g. airoa-moma-mcap/000730 -> data/airoa-moma-mcap/000730
# (an absolute /data/... path also works). Set it persistently in .env (BAG=...),
# or per-run: make rosbag BAG=airoa-moma-mcap/000730. Empty here so .env/compose
# supply the default (compose resolves the relative path and the fallback).
BAG ?=

# Ports the access banner advertises (host networking -> these bind on the host).
# Single source of truth = the pydantic defaults in libs/kairos_common/settings.py,
# overridable per key via .env — the SAME keys compose interpolates (FRONTEND_PORT
# / API_ORCH_PORT). Read .env (via _env_val above) so the banner shows the port
# the container actually binds, not a hardcoded literal that drifts from .env.
FRONTEND_PORT := $(call _prefer_env,FRONTEND_PORT,8080)
API_ORCH_PORT := $(call _prefer_env,API_ORCH_PORT,8000)

# Browser-facing base URL for camera (WebRTC) signaling. Default "/webrtc" is the
# same-origin nginx proxy (services/frontend/nginx.conf), so the preview works
# over any access path (LAN IP / SSH tunnel / Tailscale). Exported so it beats a
# stale absolute value in .env (same pattern as RECORDING_CONFIG); compose reads
# it via `environment:`, which overrides env_file. Set an absolute
# http://<host>:8002 only for the legacy direct-connect mode.
WEBRTC_PUBLIC_URL ?= /webrtc
export WEBRTC_PUBLIC_URL

# Release version — single source of truth is the root VERSION file. Exported so
# every `docker compose` invocation below (single-host COMPOSE and the split
# COMPOSE_ROBOT / COMPOSE_RECORDING) tags the kairos-*:${KAIROS_VERSION} images
# instead of the :dev fallback baked into compose/compose.yaml. Cutting a release = bump
# VERSION + update CHANGELOG + git tag (see the README "Releases" section).
KAIROS_VERSION ?= $(if $(wildcard VERSION),$(strip $(shell cat VERSION)),dev)
export KAIROS_VERSION

# Build identity: the commit every image is built from ('-dirty' when the
# worktree differs). Baked in via the shared build-args anchor and stamped
# into capture sidecars by the recorder; sha-only (no timestamp) so the layer
# cache is only busted by an actual new commit.
KAIROS_GIT_SHA ?= $(strip $(shell git describe --always --dirty --abbrev=12 2>/dev/null || echo unknown))
export KAIROS_GIT_SHA

# All deploy compose files live under compose/ (single-host entry =
# compose/compose.yaml). --project-directory pins relative paths (./config,
# ./data, MSGS_OVERLAY_DIR…) to the repo root, not compose/.
# Single-host archive opt-in (capture_store §6.1): the override is appended
# whenever .env sets ARCHIVE_DIR — same auto-wiring as the recording split
# below. (The old COMPOSE_FILE-in-.env wiring is retired: an explicit -f
# always overrode it, which made it a silent-breakage trap.)
ARCHIVE_OVERRIDE_LOCAL := $(if $(wildcard .env),$(shell grep -qE '^[[:space:]]*ARCHIVE_DIR=' .env 2>/dev/null && echo -f compose/archive.yaml),)
# LeRobot exporter opt-in (capture_store §6.2): same auto-wiring as the archive
# override — the overlay is appended whenever .env sets LEROBOT_EXPORTER.
LEROBOT_OVERRIDE_LOCAL := $(if $(wildcard .env),$(shell grep -qE '^[[:space:]]*LEROBOT_EXPORTER=' .env 2>/dev/null && echo -f compose/lerobot.yaml),)
# Where exports land on the host (compose/lerobot.yaml mounts it at
# /data/exports). Resolved here so `up` can pre-create it USER-owned — a bind
# mount Docker has to create itself comes out root-owned, which the uid-1000
# exporter then cannot write.
EXPORTS_DIR_LOCAL := $(if $(wildcard .env),$(shell grep -E '^[[:space:]]*EXPORTS_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2-),)
COMPOSE      := docker compose --project-directory . -f compose/compose.yaml $(ARCHIVE_OVERRIDE_LOCAL) $(LEROBOT_OVERRIDE_LOCAL)
# Let the replay harness read the root .env too (so BAG / ROS_DISTRO / RMW set
# there drive `make rosbag`), when a .env exists.
TEST_COMPOSE := docker compose $(if $(wildcard .env),--env-file .env,) -f deploy/test/compose.yaml

# ROS 2 distro for the images + the custom-message overlay build. Read from
# .env (like ROBOT above) so a robot that needs a different distro can set it
# there once: make exports the value, and an exported value is what compose's
# ${ROS_DISTRO:-jazzy} interpolation sees. Goes through _prefer_env (not a
# plain `?=`) so .env wins over a stray shell export too, same as ROBOT.
ROS_DISTRO := $(call _prefer_env,ROS_DISTRO,jazzy)
export ROS_DISTRO

# Custom-message overlay dir — PER-ROBOT, derived from ROBOT like the config
# paths above: when deploy/msgs_overlay/$(ROBOT)/ exists it is used (and beats a
# stale value in .env, same pattern as RECORDING_CONFIG). This keeps the WHOLE
# harness on the robot's overlay — recorder/monitor/probe mounts AND the rosbag
# replay player: without the overlay `ros2 bag play` silently SKIPS custom-type
# topics ("Ignoring a topic ... package not found", WARN only), so the monitor
# honestly reports them 0 Hz / inactive and it looks like a monitor bug.
# A command-line MSGS_OVERLAY_DIR=... still overrides. MUST start with ./
# (compose treats a bind source without ./ as a named volume). No overlay dir for
# ROBOT (e.g. airoa_hsr — standard types only): empty here + NOT exported, so
# compose reads .env, then falls back to the shared ./deploy/msgs_overlay/robot.
MSGS_OVERLAY_DIR ?= $(if $(wildcard deploy/msgs_overlay/$(ROBOT)),./deploy/msgs_overlay/$(ROBOT),)
ifneq ($(strip $(MSGS_OVERLAY_DIR)),)
export MSGS_OVERLAY_DIR
endif

SERVICES := recorder monitor streamer probe orchestrator dora_runner frontend
# Services named on the command line (e.g. `make build monitor`). Empty = all.
# Override explicitly with SVC=monitor if you prefer.
SVC ?= $(filter $(SERVICES),$(MAKECMDGOALS))

PY_DIRS := libs/kairos_common services/rosbag2_recorder services/topic_monitor \
           services/topic_probe services/webrtc_streamer services/api_orchestrator \
           services/dora_runner services/lerobot_exporter

.DEFAULT_GOAL := help

# ---- compose lifecycle ------------------------------------------------------
# `up` STARTS; it does not build. Building needs the network even when nothing
# changed (BuildKit resolves base images / the Dockerfile frontend), so an `up`
# that always built could not bring the stack up in the field with no network.
# Starting from EXISTING images touches the network not at all.
#
# A missing image is checked LOCALLY first (require_images below) because compose
# reaches for the network either way when one is absent, and neither way says
# what is wrong: plain `up` BUILDS it (needs the registry), and `up --no-build`
# falls back to PULLING `kairos-*` from a registry that does not host them —
# measured: "pull access denied ... repository does not exist", after a round
# trip that simply hangs when there is no network. So we refuse early, on local
# information only, and name the two ways forward.
#
# $(1) = compose invocation, $(2) = the make target that builds this half.
define require_images
	@missing=""; \
	 for img in $$($(1) config --images $(SVC) | sort -u); do \
	   docker image inspect "$$img" >/dev/null 2>&1 || missing="$$missing $$img"; \
	 done; \
	 if [ -n "$$missing" ]; then \
	   echo "not started: this machine has no image for:"; \
	   for m in $$missing; do echo "    $$m"; done; \
	   echo ""; \
	   echo "  with network:     make $(2)"; \
	   echo "  without network:  make images-load IMAGES_FILE=<archive>"; \
	   echo "                    (produced by 'make images-save' on a machine that has them)"; \
	   exit 1; \
	 fi
endef

.PHONY: up up-nobuild down build build-pull rebuild restart logs ps stop urls msgs-build
up: ## start the stack detached, using existing images (RECORDING_CONFIG-aware)
	$(call require_images,$(COMPOSE),build)
	@if [ -n "$(LEROBOT_OVERRIDE_LOCAL)" ]; then mkdir -p "$(or $(EXPORTS_DIR_LOCAL),./data/exports)"; fi
	$(COMPOSE) up -d $(SVC)
	@$(MAKE) --no-print-directory urls

up-nobuild: up ## deprecated alias of `up` (which no longer builds); kept for muscle memory

msgs-build: ## build custom ROS msgs (dir from MSGS_OVERLAY_DIR / .env; per-robot)
	@dir="$(MSGS_OVERLAY_DIR)"; \
	 if [ -z "$$dir" ] && [ -f .env ]; then \
	   dir="$$(sed -n 's/^[[:space:]]*MSGS_OVERLAY_DIR[[:space:]]*=[[:space:]]*//p' .env | tail -1)"; \
	 fi; \
	 dir="$${dir:-./deploy/msgs_overlay/robot}"; \
	 if [ -z "$$(ls -A "$$dir/src" 2>/dev/null)" ]; then \
	   echo "Put message packages in $$dir/src/<pkg>/ (each with package.xml), then re-run."; \
	   echo "(per-robot: set MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot> in .env or on the command line)"; \
	   exit 1; \
	 fi; \
	 echo "Building $$(ls "$$dir/src") into $$dir/install (colcon, recorder image)..."; \
	 docker run --rm -u $$(id -u):$$(id -g) -e HOME=/overlay \
	   -v "$(CURDIR)/$$dir:/overlay" -w /overlay \
	   --entrypoint bash kairos-rosbag2-recorder:$(ROS_DISTRO) -lc \
	   'set -e; source /opt/ros/$(ROS_DISTRO)/setup.bash; colcon build --merge-install' \
	 && echo "OK -> $$dir/install/setup.bash"

urls: ## print the Web UI access URLs (localhost + LAN IPs)
	@echo ""
	@echo "kairos is up — open the Web UI:"
	@echo "  local : http://localhost:$(FRONTEND_PORT)/"
	@hostname -I 2>/dev/null | tr ' ' '\n' \
		| grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$$' \
		| grep -vE '^(127\.|169\.254\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[01]\.)' \
		| while read ip; do echo "  LAN   : http://$$ip:$(FRONTEND_PORT)/"; done
	@echo "  API   : same host, port $(API_ORCH_PORT)"
	@echo "  ssh   : ssh -L $(FRONTEND_PORT):localhost:$(FRONTEND_PORT) -L $(API_ORCH_PORT):localhost:$(API_ORCH_PORT) <user>@<this-host>  # then http://localhost:$(FRONTEND_PORT)/"
	@echo ""

down: ## stop + remove the stack
	$(COMPOSE) down

stop: ## stop the stack (keep containers)
	$(COMPOSE) stop $(SVC)

build: ## build images: `make build` (all) or `make build monitor`
	@# lerobot_exporter vendors rosbag2lerobot as a git submodule; a fresh clone
	@# or worktree has the gitlink but not the files, and a build from that
	@# state bakes an empty package. No-op when submodules are already there.
	@git submodule update --init --recursive
	$(COMPOSE) build $(SVC)

rebuild: ## rebuild + recreate service(s) — the "apply my code changes" command
	@git submodule update --init --recursive
	$(COMPOSE) up -d --build --force-recreate $(SVC)

build-pull: ## rebuild pulling FRESH base images (ros/python/node upstream). NEEDS NETWORK
	$(COMPOSE) build --pull $(SVC)

restart: ## restart service(s): `make restart monitor orchestrator`
	$(COMPOSE) restart $(SVC)

logs: ## follow logs: `make logs` (all) or `make logs streamer`
	$(COMPOSE) logs -f --tail=100 $(SVC)

ps: ## show container status
	$(COMPOSE) ps

# ---- carrying images to a machine with no network ---------------------------
# For a machine that has never built these images (a fresh robot / a field PC),
# `up` has nothing to start from and compose would try to build. Move the built
# images over as a file instead: `make images-save` where there IS network, copy
# the archive across, `make images-load` there, then `make up`.
# The image list comes from `compose config --images`, so it cannot drift from
# the compose files (and each half of the split saves only its own services).
# ARCHITECTURE: images are per-arch. An amd64 archive will NOT run on an arm64
# robot — build there while it has network, or use `docker buildx --platform`.
IMAGES_FILE ?= kairos-images.tar.gz

# $(1) = shell command(s) printing image names, $(2) = label for the log.
define save_images
	@imgs="$$( { $(1); } | sort -u )"; \
	 [ -n "$$imgs" ] || { echo "no images resolved for $(2)"; exit 1; }; \
	 echo "$(2): saving these images -> $(IMAGES_FILE)"; \
	 echo "$$imgs" | sed 's/^/  /'; \
	 docker save $$imgs | gzip > "$(IMAGES_FILE)"; \
	 echo "OK -> $(IMAGES_FILE) ($$(du -h "$(IMAGES_FILE)" | cut -f1))"; \
	 echo "next: copy it over, then on that machine: make images-load IMAGES_FILE=<file>"
endef

.PHONY: images-save images-load robot-images-save recording-images-save
# Includes the replay/inspection harness image (deploy/test/compose.yaml, a
# SEPARATE compose project): `make smoke` / `rosbag` / `table` are exactly what
# you reach for when "nothing comes out" on a machine you just set up, and they
# would otherwise try to build it — i.e. need the network — right when you have
# none. It shares the ROS base layer with the others, so it costs little here.
images-save: ## save ALL stack images + the test harness -> kairos-images.tar.gz (IMAGES_FILE=...)
	$(call save_images,$(COMPOSE) config --images; $(TEST_COMPOSE) config --images,single-host + test harness)

images-load: ## load images from kairos-images.tar.gz (IMAGES_FILE=...) on the offline machine
	@[ -f "$(IMAGES_FILE)" ] || { echo "not found: $(IMAGES_FILE) (set IMAGES_FILE=...)"; exit 1; }
	gunzip -c "$(IMAGES_FILE)" | docker load
	@echo "loaded — now: make up"

# ---- config -----------------------------------------------------------------
# ---- cross-host split (robot-edge / recording-host) -------------------------
# Record image-heavy topics from a SEPARATE PC without loading the robot: the
# DDS-reading services run ON the robot (compose/robot.yaml); orchestrator/dora/
# frontend run on the recording PC (compose/recording.yaml) and never join DDS.
# See docs/specs/ja/deployment_topology.md.
# Split modes read .env.split when it exists (so the single-PC .env stays
# untouched — no clobber-to-switch), else fall back to .env. KAIROS_ENV_FILE is
# exported so compose/compose.yaml's per-service `env_file: ${KAIROS_ENV_FILE:-.env}`
# injects the SAME file into the containers; --env-file feeds ${VAR} interpolation.
SPLIT_ENV := $(if $(wildcard .env.split),.env.split,$(if $(wildcard .env),.env,))
# Archive destination (opt-in, capture_store §6.1). Wired exactly like the
# single-host ARCHIVE_OVERRIDE_LOCAL above: the override is appended whenever
# the split env sets ARCHIVE_DIR (the host half of the pair;
# KAIROS_ARCHIVE_ROOTS is the container half): setting one without the other
# is the exports-vanish-with-the-container trap config.md warns about.
# Robot-edge never mounts it — no orchestrator runs there.
ARCHIVE_OVERRIDE  := $(if $(SPLIT_ENV),$(shell grep -qE '^[[:space:]]*ARCHIVE_DIR=' $(SPLIT_ENV) 2>/dev/null && echo -f compose/archive.yaml),)
# Same anchoring as COMPOSE above: relative paths and the split files'
# `extends: file: compose/compose.yaml` resolve from the repo root.
COMPOSE_ROBOT     := $(if $(SPLIT_ENV),KAIROS_ENV_FILE=$(SPLIT_ENV),) docker compose --project-directory . $(if $(SPLIT_ENV),--env-file $(SPLIT_ENV),) -f compose/robot.yaml
COMPOSE_RECORDING := $(if $(SPLIT_ENV),KAIROS_ENV_FILE=$(SPLIT_ENV),) docker compose --project-directory . $(if $(SPLIT_ENV),--env-file $(SPLIT_ENV),) -f compose/recording.yaml $(ARCHIVE_OVERRIDE)

.PHONY: robot-up robot-down robot-build robot-rebuild robot-restart robot-logs robot-ps robot-config-reload \
        robot-images-save recording-up recording-down recording-build recording-rebuild recording-restart \
        recording-logs recording-ps recording-config-reload recording-images-save import-runs push-config
# All robot-* / recording-* targets take positional service names like the
# single-host ones (e.g. `make robot-rebuild recorder`, `make robot-logs monitor`).
robot-up: ## [ON THE ROBOT] start the robot-edge services (recorder/monitor/streamer/probe)
	$(call require_images,$(COMPOSE_ROBOT),robot-build)
	$(COMPOSE_ROBOT) up -d $(SVC)

robot-down: ## [ON THE ROBOT] stop + remove the robot-edge services
	$(COMPOSE_ROBOT) down

robot-build: ## [ON THE ROBOT] build robot-edge images: `make robot-build` (all) or `make robot-build recorder`
	$(COMPOSE_ROBOT) build $(SVC)

robot-rebuild: ## [ON THE ROBOT] rebuild + recreate robot-edge service(s): `make robot-rebuild recorder`
	$(COMPOSE_ROBOT) up -d --build --force-recreate $(SVC)

robot-restart: ## [ON THE ROBOT] restart robot-edge service(s): `make robot-restart monitor`
	$(COMPOSE_ROBOT) restart $(SVC)

robot-logs: ## [ON THE ROBOT] follow robot-edge logs: `make robot-logs recorder`
	$(COMPOSE_ROBOT) logs -f --tail=100 $(SVC)

robot-ps: ## [ON THE ROBOT] show robot-edge container status
	$(COMPOSE_ROBOT) ps

robot-config-reload: ## [ON THE ROBOT] apply config/*.yaml edits (restart monitor; recorder applies on next record)
	$(COMPOSE_ROBOT) restart monitor

robot-images-save: ## save ONLY the robot-edge images (carry to an offline robot)
	$(call save_images,$(COMPOSE_ROBOT) config --images,robot-edge)

recording-up: ## [ON THE RECORDING PC] start orchestrator/dora/frontend (set *_HOST in .env)
	$(call require_images,$(COMPOSE_RECORDING),recording-build)
	$(COMPOSE_RECORDING) up -d $(SVC)
	@$(MAKE) --no-print-directory urls

recording-down: ## [ON THE RECORDING PC] stop + remove the recording-host services
	$(COMPOSE_RECORDING) down

recording-build: ## [ON THE RECORDING PC] build recording-host images: `make recording-build` (all) or `... frontend`
	$(COMPOSE_RECORDING) build $(SVC)

recording-rebuild: ## [ON THE RECORDING PC] rebuild + recreate recording-host service(s): `make recording-rebuild frontend`
	$(COMPOSE_RECORDING) up -d --build --force-recreate $(SVC)

recording-restart: ## [ON THE RECORDING PC] restart recording-host service(s): `make recording-restart orchestrator`
	$(COMPOSE_RECORDING) restart $(SVC)

recording-logs: ## [ON THE RECORDING PC] follow recording-host logs: `make recording-logs orchestrator`
	$(COMPOSE_RECORDING) logs -f --tail=100 $(SVC)

recording-ps: ## [ON THE RECORDING PC] show recording-host container status
	$(COMPOSE_RECORDING) ps

recording-config-reload: ## [ON THE RECORDING PC] apply config-catalog edits (restart orchestrator)
	$(COMPOSE_RECORDING) restart orchestrator

recording-images-save: ## save ONLY the recording-host images -> kairos-images.tar.gz
	$(call save_images,$(COMPOSE_RECORDING) config --images,recording-host)

import-runs: ## [ON THE RECORDING PC] rsync COMPLETED recordings from the robot into ./data/recorded
	bash deploy/sync/import_runs.sh

push-config: ## [ON THE RECORDING PC] rsync config/local/<ROBOT>/ to the robot's clone (gitignored tree)
	bash deploy/sync/push_config.sh

.PHONY: config-reload config-show
config-reload: ## apply config/*.yaml edits (restart monitor + orchestrator)
	$(COMPOSE) restart monitor orchestrator

config-show: ## print the live GET /api/v1/config defaults
	@curl -fsS --max-time 5 http://localhost:$(API_ORCH_PORT)/api/v1/config \
		| python3 -m json.tool 2>/dev/null || echo "orchestrator not reachable (make up?)"

# ---- backup -----------------------------------------------------------------
# Where snapshots land, and which top-level data/ dirs are RAW SAMPLE INPUTS
# (reproducible source, NOT system state) to exclude. Only the committed sample
# is excluded by default; add your own sample dirs (a local robot's bags are one)
# via the override: `make backup BACKUP_SAMPLE_DIRS="airoa-moma-mcap my-bags"`.
BACKUP_DIR ?= backups
BACKUP_SAMPLE_DIRS ?= airoa-moma-mcap
.PHONY: backup
backup: ## consistent snapshot -> backups/<ts>.tar.gz: DB (.backup) + recordings/reports/datasets/index + config/. See docs/specs/en/config.md (restore).
	@ts=$$(date +%Y%m%d_%H%M%S); out="$(BACKUP_DIR)/$$ts.tar.gz"; \
	mkdir -p "$(BACKUP_DIR)"; tmp=$$(mktemp -d); \
	if [ -f data/kairos.db ]; then \
		if command -v sqlite3 >/dev/null 2>&1; then \
			sqlite3 data/kairos.db ".backup '$$tmp/kairos.db'"; \
		else \
			cp data/kairos.db data/kairos.db-wal data/kairos.db-shm "$$tmp/" 2>/dev/null; \
			cp data/kairos.db "$$tmp/kairos.db"; \
		fi; \
	fi; \
	excl="--exclude=data/kairos.db --exclude=data/kairos.db-wal --exclude=data/kairos.db-shm --exclude=data/report/video_check --exclude=data/.trash --exclude=data/.incoming"; \
	for d in $(BACKUP_SAMPLE_DIRS); do excl="$$excl --exclude=data/$$d"; done; \
	tar czf "$$out" $$excl -C "$$tmp" . -C "$(CURDIR)" config $$( [ -d data ] && echo data ); \
	rm -rf "$$tmp"; \
	echo "backup: wrote $$out (restore: docs/specs/en/config.md 'Operations')"

# ---- test-data replay harness ----------------------------------------------
.PHONY: rosbag rosbag-loop table load smoke smoke-record
rosbag: ## replay a bag under data/ ONCE (BAG=airoa-moma-mcap/000730 to pick another)
	$(if $(BAG),BAG="$(BAG)") $(TEST_COMPOSE) run --rm rosbag_player

rosbag-loop: ## replay a bag under data/ on a LOOP (BAG=... to pick another)
	$(if $(BAG),BAG="$(BAG)") LOOP=--loop $(TEST_COMPOSE) run --rm rosbag_player

table: ## live table of every topic's Hz/bandwidth (the observable view)
	$(TEST_COMPOSE) run --rm topic_table

# Every number with its DENOMINATOR spelled out — `docker stats` alone reports
# 100% = ONE core, so 400% on a 64-thread host reads alarming when it is ~6% of
# the machine, and a NIC's MB/s means nothing without the link speed beside it.
load: ## load overview: CPU (%/core AND %/machine) + NIC throughput/util + live DDS bandwidth + disk
	@bash deploy/load.sh

smoke: ## end-to-end smoke test (health -> config -> discovery -> metrics)
	bash deploy/test/smoke.sh

smoke-record: ## smoke test incl. record start/stop
	RECORD=1 bash deploy/test/smoke.sh

# ---- tests / lint -----------------------------------------------------------
.PHONY: test test-py test-fe lint fmt
test: test-py test-fe ## run all unit tests (Python + frontend)

test-py: ## run the Python unit-test loop (all services + libs)
	@for d in $(PY_DIRS); do \
		printf '### %-32s -> ' "$$d"; \
		(cd "$$d" && uv run --extra test pytest -q 2>&1 | tail -1); \
	done
	@printf '### %-32s -> ' "deploy/sync"; \
	(cd services/api_orchestrator && uv run --extra test pytest -q ../../deploy/sync/tests 2>&1 | tail -1)

test-fe: ## frontend build + test + lint
	cd services/frontend && npm run build && npm test && npm run lint

# ---- UI acceptance (Playwright) ---------------------------------------------
# The capture-store acceptance suite (contract §13). It drives a REAL browser
# against the REAL frontend image, in front of a real orchestrator, recorder,
# dora_runner and a replayed rosbag — so it is the one check that can fail for
# reasons the unit suites cannot see (a service that will not boot, an nginx
# proxy that 502s, a testid that moved).
#
# It runs on its own ports, its own ROS domain and its own data directory
# (e2e/stack.env), so it does not disturb a `make up` stack you have running.
# Every run starts from an empty data dir.
#
#   make test-e2e                          # the whole suite, stack up and down
#   make test-e2e E2E_ARGS='--headed'      # watch it
#   make test-e2e E2E_ARGS=tests/03-discard.spec.ts
#   make test-e2e-up / test-e2e-down       # keep the stack between runs
#
# Images are NOT built here (same rule as `up`): a stale image is a lie an
# acceptance gate must not tell, so run `make build` after changing services/.
.PHONY: test-e2e test-e2e-deps test-e2e-up test-e2e-down
test-e2e: test-e2e-deps ## UI acceptance suite (§13): real browser + real stack + replayed bag
	@bash e2e/scripts/stack.sh up
	@rc=0; (cd e2e && npx playwright test $(E2E_ARGS)) || rc=$$?; \
	 bash e2e/scripts/stack.sh down; \
	 if [ $$rc -ne 0 ]; then \
	   echo "e2e: FAILED — report: e2e/playwright-report/index.html (npx playwright show-report)"; \
	 fi; \
	 exit $$rc

# First run needs the network (npm + the chromium download). On an offline site
# the browser rides in an image instead — see e2e/README.md.
test-e2e-deps:
	@cd e2e && [ -d node_modules ] || npm install
	@cd e2e && npx playwright install chromium

test-e2e-up: test-e2e-deps ## start the e2e stack and leave it up (iterate with `cd e2e && npx playwright test`)
	@bash e2e/scripts/stack.sh up

test-e2e-down: ## stop the e2e stack
	@bash e2e/scripts/stack.sh down

lint: ## ruff check (Python)
	uvx ruff check libs services

fmt: ## ruff format (Python)
	uvx ruff format libs services

# ---- help -------------------------------------------------------------------
.PHONY: help
help: ## show this help
	@echo "kairos — make targets (service names are positional, e.g. 'make build monitor'):"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  RECORDING_CONFIG=$(RECORDING_CONFIG)   BAG=$(if $(BAG),$(BAG),airoa-moma-mcap/235210 (default, under data/))"

# Positional service names (and `all`) are no-op targets so they don't error
# when used as arguments, e.g. `make build monitor` / `make build all`.
.PHONY: $(SERVICES) all
$(SERVICES) all:
	@:
