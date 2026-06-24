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

# ---- config -----------------------------------------------------------------
# Default the recording/monitoring config to the bundled HSR sample so the stack
# works out of the box (overrides the stale value in .env). Override per robot:
#   make up RECORDING_CONFIG=/config/myrobot.yaml
RECORDING_CONFIG ?= /config/airoa_hsr.yaml
export RECORDING_CONFIG

# Sample bag for the replay harness; override: make rosbag BAG=/data/.../000730
BAG ?= /data/airoa-moma-mcap/235210
export BAG

COMPOSE      := docker compose
TEST_COMPOSE := docker compose -f deploy/test/compose.yaml

SERVICES := recorder monitor streamer orchestrator dora_runner frontend
# Services named on the command line (e.g. `make build monitor`). Empty = all.
# Override explicitly with SVC=monitor if you prefer.
SVC ?= $(filter $(SERVICES),$(MAKECMDGOALS))

PY_DIRS := libs/kairos_common services/rosbag2_recorder services/topic_monitor \
           services/webrtc_streamer services/api_orchestrator services/dora_runner

.DEFAULT_GOAL := help

# ---- compose lifecycle ------------------------------------------------------
.PHONY: up down build rebuild restart logs ps stop
up: ## build + start the stack detached (RECORDING_CONFIG-aware)
	$(COMPOSE) up -d --build $(SVC)

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
.PHONY: config-reload config-show
config-reload: ## apply config/*.yaml edits (restart monitor + orchestrator)
	$(COMPOSE) restart monitor orchestrator

config-show: ## print the live GET /api/v1/config defaults
	@curl -fsS --max-time 5 http://localhost:8000/api/v1/config \
		| python3 -m json.tool 2>/dev/null || echo "orchestrator not reachable (make up?)"

# ---- test-data replay harness ----------------------------------------------
.PHONY: rosbag rosbag-loop table smoke smoke-record
rosbag: ## replay the sample bag ONCE (BAG=... to pick another)
	$(TEST_COMPOSE) run --rm rosbag_player

rosbag-loop: ## replay the sample bag on a LOOP
	LOOP=--loop $(TEST_COMPOSE) run --rm rosbag_player

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
	@echo "  RECORDING_CONFIG=$(RECORDING_CONFIG)   BAG=$(BAG)"

# Positional service names (and `all`) are no-op targets so they don't error
# when used as arguments, e.g. `make build monitor` / `make build all`.
.PHONY: $(SERVICES) all
$(SERVICES) all:
	@:
