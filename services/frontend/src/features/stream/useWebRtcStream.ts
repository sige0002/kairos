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
}

export interface UseWebRtcStreamResult {
  phase: StreamPhase;
  stream: MediaStream | null;
  error: string | null;
  /** Tear down and re-negotiate. */
  retry: () => void;
}

export function useWebRtcStream({
  webrtcBase,
  topic,
  iceServers = [],
}: UseWebRtcStreamArgs): UseWebRtcStreamResult {
  const [phase, setPhase] = useState<StreamPhase>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // Stabilize iceServers so an inline-array prop doesn't re-trigger negotiation
  // every render. Identity follows content, not reference.
  const iceServersKey = JSON.stringify(iceServers);
  const stableIceServers = useMemo<RTCIceServer[]>(
    () => JSON.parse(iceServersKey) as RTCIceServer[],
    [iceServersKey],
  );

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

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
        const startResp = await fetch(joinBase(webrtcBase, '/stream/start'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic }),
        });
        if (!startResp.ok)
          throw new Error(`stream/start failed: HTTP ${startResp.status}`);
        const { stream_id } = (await startResp.json()) as StreamStartResponse;
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
    };
    // Re-negotiate when the target stream changes, ICE config changes, or
    // `retry()` bumps `attempt`. `stableIceServers` is content-stable.
  }, [webrtcBase, topic, attempt, stableIceServers]);

  return { phase, stream, error, retry };
}
