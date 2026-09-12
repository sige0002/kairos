# Console v2 assets to preserve

Paths below are relative to `services/frontend/`. Inspect the row relevant to
the feature; these are established implementations, not a second design spec.

| Asset | Contract carried by the implementation |
|---|---|
| `src/features/stream/useWebRtcStream.ts` | WebRTC MTU workaround: PACKET_MAX cap and IPv6 ICE-candidate filtering prevent the Tailscale black-screen regression. |
| `src/features/probe/UplotChart.tsx` | Empty-buffer redraw guard. Do not bypass it with a direct no-argument uPlot `redraw()` call on an empty buffer. |
| `src/features/validation/PipelineForm.tsx` and `SummaryResult.tsx` | Schema-driven forms and pipeline-agnostic result rendering. Extend these instead of creating parallel screen-local forms. |
| `src/features/monitor/useMonitorRows.ts` and `thresholds.ts` | Shared Hz/expected-Hz/bandwidth/gap status logic. Keep thresholds consistent across screens. |
| `src/sse/useEventStream.ts` and `src/store/uiStore.ts` | Existing SSE connection and shared state. Read the store rather than opening a duplicate connection. |
| `src/api/client.ts`, `src/v2/<screen>/use*.ts`, and `src/v2/pollingPolicy.ts` | Existing API, screen-state, and polling conventions. Check them before adding fetch loops or another store. |

If an asset lacks behavior required by the task, extend its contract deliberately
and verify affected consumers. The reuse requirement does not freeze legitimate
bug fixes or justify hiding necessary cross-layer changes.
