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
# A single ROBOT selects the whole config set. compose mounts ./config -> /config,
# so the services read /config/<robot>/{recording,stream,validation,validators}/...
# Committed robots live under config/<robot>/; your own (gitignored) ones under
# config/local/<robot>/ — resolved automatically. Override per robot:
#   make up ROBOT=airoa_hsr        # bundled HSR sample (default)
#   make up ROBOT=<robot>          # config/local/<robot>/ (gitignored)
ROBOT ?= airoa_hsr
export ROBOT
# Resolve committed (config/<robot>) vs local (config/local/<robot>) -> container path.
_ROBOT_REL := $(if $(wildcard config/$(ROBOT)),$(ROBOT),local/$(ROBOT))
RECORDING_CONFIG   ?= /config/$(_ROBOT_REL)/recording/default.yaml
STREAM_CONFIG      ?= /config/$(_ROBOT_REL)/stream/default.yaml
LOSS_REPORT_CONFIG ?= /config/$(_ROBOT_REL)/validators/loss_report.yaml
export RECORDING_CONFIG STREAM_CONFIG LOSS_REPORT_CONFIG

# Sample bag for the replay harness. Bags live UNDER data/ (the rule), so BAG is
# a path RELATIVE to data/ — e.g. airoa-moma-mcap/000730 -> data/airoa-moma-mcap/000730
# (an absolute /data/... path also works). Set it persistently in .env (BAG=...),
# or per-run: make rosbag BAG=airoa-moma-mcap/000730. Empty here so .env/compose
# supply the default (compose resolves the relative path and the fallback).
BAG ?=

# Ports the access banner advertises (host networking -> these bind on the host).
FRONTEND_PORT ?= 8080
API_PORT      ?= 8000

# Browser-facing base URL for camera (WebRTC) signaling. Default "/webrtc" is the
# same-origin nginx proxy (services/frontend/nginx.conf), so the preview works
# over any access path (LAN IP / SSH tunnel / Tailscale). Exported so it beats a
# stale absolute value in .env (same pattern as RECORDING_CONFIG); compose reads
# it via `environment:`, which overrides env_file. Set an absolute
# http://<host>:8002 only for the legacy direct-connect mode.
WEBRTC_PUBLIC_URL ?= /webrtc
export WEBRTC_PUBLIC_URL

COMPOSE      := docker compose
# Let the replay harness read the root .env too (so BAG / ROS_DISTRO / RMW set
# there drive `make rosbag`), when a .env exists.
TEST_COMPOSE := docker compose $(if $(wildcard .env),--env-file .env,) -f deploy/test/compose.yaml

# ROS 2 distro for the images + the custom-message overlay build.
ROS_DISTRO ?= jazzy
export ROS_DISTRO

# Custom-message overlay dir — env-driven & PER-ROBOT. Set it in .env so a robot's
# overlay is picked automatically, e.g.:
#   MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>      # in .env
# `make up` reads it via compose; `make msgs-build` builds that same dir. A
# command-line MSGS_OVERLAY_DIR=... overrides .env. MUST start with ./ (compose
# treats a bind source without ./ as a named volume). Default (unset): the shared
# ./deploy/msgs_overlay. Exported ONLY when explicitly set, so an unset value lets
# compose read .env instead of being clobbered by a make default.
MSGS_OVERLAY_DIR ?=
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
	@echo "  API   : same host, port $(API_PORT)"
	@echo "  ssh   : ssh -L $(FRONTEND_PORT):localhost:$(FRONTEND_PORT) -L $(API_PORT):localhost:$(API_PORT) <user>@<this-host>  # then http://localhost:$(FRONTEND_PORT)/"
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
COMPOSE_ROBOT     := docker compose $(if $(wildcard .env),--env-file .env,) -f compose.robot.yaml
COMPOSE_RECORDING := docker compose $(if $(wildcard .env),--env-file .env,) -f compose.recording.yaml

.PHONY: robot-up robot-down robot-build robot-rebuild robot-restart robot-logs robot-ps robot-config-reload \
        recording-up recording-down recording-build recording-rebuild recording-restart recording-logs \
        recording-ps recording-config-reload import-runs
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

.PHONY: config-reload config-show
config-reload: ## apply config/*.yaml edits (restart monitor + orchestrator)
	$(COMPOSE) restart monitor orchestrator

config-show: ## print the live GET /api/v1/config defaults
	@curl -fsS --max-time 5 http://localhost:$(API_PORT)/api/v1/config \
		| python3 -m json.tool 2>/dev/null || echo "orchestrator not reachable (make up?)"

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
