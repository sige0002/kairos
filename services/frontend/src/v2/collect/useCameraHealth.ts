// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The camera wall's health aggregation (E-37), split out of Cameras.tsx:
// every pane's own stream state (reported by the tiles), the no-video-yet
// timers, the monitor's per-topic liveness counts, and the memoized
// CameraHealth report handed up to the SYSTEM STATUS card.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StreamFailure, StreamStats } from '../../features/stream/useWebRtcStream';
import type { TopicLiveness } from './warnings';
import type { CameraPane } from './cameraStore';
import { isFramesStale } from './CameraTile';

/** What the SYSTEM STATUS Cameras row needs to describe every pane, not just
 *  the main one. Counts rather than a boolean, so the row can say WHICH of the
 *  cameras is in trouble instead of collapsing four tiles into one word. */
/**
 * How long a pane may negotiate without a frame before the row says so.
 *
 * A normal connection on this stack settles in 1-3 s (measured: the control run
 * of e2e/tools/peer-failure-probe.mjs had both panes carrying video well inside
 * that). 10 s is a wide margin over that, so a slow-but-working start never
 * flashes a warning, while the failure this exists for — a media path that
 * never connects at all — was still black at 150 s. Anything in between is a
 * pane an operator would rightly want to know about.
 */
export const NO_VIDEO_AFTER_MS = 10_000;

// Test-only override (same idiom as useBatchMachine's __setStopFloorMs). The
// alternative — fake timers — has to fake `performance` as well, and installing
// that clock after the panes have already taken their `waitingSince` baseline
// computes a NEGATIVE wait. Making the threshold injectable keeps the tests on
// the real clock, where the plumbing behaves exactly as it ships.
let noVideoAfterMs: number = NO_VIDEO_AFTER_MS;
export function __setNoVideoAfterMs(ms: number): void {
  noVideoAfterMs = ms;
}
export function __resetNoVideoAfterMs(): void {
  noVideoAfterMs = NO_VIDEO_AFTER_MS;
}

export interface CameraHealth {
  streamFailed: boolean;
  /** Panes whose OWN stream is not carrying video. Every pane negotiates
   *  separately, so the main tile's phase was never an answer for the wall
   *  (E-37: four black tiles summarised as "5 cameras OK"). */
  streamsDown: number;
  /** The cause those failures agree on, 'mixed' when they disagree. Primitive,
   *  because this object is compared field-by-field with `===`. */
  streamFault: StreamFailure | 'mixed' | null;
  /** Panes negotiating past NO_VIDEO_AFTER_MS with no frame ever (E-37). */
  streamsNoVideo: number;
  framesStale: boolean;
  /** Panes whose source topic the monitor reports as silent. */
  silentTopics: number;
  /** Panes whose source topic nobody measures, so neither answer is available. */
  unmonitoredTopics: number;
  /** Panes that have a topic at all. */
  totalCameras: number;
}

/**
 * Do two health reports say the same thing? Every field is a primitive fact, so
 * a consumer can hold its state across a report that carries no news.
 *
 * Compared by KEY rather than field-by-field on purpose: a fifth fact added to
 * the interface joins the comparison automatically. A hand-written list would
 * silently ignore the new field, which is a stuck value on screen — and if the
 * report ever stopped being memoized, a render loop.
 */
export function sameCameraHealth(a: CameraHealth, b: CameraHealth): boolean {
  return (Object.keys(a) as (keyof CameraHealth)[]).every((k) => a[k] === b[k]);
}

/** A tile's report about its own stream (E-37). */
export type OnStreamState = (
  topic: string,
  down: boolean,
  failure: StreamFailure | null,
  waitingSince: number | null,
) => void;

