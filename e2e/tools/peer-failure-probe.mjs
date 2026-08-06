#!/usr/bin/env node
// E-37: drive the `'peer'` stream-failure classification for real.
//
// WHAT `'peer'` MEANS AND WHY IT IS HARD TO REACH. Cameras.tsx classifies a
// dead preview three ways, because they send the operator to three different
// places: `signaling` (the streamer did not answer), `peer` (the media path is
// broken though signaling worked), and `unsupported` (this browser has no
// WebRTC). `peer` needs the awkward middle state — HTTP fine, media path dead —
// so simply stopping the streamer produces `signaling`, not `peer`.
//
// WHAT THIS INJECTS, EXACTLY. `RTCPeerConnection.prototype.setRemoteDescription`
// is wrapped so that the ANSWER SDP's `a=candidate:` lines have their PORT
// rewritten to a port nothing is listening on. Nothing else is touched: not the
// ice-ufrag, not the ice-pwd, not the DTLS fingerprint, not the m= lines, not
// the `c=` address. Everything else in the path is real —
//
//   * `/stream/start` and `/stream/offer` are answered by the REAL streamer
//     with real 200s (signaling is untouched, which is what makes this a `peer`
//     test rather than a `signaling` test wearing a hat),
//   * the ICE failure is produced by the BROWSER'S OWN ICE agent timing out
//     against an unreachable candidate — not by a stubbed state,
//   * `connectionstatechange`, the hook's handler, the aggregation in
//     Cameras.tsx and the row copy in warnings.ts all run for real.
//
// This is the condition this repository actually hit in the field: signaling
// over Tailscale worked while the media path did not (the MTU / IPv6 blackhole
// that `drop_ipv6_candidates` exists for).
//
// NO AUTO-RETRY RACE. The stall-detector retry only runs while `phase ===
// 'connected'`, and a broken candidate never gets there, so it cannot interfere.
//
// Usage (stack must be up WITH the streamer, which the acceptance gate omits):
//   E2E_WITH_STREAMER=1 bash e2e/scripts/stack.sh up
//   node e2e/tools/peer-failure-probe.mjs
//   node e2e/tools/peer-failure-probe.mjs --control   # no injection, for contrast

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : (args[i + 1] ?? true);
};

const BASE = flag('base', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18080');
const SHOTS = flag('shots', 'dev_image');
const CONTROL = has('control');
const DEADLINE_MS = Number(flag('deadline', 75000));

/**
 * Rewrite only the candidate PORT — in BOTH directions.
 *
 * Patching the answer alone is NOT enough, and measuring that was the first
 * result of this probe: with only the answer rewritten, both streams still
 * reached "2 cameras OK". ICE is bidirectional. The offer still carried the
 * browser's real candidates, so aiortc connected INBOUND, and the browser
 * learned a peer-reflexive candidate from the incoming STUN binding request and
 * used that instead of the address we had broken. Killing the media path means
 * breaking the addresses each side would use to reach the other:
 *
 *   inbound  — the answer's candidates, via setRemoteDescription
 *   outbound — the offer's candidates, in the POST /stream/offer body (the app
 *              waits for gathering to finish and posts pc.localDescription)
 *
 * Still only ports. No ufrag, no pwd, no fingerprint, no m=/c= lines.
 */
const INJECT = () => {
  const DEAD_PORT = 9;
  const patchSdp = (sdp) =>
    sdp
      .split('\r\n')
      .map((line) => {
        if (!line.startsWith('a=candidate:')) return line;
        const f = line.split(' ');
        if (f.length > 5) f[5] = String(DEAD_PORT);
        return f.join(' ');
      })
      .join('\r\n');

  // Outbound: the offer this page posts to the streamer.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.includes('/stream/offer') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        if (body?.sdp?.sdp) {
          body.sdp.sdp = patchSdp(body.sdp.sdp);
          window.__peerProbe = window.__peerProbe ?? { patched: 0, offersPatched: 0, samples: [] };
          window.__peerProbe.offersPatched += 1;
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch {
      /* leave the request untouched rather than break signaling */
    }
    return origFetch.call(this, input, init);
  };

  // Record what the browser's ICE agent actually did, so a surprising result is
  // diagnosable instead of guessed at.
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new OrigPC(...a);
    window.__peerProbe = window.__peerProbe ?? { patched: 0, offersPatched: 0, samples: [], pcs: [] };
    const rec = { states: [], ice: [], selected: null };
    window.__peerProbe.pcs.push(rec);
    pc.addEventListener('connectionstatechange', () => rec.states.push(pc.connectionState));
    pc.addEventListener('iceconnectionstatechange', () => rec.ice.push(pc.iceConnectionState));
    window.__dumpStats = async () => {
      for (const r of window.__peerProbe.pcs) r.selected = r.selected ?? null;
    };
    pc.__probeStats = async () => {
      const st = await pc.getStats();
      for (const [, v] of st) {
        if (v.type === 'candidate-pair' && v.state === 'succeeded') {
          const rem = st.get(v.remoteCandidateId);
          rec.selected = rem ? `${rem.address}:${rem.port} (${rem.candidateType})` : 'succeeded';
        }
      }
    };
    rec.pc = pc;
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  const orig = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (desc) {
    try {
      const sdp = typeof desc?.sdp === 'string' ? desc.sdp : null;
      if (sdp) {
        const patched = patchSdp(sdp);
        window.__peerProbe = window.__peerProbe ?? { patched: 0, offersPatched: 0, samples: [] };
        window.__peerProbe.patched += 1;
        if (window.__peerProbe.samples.length < 2) {
          window.__peerProbe.samples.push({
            before: (sdp.match(/^a=candidate:.*$/m) ?? [''])[0],
            after: (patched.match(/^a=candidate:.*$/m) ?? [''])[0],
          });
        }
        desc = { type: desc.type, sdp: patched };
      }
    } catch {
      /* never break the page: an unpatched run just measures nothing */
    }
    return orig.call(this, desc);
  };
};

