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
LIVE_CONFIG        ?= /config/$(_ROBOT_REL)/live/default.yaml
LOSS_REPORT_CONFIG ?= /config/$(_ROBOT_REL)/validators/loss_report.yaml
export RECORDING_CONFIG STREAM_CONFIG LIVE_CONFIG LOSS_REPORT_CONFIG

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

SERVICES := recorder monitor streamer probe orchestrator dora_runner frontend dora_live
# Services named on the command line (e.g. `make build monitor`). Empty = all.
# Override explicitly with SVC=monitor if you prefer.
SVC ?= $(filter $(SERVICES),$(MAKECMDGOALS))

# ---- dora_live switchover (LIVE=1) ------------------------------------------
# One knob, same pattern as ROBOT: `make up LIVE=1` (or LIVE=1 in .env) runs
# the stack with dora_live REPLACING the legacy live trio (monitor/probe/
# streamer). It enables the compose `live` profile, pins the shared bind/proxy
# port vars to the dora_live values (exported here, so they beat .env in
# compose interpolation), stops the trio, and excludes it from the default
# service set. A plain `make up` (LIVE unset/0) restores the legacy stack and
# stops dora_live. The trio cannot be managed positionally while LIVE=1 —
# their bind ports would collide (probe would bind 8006) or their healthchecks
# would probe dora_live's ports.
# LIVE resolves like ROBOT (cmdline > .env > shell) and additionally falls
# back to .env.split — the split entry points read that file, so putting
# LIVE=1 there makes the cutover sticky per host: a plain `make robot-up` /
# `make recording-up` then stays in live mode instead of silently reviving
# the legacy trio / stopping dora_live (audit finding).
_LIVE_SPLIT_DEFAULT := $(if $(wildcard .env.split),$(strip $(shell sed -n 's/^[[:space:]]*LIVE[[:space:]]*=[[:space:]]*//p' .env.split | tail -1)),)
LIVE := $(call _prefer_env,LIVE,$(or $(_LIVE_SPLIT_DEFAULT),0))
LIVE_LEGACY := monitor probe streamer
ifeq ($(LIVE),1)
ifneq ($(filter $(LIVE_LEGACY),$(SVC)),)
$(error LIVE=1 replaces "$(LIVE_LEGACY)" with dora_live — manage them only without LIVE=1)
endif
export COMPOSE_PROFILES := live
export TOPIC_MONITOR_PORT := 8005
export TOPIC_PROBE_PORT := 8006
export WEBRTC_PORT := 8007
# Split placement: dora_live is a ROBOT-EDGE service (compose.robot.yaml), the
# same topology as the legacy trio it replaces — live topics never cross the
# wire as DDS. The recording PC's proxy targets keep the .env.split robot-IP
# HOSTs; only the ports above move to the dora_live values.
_UP_SVC := $(if $(SVC),$(SVC),$(filter-out $(LIVE_LEGACY),$(SERVICES)))
# Robot-edge default set under LIVE=1: recorder + dora_live (dora_live
# replaces the trio ON the robot; heavy analysis stays in recording-side
# dora_runner).
_ROBOT_UP_SVC := $(if $(SVC),$(SVC),recorder dora_live)
else
_UP_SVC := $(SVC)
_ROBOT_UP_SVC := $(SVC)
endif

PY_DIRS := libs/kairos_common services/rosbag2_recorder services/topic_monitor \
           services/topic_probe services/webrtc_streamer services/api_orchestrator \
           services/dora_live \
           services/dora_runner

.DEFAULT_GOAL := help

# ---- compose lifecycle ------------------------------------------------------
.PHONY: up up-nobuild down build rebuild restart logs ps stop urls msgs-build
up: ## build + start the stack detached (LIVE=1 = dora_live replaces monitor/probe/streamer)
	@$(_LIVE_SWAP)
	$(COMPOSE) up -d --build $(_UP_SVC)
	@$(MAKE) --no-print-directory urls
	@$(MAKE) --no-print-directory _ext-autostart LIVE=$(LIVE)

up-nobuild: ## start the stack detached WITHOUT rebuilding (uses existing images)
	@$(_LIVE_SWAP)
	$(COMPOSE) up -d $(_UP_SVC)
	@$(MAKE) --no-print-directory urls
	@$(MAKE) --no-print-directory _ext-autostart LIVE=$(LIVE)

# up/up-nobuild pre-step: entering LIVE mode stops the legacy trio; leaving it
# stops dora_live (if it exists). Keeps `make up LIVE=1` <-> `make up` a true
# toggle with no stale backend left serving.
ifeq ($(LIVE),1)
_LIVE_SWAP = $(COMPOSE) stop $(LIVE_LEGACY) 2>/dev/null || true
else
_LIVE_SWAP = COMPOSE_PROFILES=live $(COMPOSE) stop dora_live 2>/dev/null || true
endif

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

down: ## stop + remove the stack (always includes dora_live AND every extension sidecar)
	COMPOSE_PROFILES=live $(COMPOSE) down
	@$(MAKE) --no-print-directory ext-sweep-down