export function useCameraHealth({
  mainTopic,
  phase,
  mainFailure,
  stats,
  paneLiveness,
  panes,
  onHealthChange,
}: {
  mainTopic: string | undefined;
  /** The MAIN stream's phase (sub tiles report through onStreamState). */
  phase: string;
  mainFailure: StreamFailure | null;
  stats: StreamStats;
  paneLiveness: Map<string, TopicLiveness>;
  panes: CameraPane[];
  onHealthChange?: (health: CameraHealth) => void;
}): { onStreamState: OnStreamState } {
  // A connected stream with frames standing still is NOT ok, and neither is one
  // whose source topic has gone quiet. The connection being up says nothing
  // about pictures arriving, which is how the row read "main stream OK" for 106
  // seconds against a topic with no publisher.
  //
  // Reported across ALL panes: the row used to speak only for the main stream,
  // so nothing on the screen accounted for a silent sub camera.
  //
  // Built from PRIMITIVES in a memo, deliberately. `stats` is a fresh object on
  // every poll, so an effect depending on it produced a new health object every
  // render — and the parent's setState, seeing a new reference each time, never
  // settled. The values here change only when one of the facts does.
  // Every pane's own stream state, reported up by the tiles (E-37). A ref plus
  // a tick rather than state per report: reports arrive one per tile per phase
  // change, and setState on each would re-render the wall mid-negotiation.
  const streamStateRef = useRef<
    Map<
      string,
      { down: boolean; failure: StreamFailure | null; waitingSince: number | null }
    >
  >(new Map());
  const [streamTick, setStreamTick] = useState(0);
  const onStreamState = useCallback(
    (
      topic: string,
      down: boolean,
      failure: StreamFailure | null,
      waitingSince: number | null = null,
    ) => {
      const prev = streamStateRef.current.get(topic);
      if (
        prev &&
        prev.down === down &&
        prev.failure === failure &&
        prev.waitingSince === waitingSince
      ) {
        return;
      }
      streamStateRef.current.set(topic, { down, failure, waitingSince });
      setStreamTick((t) => t + 1);
    },
    [],
  );

  // One ticker for every pane rather than one each: the panes do not change
  // state on their own while waiting, so without a clock here the count would
  // never cross the threshold — the report would depend on some other pane
  // happening to re-render.
  const [waitTick, setWaitTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setWaitTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const framesStale = isFramesStale(stats);
  const silentCount = [...paneLiveness.values()].filter((l) => l === 'silent').length;
  // Counted, not folded into the OK total: a camera nobody measures is not a
  // camera known to be fine, and the row has to be able to say so.
  const unmonitoredCount = [...paneLiveness.values()].filter(
    (l) => l === 'unmonitored',
  ).length;
  const cameraCount = panes.filter((p) => !!p.topic).length;
  const streamFailed = phase === 'failed';
  // The main pane reports through here rather than through the tile, so it
  // needs the same waiting baseline — reporting it as null let the main pane
  // overwrite the tile's entry and made the count come out zero.
  const mainWaitingSinceRef = useRef<number | null>(null);
  if (phase !== 'connected' && mainWaitingSinceRef.current === null) {
    mainWaitingSinceRef.current = performance.now();
  }
  if (phase === 'connected') mainWaitingSinceRef.current = null;
  useEffect(() => {
    if (mainTopic) {
      onStreamState(mainTopic, streamFailed, mainFailure, mainWaitingSinceRef.current);
    }
  }, [mainTopic, streamFailed, mainFailure, phase, onStreamState]);

  // Only panes still open count — a removed tile must not keep voting.
  const openTopics = useMemo(
    () => new Set(panes.map((p) => p.topic).filter((t): t is string => !!t)),
    [panes],
  );
  const { streamsDown, streamFault, streamsNoVideo } = useMemo(() => {
    void streamTick; // recompute when a tile reports
    void waitTick; // …and once a second, so a wait can cross the threshold
    let down = 0;
    let noVideo = 0;
    const now = performance.now();
    const kinds = new Set<StreamFailure>();
    for (const [topic, st] of streamStateRef.current) {
      if (!openTopics.has(topic)) continue;
      if (st.down) {
        down += 1;
        if (st.failure) kinds.add(st.failure);
        continue; // a reported failure is the better answer; do not count twice
      }
      if (st.waitingSince != null && now - st.waitingSince > noVideoAfterMs) {
        noVideo += 1;
      }
    }
    const fault: StreamFailure | 'mixed' | null =
      kinds.size === 0 ? null : kinds.size > 1 ? 'mixed' : [...kinds][0]!;
    return { streamsDown: down, streamFault: fault, streamsNoVideo: noVideo };
  }, [openTopics, streamTick, waitTick]);
  const health = useMemo<CameraHealth>(
    () => ({
      streamFailed,
      streamsDown,
      streamFault,
      streamsNoVideo,
      framesStale,
      silentTopics: silentCount,
      unmonitoredTopics: unmonitoredCount,
      totalCameras: cameraCount,
    }),
    [
      streamFailed,
      streamsDown,
      streamFault,
      streamsNoVideo,
      framesStale,
      silentCount,
      unmonitoredCount,
      cameraCount,
    ],
  );
  useEffect(() => {
    onHealthChange?.(health);
  }, [health, onHealthChange]);
  return { onStreamState };
}
