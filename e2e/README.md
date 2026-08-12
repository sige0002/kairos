# e2e — UI acceptance for capture store v2

The suite that decides whether the branch is acceptable, by the rule the
contract sets in §13: **acceptance is from the UI**. Every scenario here drives
a real browser against the real frontend image, in front of a real orchestrator,
recorder and dora_runner, with a real rosbag replayed onto a real ROS 2 graph.
Nothing is mocked. If a service will not boot, if nginx cannot reach the API, if
a `data-testid` moved — this is where it shows up, and none of the unit suites
can tell you.

```bash
make build          # once, after changing services/ (needs network)
make test-e2e       # the whole suite: stack up -> playwright -> stack down
```

## Why it is not inside `services/frontend`

The frontend's `package.json` describes what the shipped app needs. A browser
driver is not that: adding Playwright there puts a ~150 MB download and a
`node_modules` tree that never reaches production into the image build's
critical path, and makes `npm ci` in the app's own CI slower for a dependency it
never imports. The acceptance layer is a separate project with its own
`package.json` for the same reason the deploy harness is not a service.

## What each scenario claims

| Spec | Contract | The claim, as an operator would state it |
|---|---|---|
| `01-collect.spec.ts` | §13-1 | I start and stop a recording on the Collect screen, and the recording shows up in Review and finishes verifying. |
| `02-review.spec.ts` | §13-2 | The labels I save stick, the revision number on screen is the one on disk, and a save that lost a race is refused out loud instead of silently applied. |
| `03-discard.spec.ts` | §13-3 | Discard from Review will not arm until I say why — a preset reason in one click, or my own words under *Other* — then the recording leaves every list, and the ledger knows exactly which answer I stood by. (Collect's Discard is one click by design: the ledger records that no reason was asked.) |
| `04-rebuild.spec.ts` | §13-4 | The database is disposable: delete it, restart, and my recordings and datasets are all still there. |
| `05-missing-repair.spec.ts` | §13-5 | If files disappear behind kairos's back, nothing silently vanishes from the catalog: the store says SUSPECT, I acknowledge it with Repair, and the affected recordings are marked *missing*. |
| `06-recorder-honesty.spec.ts` | regression | If the recorder dies while I am recording, the screen says so instead of running a timer for a recording nobody can see — and when it comes back it offers me the interrupted take with its real size and why it ended, not a fresh recording. |
| `07-dataset-archive.spec.ts` | §6.1 | When I archive a finished dataset, the dialog shows me the exact folder it will land in, every recording is copied and hash-verified before its copy here is removed, the folder describes itself with a manifest the ledger can vouch for — and even after the database is destroyed, kairos still says the dataset is archived and where it went. |
| `08-validation.spec.ts` | screen | I run the required-topic check on a recording from the Validation screen, and it comes back naming every topic the template demands with a tick or a cross beside it — and the report it leaves on disk says the same thing as the screen did. |
| `09-monitor.spec.ts` | screen | The topics my robot config asks the monitor to watch show live rates on the Monitor screen; the ones it was never asked to watch say nothing rather than reading zero. |
| `10-settings.spec.ts` | screen | Settings shows me the recording config that is actually loaded, refuses an edit that is not valid JSON before it can reach the server, and saving it back leaves what the stack reads exactly as it was. |

`01`–`07` are the §13 acceptance minimum. `08`–`10` are not part of it: they
cover the three screens that minimum never enumerated — Validation, Monitor and
Settings — which had no acceptance evidence here at all, only unit suites. They
claim one thing each, chosen because it is the thing a unit suite structurally
cannot show: that a job started in the browser reaches a real dora coordinator
and renders; that live rates actually arrive from a real ROS graph; that a save
rewrites the real config file and gives it back unchanged. `screen` in the
Contract column means exactly that — a screen's own claim, not a numbered
scenario from the contract.

That is still not a coverage sweep. A screen with no row above has no acceptance
evidence here — its evidence is its unit suite. Say so when reporting a green
run, because that is where the over-reading happens.

`10-settings.spec.ts` is the only scenario that writes outside the per-run data
dir. It saves through the Settings screen, and that screen edits the repo's own
committed recording config (`config/<robot>/recording/default.yaml`) because
that is the file the product edits — compose mounts `./config` into the
orchestrator read-write. So the scenario reads the bytes first, restores them in
a `finally`, and its last assertion is that the working tree was left without a
diff. See the header of `fixtures/config.ts` for why the restore is needed at
all: the writer re-serialises the whole validated model, so the round trip is
faithful in meaning but not byte-for-byte.

`04-rebuild.spec.ts` carries a second test beyond the §13 minimum — *a failed
start does not take the whole capture list down*. It is there because the
scenario above hit that bug by accident once: a recording that failed to arm
left an `objects/<id>.failed.json` behind, and after the next rebuild **every**
capture disappeared from the UI behind a 500. Left as a race it would be an
occasional red run that someone re-runs away; planted deliberately it is a
named, reproducible defect. See below for the history.

## `tools/` — measurements the suite cannot make

Two probes that are **not part of `make test-e2e` and never run in CI**. They
answer questions a spec cannot: one needs a layout engine (jsdom has none, so
every width and overflow is `0` there and an assertion about them passes against
any stylesheet), the other needs a real ICE agent. They are here so the numbers
in a review round can be reproduced by someone else instead of being taken on
trust.

Both need the stack up, and both print measurements rather than pass/fail prose.
Exit code is `1` when a defect is found, so either can gate a manual round.

### `layout-probe.mjs` — E-25 layout resilience

```bash
make test-e2e-up
node e2e/tools/layout-probe.mjs --self-test    # ALWAYS run this first
node e2e/tools/layout-probe.mjs                # the measurement
node e2e/tools/layout-probe.mjs --zoom 1.5 --tab collect --shots dev_image
```

Walks every tab at 1280x800 at 100% and 150% zoom and reports three things:
the page scrolling horizontally, Collect scrolling vertically, and text cut off
with nothing (no ellipsis, no `title`, no scrollable box) telling the operator
it was cut. Browser zoom is modelled by shrinking the CSS viewport, which is
what zoom actually does to layout: 150% on a 1280x800 monitor is 853x533 CSS px.

**Run `--self-test` first, every time.** It plants three defects — an
over-wide element, an over-tall one, and an unmarked clipped label — and fails
if the probe does not report all of them. This is not ceremony: the first
version of this probe reported *12/12 clean* while Collect scrolled 998px at
150%, because it measured the tab panel's overflow and the panel is not the
scroller below the `lg` breakpoint. An instrument that has not been shown to
say "broken" has not yet said anything by saying "clean".

Two rules it follows, both from the E-24 round: it measures **rendered boxes**
(`scrollWidth` / `clientWidth` / `getBoundingClientRect`) rather than class
names or style strings, because a `truncate` class that cannot take effect is
still present in the markup; and it treats an ellipsis, a `title`, or a
scrollable container as a **mark**, because the defect is text that vanishes
silently, not text that is shortened visibly.

### `peer-failure-probe.mjs` — E-37 `'peer'` stream classification

```bash
E2E_WITH_STREAMER=1 bash e2e/scripts/stack.sh up   # the gate omits the streamer
node e2e/tools/peer-failure-probe.mjs --control    # contrast: streams connect
node e2e/tools/peer-failure-probe.mjs              # media path broken
```

Reproduces the one condition that separates `peer` from `signaling`: HTTP fine,
media path dead. It rewrites **only the port in `a=candidate:` lines**, in both
the answer (`setRemoteDescription`) and the offer the page posts
(`POST /stream/offer`) — nothing else, not the ice-ufrag, ice-pwd, DTLS
fingerprint, `m=` or `c=` lines. Signaling stays real (the streamer answers
201/200 for real), and the failure is produced by the browser's own ICE agent.
Both directions must be broken: patching only the answer leaves the offer
carrying the browser's real candidates, aiortc connects inbound, and the browser
learns a peer-reflexive candidate and connects anyway — measured, not assumed.

`E2E_WITH_STREAMER=1` is opt-in because the streamer is a ~1.2 GB ROS image and
no §13 scenario asserts on a camera preview. Without it `/stream/start` is a
502, which the UI classifies as `signaling` — the wrong branch to be measuring.

## A defect this suite found (fixed)

`§13-4 Rebuild: a failed start does not take the whole capture list down`
exists because the suite's first full run tripped over a real, permanent
outage: a failed start whose arming died *before* type discovery writes each
topic's `type` as an explicit `null` into `objects/<id>.failed.json` (§3.4).
The rebuild faithfully made a `state='failed'` row from it — and then
`CaptureTopic` refused the null, so `GET /api/v1/captures` returned 500 for
the **whole** catalog, permanently, because the row was now in `kairos.db`.

The orchestrator fix (coerce null to the undiscovered spelling, `""`) landed
as `fix(orchestrator): a failed start's null topic type must not poison the
catalog`. The test remains as the regression pin: it plants the exact sidecar
shape the recorder produced (`fixtures/store.ts` `writeFailedStart`), rebuilds,
and asserts the Review list still renders. It cleans up after itself in a
`finally`, so it can never cascade into §13-5.

### Primary vs secondary assertions

Every scenario asserts the **user-visible** outcome first — the row, the chip,
the banner, the words in the dialog. Only then does it corroborate against the
sidecars (`object_manifest.json`, `record.json`, `lifecycle.jsonl`) and the API.

That ordering is the point. A test that checks only the API would pass on a
branch whose UI never renders the result, and §13 exists precisely because the
capture-store rewrite touched both ends. Where the API is used to *cause*
something rather than to check it (bulk-recording seven captures to reach the
§9-3 threshold, or `POST /store/reconcile` to run a pass now instead of waiting
out its 120 s timer), the call site says so.

### No silent skips

A scenario that cannot run in this environment **fails**. There is no
`test.skip()` on a missing stack, a missing bag or a missing browser: an
acceptance suite whose scenarios quietly evaporate reports green for a branch
nobody tested. `fixtures/stack.ts` fails with the command that fixes it instead.

## How it runs

`scripts/stack.sh` is the single definition of the stack under test. The
Makefile target, Playwright's global setup, and the three scenarios that break
something on purpose all call it, so running it by hand gives byte-identical
conditions to `make test-e2e`.

```bash
bash e2e/scripts/stack.sh up     # fresh data dir + stack + looping replay
cd e2e && npx playwright test    # iterate without paying for a restart
npx playwright test --headed tests/03-discard.spec.ts
npx playwright show-report
bash e2e/scripts/stack.sh down
```

**One acceptance run at a time.** `up` claims a lease on the stack for the whole
run, so a second run is refused with *another acceptance run holds the stack —
pid N, started …* rather than tearing down the first one's containers and wiping
its data dir mid-test (which surfaces as a hung recording and a cascade of
scenarios failing against nothing — it reads exactly like a product defect). If
the run it names is genuinely gone, `bash e2e/scripts/stack.sh down` releases it.

The stack is deliberately **beside**, not instead of, a developer's own
`make up` (`e2e/stack.env`):

| | dev stack | e2e stack |
|---|---|---|
| UI / API | `:8080` / `:8000` | `:18080` / `:18000` |
| recorder / dora | `:8010` / `:8020` | `:18010` / `:18020` |
| `ROS_DOMAIN_ID` | `.env` (0) | 42 |
| data dir | `./data` | `./e2e/.run/data` (wiped per run) |
| robot config | `.env` | `airoa_hsr` (the bundled sample) |
| compose project | `kairos` | `kairos-e2e` |

`stack.env` is exported into the environment before compose runs, not merely
passed with `--env-file`: compose lets the shell win over an env file, so a
`ROBOT=` exported by the Makefile would otherwise select the wrong recording
config for the acceptance stack.

### The replayed bag

`data/airoa-moma-mcap/235210` (61 MB, ~10 s, HSR topics) plays on a loop for the
whole run. Its standard-typed topics are exactly the `default_topics` of
`config/airoa_hsr/recording/default.yaml`, so no custom-message overlay is
needed and a clean clone can run the suite. Override with
`BAG=<path under data/> bash e2e/scripts/stack.sh up`.

Recordings wait on the Collect screen's own `elapsed` counter rather than on a
sleep, so a slow DDS discovery lengthens the wait instead of silently shortening
the bag.

### Images are not built here

Same rule as `make up`: building needs a network even when nothing changed, so
the stack never builds implicitly. `stack.sh` checks the images exist and, if
they do not, says `make build`. **A stale image is worse than a missing one** —
it produces a green acceptance run for code that is not in the container. Run
`make build` after touching `services/` or `libs/`.

## Offline sites: carrying the browser in

The first `make test-e2e` on a machine needs the network twice — `npm install`,
and Playwright's chromium download into `~/.cache/ms-playwright`. Neither is
available at a site that cannot reach the internet, and neither is covered by
`make images-save`, which carries only the stack's own images.

**Nothing below has been built yet — this documents the shape, it is not a
shipped artefact.** Per the `offline-container-delivery` skill, the fix is to
stop treating the browser as a host dependency and let it ride in an image:

```dockerfile
# e2e/Dockerfile (not built yet)
# Playwright's own image already contains the matching chromium plus every
# system library it needs. Pin the tag to the SAME version as
# e2e/package.json's @playwright/test — a browser newer than the driver (or
# older) is the classic "works on my machine" for this layer.
FROM mcr.microsoft.com/playwright:v1.56.0-noble
WORKDIR /e2e
COPY e2e/package.json e2e/package-lock.json ./
RUN npm ci                      # baked in, so the site needs no npm registry
COPY e2e/ ./
```

Then, at the site:

```bash
# where there IS a network
docker save kairos-e2e:<version> | gzip > kairos-e2e-image.tar.gz
# at the site
gunzip -c kairos-e2e-image.tar.gz | docker load
docker run --rm --network host \
  -e E2E_BASE_URL=http://127.0.0.1:18080 \
  -v "$PWD/e2e/.run:/e2e/.run" kairos-e2e:<version> npx playwright test
```

Four things the skill's checklist flags that apply directly here:

- **`--network host`.** Both the stack and the replay harness use host
  networking; a bridged test container cannot reach `127.0.0.1:18080`.
- **The data dir must be mounted.** The secondary assertions read
  `objects/<id>/object_manifest.json` and `lifecycle.jsonl` off the host
  filesystem — without the mount, four of the five scenarios lose their
  corroboration and the suite is not doing its job.
- **`scripts/stack.sh` needs a Docker socket**, because §13-4 and §13-5 stop
  containers and remove root-owned trees. Either mount `/var/run/docker.sock`
  into the test container, or run the stack lifecycle from the host and only
  the browser in the container.
- **`.dockerignore` must exclude `e2e/node_modules` and `e2e/.run`**, or the
  host's `node_modules` is copied over the `npm ci` result — and a cross-arch
  host makes that fail as an unrelated-looking `MODULE_NOT_FOUND`.

Verify it the way the skill insists: **actually disconnect the network** and run
it. A machine that has the npm cache, the browser cache and a warm image store
cannot tell you anything about a site that has none of them.

## Selectors

Only committed `data-testid`s and accessible roles/names — never CSS classes or
DOM shape, which change with a restyle and would make this suite a brake on the
UI instead of a check of it. Start/Stop on the Collect screen have no testid, so
they are selected by their accessible name (`Start recording` / `Stop
recording`), which is what the operator reads anyway.

If a scenario needs a testid the app does not have, the fix belongs in
`services/frontend` — not in a brittle selector here.

## Recording needs an operator

Start is disabled until the OP chip carries a name, in every configuration, and
every test gets a fresh browser context — so any scenario that records calls
`ensureOperator(page)` (`fixtures/ui.ts`) first. `recordThroughUi` does it for
its callers; a scenario that drives Start itself does it itself.

The helper clicks the chip and types, rather than seeding the chip's
localStorage key. Writing the app's private storage would keep this suite green
after the chip stopped saving anything — the opposite of what an acceptance
gate is for.

## Layout

```
e2e/
  stack.env               the acceptance stack's profile (ports, ROS domain, data dir)
  scripts/stack.sh        up / down / wait / rm-db / rm-objects — the only stack control
  playwright.config.ts    workers: 1, retries: 0 (see the comment there for why)
  fixtures/
    stack.ts              where the stack is; refuses to run against a dead one
    api.ts                orchestrator REST — secondary assertions and setup
    store.ts              sidecars on disk: manifests, record.json, the ledger
    config.ts             the repo's committed config tree — the one thing written outside .run/
    ui.ts                 page helpers built on committed testids
    global-setup.ts       fail loudly, early, if the stack is not up
  tests/                  one scenario per file, run in order (01–07 = §13, 08–10 = per-screen)
  .run/                   per-run scratch (data dir, generated env) — gitignored
```