stop: ## stop the stack (keep containers)
	$(COMPOSE) stop $(SVC)

build: ## build images: `make build` (all) or `make build monitor`
	$(COMPOSE) build $(SVC)

rebuild: ## rebuild + recreate service(s): `make rebuild frontend`
	$(COMPOSE) up -d --build --force-recreate $(SVC)

restart: ## restart service(s): `make restart monitor orchestrator`
	$(COMPOSE) restart $(_UP_SVC)

logs: ## follow logs: `make logs` (all) or `make logs streamer`
	$(COMPOSE) logs -f --tail=100 $(SVC)

ps: ## show container status (main stack + extension sidecars)
	$(COMPOSE) ps
	@if docker ps -a --filter name=kairos-ext- --format '{{.Names}}' | grep -q .; then \
	  echo ""; $(MAKE) --no-print-directory ext-ps; \
	fi

load: ## load overview: CPU (%/core AND %/machine) + LAN throughput/util + live DDS bandwidth + data disk
	@bash deploy/load.sh

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
robot-up: ## [ON THE ROBOT] build + start the robot-edge services (LIVE=1 = recorder + dora_live)
	@$(if $(filter 1,$(LIVE)),$(COMPOSE_ROBOT) stop $(LIVE_LEGACY) 2>/dev/null || true,COMPOSE_PROFILES=live $(COMPOSE_ROBOT) stop dora_live 2>/dev/null || true)
	$(COMPOSE_ROBOT) up -d --build $(_ROBOT_UP_SVC)

robot-down: ## [ON THE ROBOT] stop + remove the robot-edge services (always includes dora_live)
	COMPOSE_PROFILES=live $(COMPOSE_ROBOT) down

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

robot-config-reload: ## [ON THE ROBOT] apply config/*.yaml edits (restart monitor / dora_live under LIVE=1; recorder applies on next record)
	$(if $(filter 1,$(LIVE)),$(COMPOSE_ROBOT) restart dora_live,$(COMPOSE_ROBOT) restart monitor)

recording-up: ## [ON THE RECORDING PC] build + start orchestrator/dora/frontend (+ extension sidecars, robot-targeted)
	$(COMPOSE_RECORDING) up -d --build --remove-orphans $(SVC)
	@$(MAKE) --no-print-directory urls
	@$(MAKE) --no-print-directory _ext-autostart-recording

# Split sweep: sidecars run HERE (recording PC — the designed off-robot
# placement) but pull from the robot's dora_live. The target host is read from
# the split env with the repo's self-referential pattern expanded EXPLICITLY
# (TOPIC_MONITOR_HOST=$${ROBOT_IP} — a plain sed would yield the literal
# "$${ROBOT_IP}", and sourcing the file trips on its readonly UID= line; both
# adversarial-review findings). The port is LIVE-aware: under LIVE=1 make
# resolves 8005 (dora_live) regardless of the split file's legacy 8001.
.PHONY: _ext-autostart-recording
_ext-autostart-recording:
	@tmh=""; tmp=""; \
	 if [ -n "$(SPLIT_ENV)" ]; then \
	   robot_ip=$$(sed -n 's/^[[:space:]]*ROBOT_IP[[:space:]]*=[[:space:]]*//p' $(SPLIT_ENV) | tail -1); \
	   tmh=$$(sed -n 's/^[[:space:]]*TOPIC_MONITOR_HOST[[:space:]]*=[[:space:]]*//p' $(SPLIT_ENV) | tail -1); \
	   tmp=$$(sed -n 's/^[[:space:]]*TOPIC_MONITOR_PORT[[:space:]]*=[[:space:]]*//p' $(SPLIT_ENV) | tail -1); \
	   tmh=$$(printf '%s' "$$tmh" | sed "s|\$$\{ROBOT_IP\}|$$robot_ip|g; s|\$$ROBOT_IP|$$robot_ip|g"); \
	 fi; \
	 $(if $(filter 1,$(LIVE)),tmp=8005;,) \
	 url="http://$${tmh:-127.0.0.1}:$${tmp:-8005}"; \
	 for e in $(_EXT_LIVE_AUTO); do \
	   if DORA_LIVE_URL="$$url" docker compose -p "kairos-ext-$$e" -f "extensions/$$e/live/compose.yaml" up -d >/dev/null 2>&1; then \
	     echo "ext-live: $$e up (pulling $$url)"; \
	   else \
	     echo "WARN: extension '$$e' failed to start (main stack unaffected) — full error: make ext-live EXT=$$e"; \
	   fi; \
	 done

recording-down: ## [ON THE RECORDING PC] stop + remove the recording-host services (+ extension sidecars)
	$(COMPOSE_RECORDING) down
	@$(MAKE) --no-print-directory ext-sweep-down

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

recording-config-reload: ## [ON THE RECORDING PC] apply config-catalog edits (restart orchestrator; live config lives with robot-side dora_live)
	$(COMPOSE_RECORDING) restart orchestrator

