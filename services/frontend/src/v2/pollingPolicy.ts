// How often each thing in the console re-reads itself.
//
// These were literals scattered across ~15 files, and the drift was already
// visible: `REFETCH_MS` meant 5000 in two Monitor cards and 30_000 in a third,
// in the same directory. A reader could not tell whether two screens polling at
// the same rate were agreeing on a policy or colliding by accident.
//
// Named by USE, not by value. Constants that happen to share a number are still
// separate, because they answer different questions and may move apart: the
// recorder's status poll and the host-facts poll are both 5 s today for
// unrelated reasons.
//
// Values here are exactly what the call sites used before they were named —
// this file changed no cadence.
//
// Not in scope: `staleTime` (a cache-freshness knob, not a schedule) and
// per-frame/1 Hz UI tickers that drive a clock or an animation without touching
// the network.

/** The post-stop confirmation poll: after POST /record/stop returns, the
 *  machine re-reads /record/status at this cadence until the recorder reports
 *  a terminal state. 1 s because the wait is a rosbag2 cache flush measured in
 *  seconds — the mean detection lag is half this interval, imperceptible
 *  against the flush, while anything faster just hammers a recorder that is
 *  busy fsyncing. The count shown to the operator also ticks per second. */
export const STOP_CONFIRM_POLL_MS = 1000;

/** How long the machine lets that confirmation run before calling the stop
 *  failed. Sized to the recorder's full escalation chain — SIGINT 30 s +
 *  SIGTERM 30 s + SIGKILL 5 s — plus margin: inside this window a still-active
 *  status is a recorder CORRECTLY draining or escalating, and surfacing an
 *  error there converts normal seconds-long behavior into a false failure. */
export const STOP_CONFIRM_MAX_MS = 70_000;

/** Dataset archive progress. The run is server-owned and this poll is its only
 *  window, so it is the fastest in the console — a full second slower than
 *  nothing, and still finer than the job polls below. */
export const DATASET_ARCHIVE_POLL_MS = 1000;

/** Validation's job hook (useJobResult), until the job reaches a terminal
 *  state. Distinct from INSPECTION_JOB_POLL_MS below purely because that is how
 *  the two were written; both watch `/jobs/{id}/status`. */
export const VALIDATION_JOB_POLL_MS = 1200;

/** The inline job watchers in the inspection panels — Review's capture detail
 *  and its signal section, Datasets' loss report, and the per-topic video
 *  preview. All four stop at a terminal state. */
export const INSPECTION_JOB_POLL_MS = 1500;

/** Validation preset pending-counts, polled only while a batch is in flight and
 *  stopped once everything settles. */
export const VALIDATION_PRESETS_POLL_MS = 3000;

/** Review's capture list while a robot->PC transfer is running, so an arriving
 *  replica is seen within a few seconds. An rsync of a long episode takes
 *  minutes; the slot honestly stays "transferring" until the server confirms. */
export const TRANSFER_PROGRESS_POLL_MS = 4000;

/** The recorder's status. The SSE `record_status` event updates the same cache
 *  entry between polls, but it does not carry `live_capture_ids`
 *  (record_service only publishes state/counters), so the ARRAY is only ever as
 *  fresh as this interval. */
export const RECORD_STATUS_POLL_MS = 5000;

/** ROS 2 graph discovery, so a newly-published topic appears in the pickers
 *  rather than only in what has already been measured. Read by the Monitor
 *  table (`/topics`), Collect's add-camera dropdown (`/topics`, the cadence v1's
 *  StreamTab used) and the Probe topic picker (`/probe/topics`). */
export const TOPIC_DISCOVERY_POLL_MS = 5000;

/** Host facts from `GET /api/v1/system` — utilization and disk change over time
 *  where the CPU/GPU names do not. Cheap: the backend caches its samples ~2 s.
 *  Read by Monitor's system view and card, Settings > System, and Collect's
 *  system-status rows; the last two pair it with an equal `staleTime`, so a
 *  shorter interval here would start serving scheduled refetches from cache. */
export const SYSTEM_INFO_POLL_MS = 5000;

/** An open capture detail. Slow enough to be invisible on a healthy screen,
 *  fast enough that a capture discarded elsewhere turns terminal on its own
 *  rather than on the operator's click — the lease changes underneath too
 *  (§7.1), so the controls' disabled state has the same need. */
export const CAPTURE_DETAIL_POLL_MS = 10_000;

/** Store condition changes on rebuilds and reconciler passes (minutes apart),
 *  so a slow poll is enough; the card's Refresh is there for the operator who
 *  just fixed a mount and does not want to wait. */
export const STORE_HEALTH_POLL_MS = 30_000;

/** Per-condition coverage on Collect. It sums batch counters that only a
 *  completed review advances, so there is nothing to see between takes. */
export const COVERAGE_POLL_MS = 30_000;
