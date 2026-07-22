# Extension template (copy-me)

`cp -r extensions/_template extensions/<your_name>` and edit from there.
Folders starting with `_` are never loaded (this template itself does not run).
See [`extensions/README.md`](../README.md) for the mechanism overview.

The template implements both lanes; **either one alone is valid** (delete the
files of the side you don't need).

## ① Live lane (`live/`): mean-brightness watcher

Pulls decimated frames from dora_live's frames pull contract and posts a
`dark_frame` event when mean brightness drops below the threshold, plus a
`brightness_heartbeat` every ~10 s, to `POST /internal/analysis/events`:

```bash
make up LIVE=1                          # auto-starts once the folder exists (down/ext-reload/ps manage it)
curl -s localhost:8005/live/events | python3 -m json.tool   # see the events
# UI: the same events appear at Monitor → Events → Extension events
```

The only thing to rewrite is the decision logic in `live/node.py`. Event
bodies are freeform (`t` = epoch seconds is the only reserved key; stamped
with the receive time when absent).

Limitations: auto-pick prefers `codec: image` (JPEG/PNG) topics. **ffmpeg-lane
payloads (H.264/HEVC) cannot be decoded by cv2** (PyAV would be needed); when
only ffmpeg cameras exist, that is logged loudly. In the split deployment `make recording-up` on the recording PC auto-targets the robot's :8005.

## ② Validation lane (root): the topic_census pipeline

Counts messages per topic in the recorded MCAP and fails when the busiest
topic has fewer than `min_messages`. Steps:

1. change `id` (and `name`) in `kairos_plugin.yaml` to your own
2. reimplement `build_summary()` in `nodes/report.py`
3. `make restart dora_runner` → the new pipeline appears in the Validation tab
   (**only the FIRST use of the extension mechanism on an existing stack**
   needs a one-time `make rebuild dora_runner` to pick up the mount/env)

Run jobs from the UI or the API directly:

```bash
curl -s -X POST localhost:8020/jobs -H 'content-type: application/json' \
  -d '{"pipeline":"topic_census","run_id":"<run_id>","params":{"min_messages":10}}'
```

Results land in `/data/report/<id>/<run_id>/summary.json` (`result: pass|fail`
is the contract).

## Notes

- Nodes must stay **dual-mode**: `process(inputs, ctx)` (what actually runs
  in-process) + `main()` (for a dora-CLI deployment). Hosts without the dora
  CLI only exercise the former.
- Extra dependencies: lane ② is limited to what the dora_runner image ships
  (mcap / mcap-ros2-support / numpy, ...) unless you build your own image;
  lane ① can swap `image:` in `live/compose.yaml` for your own.
