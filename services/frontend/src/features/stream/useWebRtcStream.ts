// Native WebRTC preview against webrtc_streamer (see docs/specs/ja/webrtc_streamer.md).
// Flow (non-trickle, WHEP-style HTTP offer/answer):
//   1. POST {webrtc}/stream/start { topic } -> { stream_id }
//   2. create RTCPeerConnection (recvonly video), make an offer
//   3. wait for ICE gathering to complete (full SDP with candidates)
//   4. POST {webrtc}/stream/offer { stream_id, sdp:{type:"offer",sdp} } -> answer
//   5. setRemoteDescription(answer); media arrives on the track
//
// We expose connection state, the MediaStream, error, and a retry().

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type StreamPhase = 'idle' | 'starting' | 'negotiating' | 'connected' | 'failed';

interface StreamStartResponse {
  stream_id: string;
}
interface OfferAnswer {
  type: 'answer';
  sdp: string;
}

function joinBase(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * Resolve the MediaStream for a received track. The streamer (aiortc) sometimes
 * omits the stream association (msid), leaving `ev.streams` empty; without this
 * fallback the `<video>` would get no `srcObject` and show a black preview, so
 * wrap the track in a fresh MediaStream instead.
 */
export function streamFromTrackEvent(ev: RTCTrackEvent): MediaStream {
  return ev.streams[0] ?? new MediaStream([ev.track]);
}

/** Resolve once ICE gathering completes so we can send a non-trickle SDP. */
function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Safety timeout: proceed with whatever candidates we have.
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 3000);
  });
}

export interface UseWebRtcStreamArgs {
  /** Base URL of the streamer (config.endpoints.webrtc / WEBRTC_PUBLIC_URL). */
  webrtcBase: string;
  /** ROS image topic to preview. */
  topic: string;
  /** Optional ICE servers (distributed via config when crossing networks). */
  iceServers?: RTCIceServer[];
  /**
   * Optional resolution cap (px). The streamer downscales aspect-preserved to
   * fit within `maxWidth` x `maxHeight` (never upscales); `null` = Source (no
   * cap). Lower caps cut the robot's encode CPU and the WebRTC egress.
   */
  maxWidth?: number | null;
  maxHeight?: number | null;
}

/**
 * Live receive-side stats, polled from `RTCPeerConnection.getStats()`. This is
 * pure WebRTC-preview telemetry (jitter buffer + RTT + decoded frame rate) — it
 * never touches the ROS graph or the recorder, so measuring it has no effect on
 * rosbag capture. `latencyMs` is an estimate: jitter-buffer delay + RTT/2.
 */
export interface StreamStats {
  fps: number | null;
  latencyMs: number | null;
  width: number | null;
  height: number | null;
}

export interface UseWebRtcStreamResult {
  phase: StreamPhase;
  stream: MediaStream | null;
  error: string | null;
  stats: StreamStats;
  /** Tear down and re-negotiate. */
  retry: () => void;
}

const EMPTY_STATS: StreamStats = { fps: null, latencyMs: null, width: null, height: null };

// A connected stream that decodes no new frames for this long is "black"; we
// auto-renegotiate (up to AUTO_RETRY_MAX) — the usual cause is joining an
// ongoing encode mid-GOP after a tab switch, fixed by a fresh keyframe.
const STALL_MS = 2500;
const AUTO_RETRY_MAX = 2;

