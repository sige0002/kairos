# Working example: grayscale (live lane)

A run-as-is extension that pulls dora_live camera frames, converts them to
grayscale, writes the result to the host, and streams progress events into the
Web UI (Monitor → Events → Extension events).

```bash
cp -r extensions/_examples/grayscale extensions/grayscale
make up LIVE=1        # stack lifecycle from here on (down / ext-reload / ps)
ls /tmp/kairos_ext_grayscale/   # latest_gray.jpg keeps updating
```

UI check: Monitor tab → Events → "Extension events" shows a
`grayscale_heartbeat` (with frames_done) roughly every 10 s. No frontend
changes involved.

- Input: the frames pull contract (auto-picks a `codec: image` topic)
- Change the output dir: `EXT_OUT_DIR=/path make up LIVE=1`
- Split deployment: `make recording-up` on the recording PC auto-targets the
  robot's :8005
