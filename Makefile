# kairos — convenience targets around docker compose + the test harness.
#
#   make                      # show this help
#   make up                   # build + start the whole stack (detached)
#   make build monitor        # build one service (positional); `make build` = all
#   make restart monitor orchestrator   # restart service(s)
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
# source of truth is settings.py (Settings.robot) and compose.yaml repeats it in
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
export RECORDING_CONFIG STREAM_CONFIG LOSS_REPORT_CONFIG

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
# instead of the :dev fallback baked into compose.yaml. Cutting a release = bump
# VERSION + update CHANGELOG + git tag (see the README "Releases" section).
KAIROS_VERSION ?= $(if $(wildcard VERSION),$(strip $(shell cat VERSION)),dev)
export KAIROS_VERSION

COMPOSE      := docker compose
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
           services/dora_runner

.DEFAULT_GOAL := help

# ---- compose lifecycle ------------------------------------------------------
.PHONY: up up-nobuild down build rebuild restart logs ps stop urls msgs-build
up: ## build + start the stack detached (RECORDING_CONFIG-aware)
	$(COMPOSE) up -d --build $(SVC)
	@$(MAKE) --no-print-directory urls

up-nobuild: ## start the stack detached WITHOUT rebuilding (uses existing images)
	$(COMPOSE) up -d $(SVC)
	@$(MAKE) --no-print-directory urls

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
	$(COMPOSE) build $(SVC)

rebuild: ## rebuild + recreate service(s): `make rebuild frontend`
	$(COMPOSE) up -d --build --force-recreate $(SVC)

restart: ## restart service(s): `make restart monitor orchestrator`
	$(COMPOSE) restart $(SVC)

logs: ## follow logs: `make logs` (all) or `make logs streamer`
	$(COMPOSE) logs -f --tail=100 $(SVC)

ps: ## show container status
	$(COMPOSE) ps

# ---- config -----------------------------------------------------------------
# ---- cross-host split (robot-edge / recording-host) -------------------------
# Record image-heavy topics from a SEPARATE PC without loading the robot: the
# DDS-reading services run ON the robot (compose.robot.yaml); orchestrator/dora/
# frontend run on the recording PC (compose.recording.yaml) and never join DDS.
# See docs/specs/ja/deployment_topology.md.
# Split modes read .env.split when it exists (so the single-PC .env stays
# untouched — no clobber-to-switch), else fall back to .env. KAIROS_ENV_FILE is
# exported so compose.yaml's per-service `env_file: ${KAIROS_ENV_FILE:-.env}`
# injects the SAME file into the containers; --env-file feeds ${VAR} interpolation.
SPLIT_ENV := $(if $(wildcard .env.split),.env.split,$(if $(wildcard .env),.env,))
COMPOSE_ROBOT     := $(if $(SPLIT_ENV),KAIROS_ENV_FILE=$(SPLIT_ENV),) docker compose $(if $(SPLIT_ENV),--env-file $(SPLIT_ENV),) -f compose.robot.yaml
COMPOSE_RECORDING := $(if $(SPLIT_ENV),KAIROS_ENV_FILE=$(SPLIT_ENV),) docker compose $(if $(SPLIT_ENV),--env-file $(SPLIT_ENV),) -f compose.recording.yaml

.PHONY: robot-up robot-down robot-build robot-rebuild robot-restart robot-logs robot-ps robot-config-reload \
        recording-up recording-down recording-build recording-rebuild recording-restart recording-logs \
        recording-ps recording-config-reload import-runs push-config
# All robot-* / recording-* targets take positional service names like the
# single-host ones (e.g. `make robot-rebuild recorder`, `make robot-logs monitor`).
robot-up: ## [ON THE ROBOT] build + start the robot-edge services (recorder/monitor/streamer/probe)
	$(COMPOSE_ROBOT) up -d --build $(SVC)

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

recording-up: ## [ON THE RECORDING PC] build + start orchestrator/dora/frontend (set *_HOST in .env)
	$(COMPOSE_RECORDING) up -d --build $(SVC)
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
# (reproducible source, NOT system state) to exclude. Override to match your
# sample layout: `make backup BACKUP_SAMPLE_DIRS="airoa-moma-mcap my-bags"`.
BACKUP_DIR ?= backups
BACKUP_SAMPLE_DIRS ?= airoa-moma-mcap realman
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
	excl="--exclude=data/kairos.db --exclude=data/kairos.db-wal --exclude=data/kairos.db-shm --exclude=data/report/video_check"; \
	for d in $(BACKUP_SAMPLE_DIRS); do excl="$$excl --exclude=data/$$d"; done; \
	tar czf "$$out" $$excl -C "$$tmp" . -C "$(CURDIR)" config $$( [ -d data ] && echo data ); \
	rm -rf "$$tmp"; \
	echo "backup: wrote $$out (restore: docs/specs/en/config.md 'Operations')"

# ---- test-data replay harness ----------------------------------------------
.PHONY: rosbag rosbag-loop table smoke smoke-record
rosbag: ## replay a bag under data/ ONCE (BAG=airoa-moma-mcap/000730 to pick another)
	$(if $(BAG),BAG="$(BAG)") $(TEST_COMPOSE) run --rm rosbag_player

rosbag-loop: ## replay a bag under data/ on a LOOP (BAG=... to pick another)
	$(if $(BAG),BAG="$(BAG)") LOOP=--loop $(TEST_COMPOSE) run --rm rosbag_player

table: ## live table of every topic's Hz/bandwidth (the observable view)
	$(TEST_COMPOSE) run --rm topic_table

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

test-fe: ## frontend build + test + lint
	cd services/frontend && npm run build && npm test && npm run lint

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
