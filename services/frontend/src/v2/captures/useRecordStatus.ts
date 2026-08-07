// The one place the UI learns what the recorder is doing.
//
// Every surface that asks "is a recording running?" goes through this hook,
// because the question has THREE answers and the two failure modes are both
// easy to collapse into the wrong one:
//
//   * The recorder answered and named a live set        -> we know.
//   * The recorder answered WITHOUT `live_capture_ids`  -> §10 rev.2.4: an
//     unreachable or too-old recorder, NOT an empty live set.
//   * The poll itself FAILED                            -> react-query keeps
//     serving the last successful response, so `.data` still describes a world
//     that may be minutes gone. A screen reading only `.data` will keep
//     insisting a recording is in progress long after the recorder died.
//
// THRESHOLD. Staleness is reported from the FIRST failed poll, not after N.
// The rule this enforces is「読めなかった」を「異常なし」に見せない — a reading we
// could not take must never be presented as a reading that came back fine —
// and a delay would be exactly that presentation, for as long as the delay
// lasts. The cost of being early is low because the surfaces say WHEN the last
// good read was: a single blip reads as "last known: recording, 5s ago", which
// is true and unalarming, while a dead recorder's number keeps climbing.
// `failureCount` is exposed for any surface that wants to escalate on top.
//
// That third case is why this hook exists rather than a helper over the status
// object: the staleness is a property of the QUERY, invisible to anything
// holding just the payload. Six screens each polled it and each read `.data`
// alone; one of them was always going to be wrong.
//
// It also separates two things that are NOT the same. `live_capture_ids` is
// non-empty for armed|recording|stopping (§10), but `armed` is deliberately not
// in the recorder's own active set: a prepared session holds subscriptions and
// has written nothing. "Something is live" and "bytes are being written" need
// different words on screen, so the hook reports them separately and never
// makes a caller derive one from the other.

import { useQuery } from '@tanstack/react-query';
import { getRecordStatus } from '../../api/record';
import { RECORD_STATUS_POLL_MS } from '../pollingPolicy';
import { queryKeys } from '../../api/queryKeys';
import {
  ACTIVE_RECORD_STATES,
  liveCaptureIds,
  type RecordStatus,
} from '../../api/types';

export interface RecordStatusView {
  /** The last response received. May be stale — check `reachable` first. */
  status: RecordStatus | undefined;
  /** False once a poll has failed: the recorder is not answering and anything
   *  in `status` describes the past. No liveness claim may be made on it. */
  reachable: boolean;
  /** True before the first response has arrived. */
  loading: boolean;
  /** When the last SUCCESSFUL poll landed (epoch ms), or null if none ever
   *  has. What "last known: recording, Ns ago" is measured from. */
  lastGoodAt: number | null;
  /** Consecutive failed polls. Exposed for surfaces that want to escalate;
   *  the staleness itself is reported from the FIRST failure — see below. */
  failureCount: number;
  /**
   * The live capture ids, or `null` when we genuinely do not know — because the
   * recorder is unreachable, or answered without the array.
   *
   * `null` and `[]` must never render the same: one is "we cannot tell", the
   * other is "we asked and nothing is running".
   */
  live: string[] | null;
  /** True only when the recorder ANSWERED and named at least one live capture
   *  (which includes an armed session). Never true on stale data. */
  anyLive: boolean;
  /** True only when bytes are actually being written (recording|stopping).
   *  An armed session is live but is NOT recording. */
  recording: boolean;
  /** True when a session is armed and waiting for its start — live, but
   *  writing nothing. */
  armed: boolean;
  /** The live capture's identity, or null. Read only behind `recording`/
   *  `anyLive`: the singular `capture_id` keeps naming the LAST capture after a
   *  stop (§10), so on its own it is not a liveness signal. */
  captureId: string | null;
}

/**
 * Subscribe to the recorder's status.
 *
 * All callers share one query key, so react-query dedupes the poll no matter
 * how many screens mount this at once.
 */
export function useRecordStatus(): RecordStatusView {
  const query = useQuery({
    queryKey: queryKeys.recordStatus,
    queryFn: ({ signal }) => getRecordStatus({ signal }),
    refetchInterval: RECORD_STATUS_POLL_MS,
  });
  return readRecordStatus(query.data, {
    failed: query.isError,
    loading: query.isPending,
    lastGoodAt: query.dataUpdatedAt || null,
    failureCount: query.failureCount,
  });
}

/**
 * The pure half, so the three-way answer is directly testable without a query
 * client. `failed` is the query's error state — the caller's own knowledge that
 * what it holds is stale.
 */
export function readRecordStatus(
  status: RecordStatus | undefined,
  {
    failed = false,
    loading = false,
    lastGoodAt = null,
    failureCount = 0,
  }: {
    failed?: boolean;
    loading?: boolean;
    lastGoodAt?: number | null;
    failureCount?: number;
  } = {},
): RecordStatusView {
  // A failed poll invalidates every claim, including the ones the payload
  // would otherwise support. We keep `status` available for anything that
  // wants to show a last-known value explicitly, but nothing derived from it
  // is allowed to assert liveness.
  if (failed || !status) {
    return {
      status,
      reachable: !failed,
      loading,
      live: null,
      anyLive: false,
      recording: false,
      armed: false,
      captureId: null,
      lastGoodAt,
      failureCount,
    };
  }
  const live = liveCaptureIds(status);
  const anyLive = live !== null && live.length > 0;
  const recording = ACTIVE_RECORD_STATES.has(status.state);
  return {
    status,
    reachable: true,
    loading,
    live,
    anyLive,
    recording,
    // Armed is a live session that has written nothing. Derived from the state
    // rather than from the array, because the array cannot say WHICH kind of
    // live a capture is.
    armed: status.state === 'armed',
    captureId: anyLive || recording ? (status.capture_id ?? null) : null,
    lastGoodAt,
    failureCount,
  };
}