import-runs: ## [ON THE RECORDING PC] rsync COMPLETED recordings from the robot into ./data/recorded
	bash deploy/sync/import_runs.sh

push-config: ## [ON THE RECORDING PC] rsync config/local/<ROBOT>/ to the robot's clone (gitignored tree)
	bash deploy/sync/push_config.sh

.PHONY: config-reload config-show
config-reload: ## apply config/*.yaml edits (restart monitor + orchestrator; dora_live under LIVE=1)
	$(COMPOSE) restart $(if $(filter 1,$(LIVE)),dora_live,monitor) orchestrator

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

# ---- user extensions (extensions/README.md) ---------------------------------
# Live-lane sidecars AUTO-START with the stack (team-debated, user-ratified
# model: consent = the folder's presence, mirroring the validation lane).
# `_`-prefixed dirs (_template, _examples) never auto-start; a per-extension
# opt-out is a top-level `x-kairos-autostart: false` line in its
# live/compose.yaml. `robot-up` NEVER sweeps (robot-budget ruling) — starting
# a sidecar ON the robot stays a deliberate manual `make ext-live`.
_EXT_LIVE_ALL := $(patsubst extensions/%/live/compose.yaml,%,$(wildcard extensions/*/live/compose.yaml))
_EXT_LIVE_AUTO = $(strip $(foreach e,$(filter-out _%,$(_EXT_LIVE_ALL)),$(if $(shell grep -Ei '^x-kairos-autostart:[[:space:]]*["'"'"']?false' "extensions/$(e)/live/compose.yaml" 2>/dev/null),,$(e))))

.PHONY: ext-live ext-live-down ext-sweep-up ext-sweep-down ext-reload ext-ps _ext-autostart
ext-live: ## start ONE extension sidecar manually (EXT=<name>; the auto path is plain `make up`)
	@test -n "$(EXT)" || { echo "usage: make ext-live EXT=<name>"; exit 2; }
	@test -d "extensions/$(EXT)/live" || { echo "extensions/$(EXT)/live not found (see extensions/README.md)"; exit 2; }
	docker compose -p "kairos-ext-$(EXT)" -f "extensions/$(EXT)/live/compose.yaml" up -d

ext-live-down: ## stop ONE extension sidecar (EXT=<name>)
	@test -n "$(EXT)" || { echo "usage: make ext-live-down EXT=<name>"; exit 2; }
	@test -d "extensions/$(EXT)/live" || { echo "extensions/$(EXT)/live not found"; exit 2; }
	docker compose -p "kairos-ext-$(EXT)" -f "extensions/$(EXT)/live/compose.yaml" down

ext-sweep-up: ## start every auto-start extension sidecar (failure is per-extension, never the stack's)
	@for e in $(_EXT_LIVE_AUTO); do \
	  if docker compose -p "kairos-ext-$$e" -f "extensions/$$e/live/compose.yaml" up -d >/dev/null 2>&1; then \
	    echo "ext-live: $$e up"; \
	  else \
	    echo "WARN: extension '$$e' failed to start (main stack unaffected) — full error: make ext-live EXT=$$e"; \
	  fi; \
	done

# Scoped to THIS checkout via the compose working_dir label — parallel kairos
# worktrees (a real workflow here) must not tear down each other's sidecars.
# Also removes sidecars whose extension folder was deleted (label persists).
ext-sweep-down: ## remove this checkout's kairos-ext-* sidecars (deleted folders included)
	@docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}' \
	  | awk -F'\t' -v wd="$(CURDIR)/extensions/" '$$2 ~ /^kairos-ext-/ && index($$3, wd) == 1 {print $$1}' \
	  | xargs -r docker rm -f -v >/dev/null 2>&1 || true

ext-reload: ## apply extension CODE edits (restart; compose.yaml changes need make ext-live / recording-up)
	@for e in $(_EXT_LIVE_AUTO); do \
	  docker compose -p "kairos-ext-$$e" -f "extensions/$$e/live/compose.yaml" restart >/dev/null 2>&1 \
	    && echo "ext-live: $$e reloaded" \
	    || echo "WARN: extension '$$e' failed to reload — full error: make ext-live EXT=$$e"; \
	done
	# restart (not recreate) is deliberate: it preserves the container env —
	# including the robot-targeted DORA_LIVE_URL recording-up derived — and the
	# template entrypoint re-copies /ext on every start, so node.py edits apply.

ext-ps: ## show extension sidecar containers
	@docker ps -a --filter name=kairos-ext- --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'

_ext-autostart: # internal: called by up/up-nobuild after the main stack is up
ifeq ($(LIVE),1)
	@$(MAKE) --no-print-directory ext-sweep-up
else
	@if [ -n "$(_EXT_LIVE_AUTO)" ]; then \
	  echo "NOTE: live extensions present ($(_EXT_LIVE_AUTO)) but LIVE=0 — the live seam needs dora_live (make up LIVE=1); not started"; \
	fi
endif

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