async function run() {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const signaling = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/stream/')) signaling.push(`${r.status()} ${u.replace(BASE, '')}`);
  });

  if (!CONTROL) await page.addInitScript(INJECT);
  await page.goto(`${BASE}/?tab=collect`, { waitUntil: 'networkidle' });

  // The Cameras row of the System card is the aggregate under test.
  const row = page.locator('[data-testid="sys-cameras"]');
  const started = Date.now();
  let text = '';
  while (Date.now() - started < DEADLINE_MS) {
    text = (await row.textContent().catch(() => '')) ?? '';
    if (/no video|dropped|failed/i.test(text)) break;
    await page.waitForTimeout(1000);
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  const probe = await page.evaluate(async () => {
    const p = window.__peerProbe ?? null;
    if (p?.pcs) for (const r of p.pcs) { try { await r.pc.__probeStats(); } catch { /* ignore */ } }
    return p ? { ...p, pcs: p.pcs.map((r) => ({ states: r.states, ice: r.ice, selected: r.selected })) } : null;
  });

  if (SHOTS) {
    mkdirSync(resolve(SHOTS), { recursive: true });
    await page.screenshot({
      path: resolve(SHOTS, CONTROL ? 'e37-control.png' : 'e37-peer.png'),
      fullPage: false,
    });
  }

  console.log(`mode:            ${CONTROL ? 'CONTROL (no injection)' : 'INJECTED (candidate port -> 9)'}`);
  console.log(`signaling calls: ${signaling.length ? signaling.join(', ') : '(none seen)'}`);
  console.log(`answers patched: ${probe ? probe.patched : 0}`);
  console.log(`offers patched:  ${probe ? (probe.offersPatched ?? 0) : 0}`);
  if (probe?.samples?.length) {
    for (const s of probe.samples) {
      console.log(`  before: ${s.before}`);
      console.log(`  after:  ${s.after}`);
    }
  }
  console.log(`elapsed:         ${elapsed}s`);
  for (const [i, r] of (probe?.pcs ?? []).entries()) {
    console.log(`pc[${i}] conn:     ${r.states.join(' -> ') || '(none)'}`);
    console.log(`pc[${i}] ice:      ${r.ice.join(' -> ') || '(none)'}`);
    console.log(`pc[${i}] selected: ${r.selected ?? '(no succeeded pair)'}`);
  }
  console.log(`cameras row:     ${text.trim() || '(empty)'}`);

  await browser.close();

  if (CONTROL) return 0;

  // WHAT COUNTS AS A PASS HERE, and why it is not `'peer'`.
  //
  // The first run of this probe found that breaking the media path does NOT
  // reach the `peer` classification: the peer connection never reports
  // `failed` (ICE just never completes), so the typed reason is never assigned.
  // Measured — both panes at 0x0 readyState 0 while the row said
  // "2 cameras OK", unchanged from t=15s to t=150s.
  //
  // That was fixed by a predicate that reports the ABSENCE OF VIDEO rather than
  // waiting for a failure report, so the honest expectation for this probe is
  // the still-connecting copy. Accepting the `peer` wording too, because a
  // stack whose ICE does give up would legitimately produce it.
  const stillConnecting = /no video[^]*still connecting/i.test(text);
  const peerCopy = /the network connection dropped/i.test(text);
  if (stillConnecting) {
    console.log(
      '\nRESULT: PASS — the row reports the absent video without inventing a cause.',
    );
    return 0;
  }
  if (peerCopy) {
    console.log("\nRESULT: PASS — ICE gave up and the row carries the 'peer' cause.");
    return 0;
  }
  console.log(
    '\nRESULT: FAIL — both previews are dead and the row does not say so.\n' +
      '        This is the E-37 hole: an OK derived from the absence of a\n' +
      '        failure report rather than the presence of video.',
  );
  return 1;
}

run()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