export function useWebRtcStream({
  webrtcBase,
  topic,
  iceServers = [],
  maxWidth = null,
  maxHeight = null,
}: UseWebRtcStreamArgs): UseWebRtcStreamResult {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [attempt, setAttempt] = useState(0);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const autoRetriesRef = useRef(0);
  // The stream this hook last started (id + its resolution cap), so a resolution
  // change on the SAME topic can stop the shared stream before re-starting — the
  // streamer keys a stream by (topic, encoding) and ignores new caps otherwise.
  const activeStreamRef = useRef<{ id: string; topic: string; capsKey: string } | null>(null);

  // Stabilize iceServers so an inline-array prop doesn't re-trigger negotiation
  // every render. Identity follows content, not reference.
  const iceServersKey = JSON.stringify(iceServers);
  const stableIceServers = useMemo<RTCIceServer[]>(
    () => JSON.parse(iceServersKey) as RTCIceServer[],
    [iceServersKey],
  );

  const retry = useCallback(() => {
    setError(null);
    autoRetriesRef.current = 0; // a manual retry restores the auto-retry budget
    setAttempt((n) => n + 1);
  }, []);

  // A new target topic gets a fresh auto-retry budget.
  useEffect(() => {
    autoRetriesRef.current = 0;
  }, [topic]);

  useEffect(() => {
    if (!topic || !webrtcBase) return;
    if (typeof RTCPeerConnection === 'undefined') {
      setPhase('failed');
      setError('WebRTC is not supported in this browser.');
      return;
    }

    let cancelled = false;
    const pc = new RTCPeerConnection({ iceServers: stableIceServers });
    pcRef.current = pc;

    pc.addEventListener('track', (ev) => {
      if (!cancelled) setStream(streamFromTrackEvent(ev));
    });
    pc.addEventListener('connectionstatechange', () => {
      if (cancelled) return;
      const s = pc.connectionState;
      if (s === 'connected') setPhase('connected');
      else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        setPhase('failed');
        setError(`Connection ${s}.`);
      }
    });

    async function negotiate(): Promise<void> {
      try {
        setPhase('starting');
        const capsKey = `${maxWidth ?? ''}|${maxHeight ?? ''}`;
        // A duplicate /stream/start for the same (topic, encoding) returns the
        // existing stream and ignores new caps (registry.start). So when only the
        // resolution changed on THIS topic, stop the shared stream first so the
        // next start recreates its source at the new cap. A plain retry (same
        // caps) skips this and re-attaches to the warm stream — no source churn.
        const prev = activeStreamRef.current;
        if (prev && prev.topic === topic && prev.capsKey !== capsKey) {
          try {
            await fetch(joinBase(webrtcBase, '/stream/stop'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stream_id: prev.id }),
            });
          } catch {
            // Best-effort: a now-orphaned stream idle-reaps server-side anyway.
          }
          activeStreamRef.current = null;
          if (cancelled) return;
        }
        const startBody: Record<string, unknown> = { topic };
        if (maxWidth != null) startBody.max_width = maxWidth;
        if (maxHeight != null) startBody.max_height = maxHeight;
        const startResp = await fetch(joinBase(webrtcBase, '/stream/start'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(startBody),
        });
        if (!startResp.ok)
          throw new Error(`stream/start failed: HTTP ${startResp.status}`);
        const { stream_id } = (await startResp.json()) as StreamStartResponse;
        activeStreamRef.current = { id: stream_id, topic, capsKey };
        if (cancelled) return;

        pc.addTransceiver('video', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(pc);
        if (cancelled) return;

        setPhase('negotiating');
        const local = pc.localDescription;
        if (!local) throw new Error('No local SDP after negotiation.');
        const offerResp = await fetch(joinBase(webrtcBase, '/stream/offer'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stream_id,
            sdp: { type: 'offer', sdp: local.sdp },
          }),
        });
        if (!offerResp.ok)
          throw new Error(`stream/offer failed: HTTP ${offerResp.status}`);
        const answer = (await offerResp.json()) as OfferAnswer;
        if (cancelled) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      } catch (err) {
        if (cancelled) return;
        setPhase('failed');
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void negotiate();

    return () => {
      cancelled = true;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
      pcRef.current = null;
      setStream(null);
      setStats(EMPTY_STATS);
    };
    // Re-negotiate when the target stream changes, ICE config changes, the
    // resolution cap changes, or `retry()` bumps `attempt`. `stableIceServers`
    // is content-stable.
  }, [webrtcBase, topic, attempt, stableIceServers, maxWidth, maxHeight]);

  // While connected, poll receive-side stats (fps / latency / resolution) and
  // auto-renegotiate if the decoder stalls (the "black after tab switch" case).
  useEffect(() => {
    if (phase !== 'connected') {
      setStats(EMPTY_STATS);
      return;
    }
    let active = true;
    let lastDecoded = -1;
    let stallSince: number | null = null;

    const id = setInterval(() => {
      const pc = pcRef.current;
      if (!pc || !active || typeof pc.getStats !== 'function') return;
      void pc.getStats().then((reports) => {
        if (!active) return;
        let fps: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let framesDecoded: number | null = null;
        let jbDelay = 0;
        let jbCount = 0;
        let rtt = 0;
        reports.forEach((r: Record<string, unknown>) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond;
            if (typeof r.frameWidth === 'number') width = r.frameWidth;
            if (typeof r.frameHeight === 'number') height = r.frameHeight;
            if (typeof r.framesDecoded === 'number') framesDecoded = r.framesDecoded;
            if (typeof r.jitterBufferDelay === 'number') jbDelay = r.jitterBufferDelay;
            if (typeof r.jitterBufferEmittedCount === 'number')
              jbCount = r.jitterBufferEmittedCount;
          } else if (
            r.type === 'candidate-pair' &&
            (r.nominated === true || r.selected === true) &&
            typeof r.currentRoundTripTime === 'number'
          ) {
            rtt = r.currentRoundTripTime;
          }
        });
        const latencyMs =
          jbCount > 0
            ? Math.round((jbDelay / jbCount) * 1000 + (rtt * 1000) / 2)
            : rtt
              ? Math.round((rtt * 1000) / 2)
              : null;
        setStats({
          fps: fps != null ? Math.round(fps) : null,
          latencyMs,
          width,
          height,
        });

        // Stall detection: no new decoded frames → black; auto-renegotiate.
        const now = Date.now();
        if (framesDecoded != null && framesDecoded === lastDecoded) {
          if (stallSince == null) stallSince = now;
          else if (now - stallSince >= STALL_MS && autoRetriesRef.current < AUTO_RETRY_MAX) {
            autoRetriesRef.current += 1;
            stallSince = null;
            setError(null);
            setAttempt((n) => n + 1); // auto-retry: keep the budget (don't reset)
          }
        } else {
          stallSince = null;
          if (framesDecoded != null && framesDecoded > 0) autoRetriesRef.current = 0;
        }
        if (framesDecoded != null) lastDecoded = framesDecoded;
      });
    }, 1000);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [phase, attempt]);

  return { phase, stream, error, stats, retry };
}
